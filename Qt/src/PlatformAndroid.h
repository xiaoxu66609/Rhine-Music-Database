#pragma once
#include <QString>

/** 把 APK assets 里的桥接资源解到应用私有目录。Node 只能读真实文件。失败返回空字符串。 */
QString prepareAndroidResources();
