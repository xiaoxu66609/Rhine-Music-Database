#include "DiscoverArtwork.h"
#include "Host.h"
#include <QPointer>

DiscoverArtwork::DiscoverArtwork(Host *host, QObject *parent) : QObject(parent), m_host(host) {
}

/** 滚动、切换来源或账号时作废旧回调；失败封面保持占位，不在每帧重试。 */
void DiscoverArtwork::show(const QString &scope, const QStringList &urls) {
    if (scope == m_scope && urls == m_urls) {
        return;
    }
    m_scope = scope;
    m_urls = urls;
    m_images.clear();
    const auto generation = ++m_generation;
    for (const auto &url : urls) {
        if (url.isEmpty() || m_images.contains(url)) {
            continue;
        }
        m_images.insert(url, {});
        m_host->loadCover(
            url,
            [owner = QPointer(this), generation, url](QString key) {
                if (!owner || generation != owner->m_generation) {
                    return;
                }
                owner->m_images[url] = key;
                if (!key.isEmpty()) {
                    owner->m_host->invalidate();
                }
            },
            512);
    }
}

QString DiscoverArtwork::image(const QString &url) const {
    return m_images.value(url);
}
