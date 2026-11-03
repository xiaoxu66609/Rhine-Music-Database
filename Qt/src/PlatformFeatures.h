#pragma once
#include <QtGlobal>

// 平台特性宏
namespace PlatformFeatures {
#if defined(Q_OS_IOS)
inline constexpr bool OfficialPlayback = false;
inline constexpr bool LocalMusic = false;
inline constexpr bool ApplicationVolume = false;
inline constexpr bool DesktopWindowControls = false;
#elif defined(Q_OS_ANDROID)
inline constexpr bool OfficialPlayback = false;
inline constexpr bool LocalMusic = true;
inline constexpr bool ApplicationVolume = true;
inline constexpr bool DesktopWindowControls = false;
#else
inline constexpr bool OfficialPlayback = true;
inline constexpr bool LocalMusic = true;
inline constexpr bool ApplicationVolume = true;
inline constexpr bool DesktopWindowControls = true;
#endif
}
