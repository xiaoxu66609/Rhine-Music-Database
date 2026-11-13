// NDK r28+ libc++ 只保留 char / wchar_t / char8_t / char16_t / char32_t 的
// char_traits。nodejs-mobile v18.20.4 的 V8 inspector String16 仍用 uint16_t，
// 在 Android 上就是 unsigned short，于是 basic_string 在实例化时找不到 traits。
// 由 scripts/build-libnode-android.sh 在确认当前 NDK 缺少该特化后，用 -include
// 注入到目标编译。NDK r27 仍自带该特化，不能再定义一次。
#ifndef RHINE_CHAR_TRAITS_UINT16_H_
#define RHINE_CHAR_TRAITS_UINT16_H_

#include <cstddef>
#include <cstdint>
#include <cwchar>
#include <iosfwd>
#include <string>

namespace std {

template <>
struct char_traits<unsigned short> {
    using char_type = unsigned short;
    using int_type = uint_least32_t;
    using off_type = streamoff;
    using pos_type = streampos;
    using state_type = mbstate_t;

    static constexpr void assign(char_type& dest, const char_type& source) noexcept { dest = source; }

    static constexpr bool eq(char_type left, char_type right) noexcept { return left == right; }

    static constexpr bool lt(char_type left, char_type right) noexcept { return left < right; }

    static constexpr int compare(const char_type* left, const char_type* right, size_t count) noexcept {
        for (size_t i = 0; i < count; ++i) {
            if (lt(left[i], right[i])) {
                return -1;
            }
            if (lt(right[i], left[i])) {
                return 1;
            }
        }
        return 0;
    }

    static constexpr size_t length(const char_type* text) noexcept {
        size_t count = 0;
        while (!eq(text[count], char_type(0))) {
            ++count;
        }
        return count;
    }

    static constexpr const char_type* find(const char_type* text, size_t count, const char_type& value) noexcept {
        for (size_t i = 0; i < count; ++i) {
            if (eq(text[i], value)) {
                return text + i;
            }
        }
        return nullptr;
    }

    static constexpr char_type* move(char_type* dest, const char_type* source, size_t count) noexcept {
        if (dest == source || count == 0) {
            return dest;
        }
        if (dest < source) {
            for (size_t i = 0; i < count; ++i) {
                dest[i] = source[i];
            }
        } else {
            for (size_t i = count; i > 0; --i) {
                dest[i - 1] = source[i - 1];
            }
        }
        return dest;
    }

    static constexpr char_type* copy(char_type* dest, const char_type* source, size_t count) noexcept {
        for (size_t i = 0; i < count; ++i) {
            dest[i] = source[i];
        }
        return dest;
    }

    static constexpr char_type* assign(char_type* dest, size_t count, char_type value) noexcept {
        for (size_t i = 0; i < count; ++i) {
            dest[i] = value;
        }
        return dest;
    }

    static constexpr int_type not_eof(int_type value) noexcept { return eq_int_type(value, eof()) ? 0 : value; }

    static constexpr char_type to_char_type(int_type value) noexcept { return char_type(value); }

    static constexpr int_type to_int_type(char_type value) noexcept { return value; }

    static constexpr bool eq_int_type(int_type left, int_type right) noexcept { return left == right; }

    static constexpr int_type eof() noexcept { return int_type(0xFFFFFFFF); }
};

}  // namespace std

#endif  // RHINE_CHAR_TRAITS_UINT16_H_
