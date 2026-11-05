#pragma once

class Engine;
class QWindow;

/** 无前台媒体服务：离开前台时暂停面板内播放并释放可见性，避免后台被系统杀掉。 */
void configureAndroidWindow(QWindow *window, Engine *backend);
