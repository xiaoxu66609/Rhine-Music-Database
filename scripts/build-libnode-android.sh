#!/usr/bin/env bash
# 用 nodejs-mobile 源码为 arm64 重编 libnode.so，链接时启用 16 KB 页对齐（targetSdk 36 / 16 KB 设备）。
set -euo pipefail

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

elf_meets_16kb_load_alignment() {
    local elf="$1"
    local readelf
    readelf="$(find_readelf)" || return 1
    while read -r align; do
        if [[ "${align}" =~ ^0x[0-9a-fA-F]+$ ]]; then
            value=$((align))
            if (( value < 16384 )); then
                return 1
            fi
        fi
    done < <("${readelf}" -lW "${elf}" | awk '/^  LOAD/ {print $NF}')
    return 0
}

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

if elf_meets_16kb_load_alignment "${OUTPUT}"; then
    echo "Built 16 KB-aligned libnode.so: ${OUTPUT}"
elif ! find_readelf >/dev/null 2>&1; then
    echo "readelf missing; skipped ELF alignment verification" >&2
    exit 0
else
    echo "Built libnode.so is not 16 KB aligned" >&2
    exit 1
fi
