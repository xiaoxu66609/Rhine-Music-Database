#!/usr/bin/env bash
# 用 nodejs-mobile 源码为 arm64 重编 libnode.so，链接时启用 16 KB 页对齐（targetSdk 36 / 16 KB 设备）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAITS_HEADER="${SCRIPT_DIR}/libnode-char-traits-uint16.h"

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

ndk_target_clangxx() {
    local host candidate
    for host in "${NDK}/toolchains/llvm/prebuilt"/*; do
        candidate="${host}/bin/aarch64-linux-android${SDK_API}-clang++"
        if [[ -x "${candidate}" ]]; then
            echo "${candidate}"
            return 0
        fi
    done
    return 1
}

# 0: 当前 NDK 没有 char_traits<unsigned short>，需要注入。
# 1: 已经有该特化（例如 NDK r27）。
# 2: 探测编译本身失败，不能判断。
ndk_missing_uint16_char_traits() {
    local clang src log
    clang="$(ndk_target_clangxx)" || return 2
    src="$(mktemp)"
    cat > "${src}" <<'EOF'
#include <string>
int main() {
    return std::char_traits<unsigned short>::eq(
               static_cast<unsigned short>(1), static_cast<unsigned short>(1))
               ? 0
               : 1;
}
EOF
    if "${clang}" -std=c++17 -x c++ -c "${src}" -o "${src}.o" >"${src}.log" 2>&1; then
        rm -f "${src}" "${src}.o" "${src}.log"
        return 1
    fi
    log="$(cat "${src}.log")"
    rm -f "${src}" "${src}.o" "${src}.log"
    if [[ "${log}" == *char_traits* ]]; then
        return 0
    fi
    printf '%s\n' "${log}" >&2
    return 2
}

inject_traits_include() {
    local file="$1"
    local tmp
    if [[ ! -f "${file}" ]]; then
        echo "missing header to patch: ${file}" >&2
        return 1
    fi
    if grep -q 'rhine-char-traits-uint16.h' "${file}"; then
        return 0
    fi
    if ! grep -qx '#include <string>' "${file}"; then
        echo "no #include <string> in ${file}" >&2
        return 1
    fi
    tmp="$(mktemp)"
    awk '
        !inserted && $0 == "#include <string>" {
            print
            print "#include \"rhine-char-traits-uint16.h\""
            inserted = 1
            next
        }
        { print }
    ' "${file}" > "${tmp}"
    mv "${tmp}" "${file}"
}

# NDK r28 起的 libc++ 删除了 char_traits<unsigned short>。V8 inspector 的
# String16 用 uint16_t（在 Android 上就是 unsigned short），所以 r30 编到
# custom-preview.cc 会停在 string-16.h。只在探测确认缺失时打补丁。
prepare_uint16_char_traits() {
    local probe dest
    LIBNODE_CXXFLAGS_EXTRA=""
    set +e
    ndk_missing_uint16_char_traits
    probe=$?
    set -e
    case "${probe}" in
        1)
            echo "NDK libc++ already provides std::char_traits<unsigned short>"
            return 0
            ;;
        0)
            ;;
        *)
            echo "Could not probe std::char_traits<unsigned short> with the NDK compiler" >&2
            return 1
            ;;
    esac
    if [[ ! -f "${TRAITS_HEADER}" ]]; then
        echo "missing ${TRAITS_HEADER}" >&2
        return 1
    fi
    dest="${SRC}/deps/v8/src/inspector/rhine-char-traits-uint16.h"
    cp "${TRAITS_HEADER}" "${dest}"
    inject_traits_include "${SRC}/deps/v8/src/inspector/string-16.h"
    inject_traits_include "${SRC}/deps/v8/src/inspector/v8-string-conversions.h"
    LIBNODE_CXXFLAGS_EXTRA="-include ${dest}"
    echo "NDK libc++ lacks std::char_traits<unsigned short>; injecting ${dest}"
}

self_test_char_traits() {
    local tmp clang saved_ndk saved_api
    tmp="$(mktemp -d)"
    saved_ndk="${NDK:-}"
    saved_api="${SDK_API:-}"
    mkdir -p "${tmp}/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"
    clang="${tmp}/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang++"
    cat > "${clang}" <<'EOF'
#!/bin/sh
case "${FAKE_CLANG_MODE}" in
    missing)
        echo "error: implicit instantiation of undefined template 'std::char_traits<unsigned short>'" >&2
        exit 1
        ;;
    broken)
        echo "error: android toolchain failed" >&2
        exit 1
        ;;
    *)
        exit 0
        ;;
esac
EOF
    chmod +x "${clang}"
    NDK="${tmp}/ndk"
    SDK_API=24
    export FAKE_CLANG_MODE=missing
    if ! ndk_missing_uint16_char_traits; then
        echo "missing char_traits was treated as present" >&2
        return 1
    fi
    FAKE_CLANG_MODE=present
    if ndk_missing_uint16_char_traits; then
        echo "existing char_traits was treated as missing" >&2
        return 1
    fi
    FAKE_CLANG_MODE=broken
    set +e
    ndk_missing_uint16_char_traits 2>/dev/null
    local probe=$?
    set -e
    if [[ "${probe}" -ne 2 ]]; then
        echo "unrelated compiler failure returned ${probe}" >&2
        return 1
    fi

    mkdir -p "${tmp}/src/deps/v8/src/inspector"
    printf '#include <cstdint>\n#include <string>\n' > "${tmp}/src/deps/v8/src/inspector/string-16.h"
    printf '#include <string>\n#include <cstdint>\n' > "${tmp}/src/deps/v8/src/inspector/v8-string-conversions.h"
    SRC="${tmp}/src"
    LIBNODE_CXXFLAGS_EXTRA=""
    FAKE_CLANG_MODE=missing
    prepare_uint16_char_traits
    if [[ "${LIBNODE_CXXFLAGS_EXTRA}" != "-include ${tmp}/src/deps/v8/src/inspector/rhine-char-traits-uint16.h" ]]; then
        echo "traits include flag was not recorded: ${LIBNODE_CXXFLAGS_EXTRA}" >&2
        return 1
    fi
    if [[ "$(grep -c 'rhine-char-traits-uint16.h' "${tmp}/src/deps/v8/src/inspector/string-16.h")" -ne 1 ]]; then
        echo "string-16.h was not patched once" >&2
        return 1
    fi
    prepare_uint16_char_traits
    if [[ "$(grep -c 'rhine-char-traits-uint16.h' "${tmp}/src/deps/v8/src/inspector/v8-string-conversions.h")" -ne 1 ]]; then
        echo "second prepare duplicated the include" >&2
        return 1
    fi
    FAKE_CLANG_MODE=present
    LIBNODE_CXXFLAGS_EXTRA="stale"
    prepare_uint16_char_traits
    if [[ -n "${LIBNODE_CXXFLAGS_EXTRA}" ]]; then
        echo "present traits still requested an include" >&2
        return 1
    fi

    if command -v g++ >/dev/null 2>&1; then
        g++ -std=c++17 -Wall -Wextra -Werror -I "${SCRIPT_DIR}" -o "${tmp}/traits17" -x c++ - <<'EOF'
#include "libnode-char-traits-uint16.h"
int main() {
    unsigned short unit[] = {1, 2, 0};
    std::basic_string<unsigned short> value;
    value.append(unit);
    value += value;
    return value.substr(1, 2).size() == 2 && value.find(unit) == 0 ? 0 : 1;
}
EOF
        "${tmp}/traits17"
        g++ -std=c++20 -Wall -Wextra -Werror -I "${SCRIPT_DIR}" -o "${tmp}/traits20" -x c++ - <<'EOF'
#include <string>
#include "libnode-char-traits-uint16.h"
int main() {
    std::basic_string<unsigned short> value(3, 7);
    value += value;
    return value.size() == 6 ? 0 : 1;
}
EOF
        "${tmp}/traits20"
    fi

    if [[ -n "${saved_ndk}" ]]; then
        NDK="${saved_ndk}"
    else
        unset NDK
    fi
    if [[ -n "${saved_api}" ]]; then
        SDK_API="${saved_api}"
    else
        unset SDK_API
    fi
    unset FAKE_CLANG_MODE
    rm -rf "${tmp}"
    echo "libnode char_traits self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
    self_test_alignment
    self_test_char_traits
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

# 必须在 checkout 之后。r30 的 libc++ 没有 char_traits<unsigned short>，
# V8 String16 的 basic_string<uint16_t> 会在 custom-preview.cc 编译失败。
prepare_uint16_char_traits

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
    if [[ -n "${LIBNODE_CXXFLAGS_EXTRA:-}" ]]; then
        # gyp 把命令行 CXXFLAGS 接到目标 C++ 编译上，宿主工具走 CXXFLAGS.host。
        make -j"${JOBS}" "CXXFLAGS=${CXXFLAGS:-}${CXXFLAGS:+ }${LIBNODE_CXXFLAGS_EXTRA}"
    else
        make -j"${JOBS}"
    fi
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
