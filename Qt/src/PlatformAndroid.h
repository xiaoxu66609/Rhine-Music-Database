#pragma once
#include <QString>

class Engine;
class QWindow;

/** 把 APK assets 里的桥接资源解到应用私有目录。Node 只能读真实文件。失败返回空字符串。 */
QString prepareAndroidResources();
/** 无前台媒体服务：离开前台时暂停面板内播放并释放可见性，避免后台被系统杀掉。 */
void configureAndroidWindow(QWindow *window, Engine *backend);
