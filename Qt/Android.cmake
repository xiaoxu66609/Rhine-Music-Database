# Android 发布包。桌面 Node 子进程在这里不存在，协议层走 libnode.so。
# 目标在 Qt/ 子目录创建，根目录里再结束初始化。Qt 6.12 的 APK 依赖扫描会向已经结束的
# 子目录投递 DEFER，因此这里关掉自动扫描，改由 QT_ANDROID_EXTRA_LIBS 显式带上 libnode.so。
set(QT_NO_COLLECT_IMPORTED_TARGET_APK_DEPS
    ON
    CACHE BOOL "Collect Android imported libraries explicitly" FORCE)
qt_policy(SET QTP0002 NEW)
set(RHINE_NODE_MOBILE_ROOT
    ""
    CACHE PATH "Extracted nodejs-mobile Android release")
set(RHINE_ANDROID_PACKAGE_SOURCE
    ""
    CACHE PATH "Android package source with manifest, icon and assets")
set(RHINE_ANDROID_VERSION_CODE
    "1"
    CACHE STRING "Positive Android versionCode")
if(NOT RHINE_ANDROID_VERSION_CODE MATCHES "^[1-9][0-9]*$")
    message(FATAL_ERROR "RHINE_ANDROID_VERSION_CODE must be a positive integer")
endif()
set(nodeLibrary "${RHINE_NODE_MOBILE_ROOT}/bin/${ANDROID_ABI}/libnode.so")
if(NOT EXISTS "${nodeLibrary}")
    message(FATAL_ERROR "libnode.so not found: ${nodeLibrary}; run npm run build:android")
endif()
if(NOT EXISTS "${RHINE_ANDROID_PACKAGE_SOURCE}/AndroidManifest.xml")
    message(FATAL_ERROR "AndroidManifest.xml missing: ${RHINE_ANDROID_PACKAGE_SOURCE}")
endif()
if(NOT EXISTS "${RHINE_ANDROID_PACKAGE_SOURCE}/assets/RhineAssets/slots.json")
    message(FATAL_ERROR "Android resources missing; run npm run build:android")
endif()
add_library(RhineNodeMobile SHARED IMPORTED)
set_target_properties(RhineNodeMobile PROPERTIES IMPORTED_LOCATION "${nodeLibrary}")
find_library(RHINE_ANDROID_LOG log REQUIRED)
target_link_libraries(RhineCore PUBLIC RhineNodeMobile ${RHINE_ANDROID_LOG})
set_property(TARGET RhineMusicDatabase APPEND PROPERTY QT_ANDROID_EXTRA_LIBS "${nodeLibrary}")
set_target_properties(
    RhineMusicDatabase
    PROPERTIES QT_ANDROID_PACKAGE_SOURCE_DIR "${RHINE_ANDROID_PACKAGE_SOURCE}"
               QT_ANDROID_PACKAGE_NAME "${RHINE_APPLICATION_ID}"
               QT_ANDROID_APP_NAME "RHINE MUSIC DATABASE"
               QT_ANDROID_MIN_SDK_VERSION 28
               QT_ANDROID_TARGET_SDK_VERSION 36
               QT_ANDROID_VERSION_NAME "${PROJECT_VERSION}"
               QT_ANDROID_VERSION_CODE "${RHINE_ANDROID_VERSION_CODE}")
