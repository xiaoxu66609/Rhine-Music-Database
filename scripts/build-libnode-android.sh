#!/usr/bin/env bash
# 用 nodejs-mobile 源码为 arm64 重编 libnode.so，链接时启用 16 KB 页对齐（targetSdk 36 / 16 KB 设备）。
set -euo pipefail

find_readelf() {
    if [[ -n "${ANDROID_NDK_ROOT:-}" && -d "${ANDROID_NDK_ROOT}/toolchains/llvm/prebuilt" ]]; then
        local host candidate
        for host in "${ANDROID_NDK_ROOT}/toolchains/llvm/prebuilt"/*; do
            candidate="${host}/bin/llvm-readelf"
            if [[ -x "${candidate}" ]]; then
                echo "${candidate}"
                return 0
            fi
        done
    fi
    if command -v llvm-readelf >/dev/null 2>&1; then
        command -v llvm-readelf
        return 0
    fi
    if command -v readelf >/dev/null 2>&1; then
        command -v readelf
        return 0
    fi
    return 1
}

# 没有解析到任何 LOAD p_align 时必须失败。空输出、readelf 失败或截断文件
# 以前会被当成已对齐，缓存复用就会跳过 16 KB 重编。
elf_meets_16kb_load_alignment() {
    local elf="$1"
    local readelf align value
    local saw=0
    readelf="$(find_readelf)" || return 1
    while read -r align; do
        if [[ "${align}" =~ ^0x[0-9a-fA-F]+$ ]]; then
            saw=1
            value=$((align))
            if (( value < 16384 )); then
                return 1
            fi
        fi
    done < <("${readelf}" -lW "${elf}" | awk '/^  LOAD/ {print $NF}')
    (( saw == 1 ))
}

self_test_alignment() {
    local tmp saved_path
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN
    cat > "${tmp}/readelf" <<'EOF'
#!/bin/sh
case "${ELF_FIXTURE}" in
  aligned)
    printf '  LOAD 0x0 0x0 0x0 0x1 0x1 R 0x10000\n  LOAD 0x1000 0x1000 0x1000 0x1 0x1 RW 0x10000\n'
    ;;
  mixed)
    printf '  LOAD 0x0 0x0 0x0 0x1 0x1 R 0x10000\n  LOAD 0x1000 0x1000 0x1000 0x1 0x1 RW 0x1000\n'
    ;;
  *)
    printf 'not an elf\n'
    ;;
esac
EOF
    chmod +x "${tmp}/readelf"
    cp "${tmp}/readelf" "${tmp}/llvm-readelf"
    saved_path="${PATH}"
    # 假 readelf 必须排在系统 llvm-readelf 前面，同时保留 awk 所在的原 PATH。
    PATH="${tmp}:${saved_path}"
    unset ANDROID_NDK_ROOT ANDROID_SDK_ROOT ANDROID_HOME
    : > "${tmp}/libnode.so"
    export ELF_FIXTURE=aligned
    if ! elf_meets_16kb_load_alignment "${tmp}/libnode.so"; then
        echo "aligned library was rejected" >&2
        PATH="${saved_path}"
        return 1
    fi
    ELF_FIXTURE=mixed
    export ELF_FIXTURE
    if elf_meets_16kb_load_alignment "${tmp}/libnode.so"; then
        echo "mixed 64 KB and 4 KB LOAD segments were accepted" >&2
        PATH="${saved_path}"
        return 1
    fi
    ELF_FIXTURE=garbage
    export ELF_FIXTURE
    if elf_meets_16kb_load_alignment "${tmp}/libnode.so"; then
        echo "unparsed ELF was treated as 16 KB aligned" >&2
        PATH="${saved_path}"
        return 1
    fi
    PATH="${saved_path}"
    echo "libnode alignment self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
    self_test_alignment
    exit 0
fi

if [[ $# -lt 2 ]]; then
    echo "Usage: build-libnode-android.sh <android_ndk_root> <output_libnode.so>" >&2
    exit 1
fi

NDK="$(cd "$1" && pwd)"
OUTPUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
TAG="v18.20.4"
SRC="${RHINE_NODE_MOBILE_SRC:-output/dependencies/node-mobile-android/nodejs-mobile-src}"
JOBS="${RHINE_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"
SDK_API="${RHINE_NODE_MOBILE_SDK:-24}"

mkdir -p "$(dirname "$OUTPUT")"

if [[ ! -f "${NDK}/build/cmake/android.toolchain.cmake" ]]; then
    echo "Invalid Android NDK: ${NDK}" >&2
    exit 1
fi

if [[ -f "${OUTPUT}" ]] && elf_meets_16kb_load_alignment "${OUTPUT}"; then
    echo "Reusing cached 16 KB-aligned libnode.so: ${OUTPUT}"
    exit 0
fi

if [[ ! -d "${SRC}/.git" ]]; then
    git clone --depth 1 --branch "${TAG}" https://github.com/nodejs-mobile/nodejs-mobile.git "${SRC}"
fi

(
    cd "${SRC}"
    git fetch --depth 1 origin "refs/tags/${TAG}:refs/tags/${TAG}" 2>/dev/null || true
    git checkout -f "${TAG}"
)

export LDFLAGS="-Wl,-z,max-page-size=16384"

# android-configure 会改用 python3.11。它接着调用的 ./configure 却先找 python3.12，
# 找到 GitHub 上的 3.12.16 后因没有 distutils 退出（ModuleNotFoundError: distutils）。
# 把 3.11 放到 PATH 最前，并让 python3.12 及以上的名字也指向它。
python_for_node=""
for candidate in python3.11 python3.10 python3.9 python3.8; do
    if command -v "${candidate}" >/dev/null 2>&1; then
        python_for_node="$(command -v "${candidate}")"
        break
    fi
done
if [[ -z "${python_for_node}" ]]; then
    echo "nodejs-mobile android-configure needs Python 3.8-3.11; python3 is: $(python3 --version 2>&1 || echo missing)" >&2
    exit 1
fi
python_shim="$(mktemp -d)"
for name in python python3 python3.8 python3.9 python3.10 python3.11 python3.12 python3.13 python3.14 python3.15; do
    ln -s "${python_for_node}" "${python_shim}/${name}"
done
export PATH="${python_shim}:${PATH}"

(
    cd "${SRC}"
    make clean >/dev/null 2>&1 || true
    rm -rf android-toolchain/
    ./android-configure "${NDK}" "${SDK_API}" arm64
    make -j"${JOBS}"
)

BUILT=""
for candidate in "${SRC}/out/Release/lib.target/libnode.so" "${SRC}/out/Release/obj.target/libnode.so"; do
    if [[ -f "${candidate}" ]]; then
        BUILT="${candidate}"
        break
    fi
done

if [[ -z "${BUILT}" ]]; then
    echo "libnode.so not found after nodejs-mobile build" >&2
    exit 1
fi

cp "${BUILT}" "${OUTPUT}"

if ! elf_meets_16kb_load_alignment "${OUTPUT}"; then
    echo "Built libnode.so is not 16 KB aligned or its LOAD headers could not be verified" >&2
    exit 1
fi
echo "Built 16 KB-aligned libnode.so: ${OUTPUT}"
