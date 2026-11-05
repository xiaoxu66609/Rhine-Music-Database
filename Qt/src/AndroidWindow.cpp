#include "AndroidWindow.h"
#include "Engine.h"
#include <QGuiApplication>
#include <QQuickWindow>

void configureAndroidWindow(QWindow *window, Engine *backend) {
    QObject::connect(qGuiApp, &QGuiApplication::applicationStateChanged, backend,
                     [backend, window](Qt::ApplicationState state) {
                         const bool active = state == Qt::ApplicationActive;
                         backend->setVisible(active);
                         if (!active) {
                             backend->pausePanelPlayback();
                             backend->trimMemory();
                             if (auto *quick = qobject_cast<QQuickWindow *>(window)) {
                                 quick->releaseResources();
                             }
                         }
                     });
}
