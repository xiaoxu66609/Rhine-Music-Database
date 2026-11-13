#pragma once
#include <QHash>
#include <QObject>
#include <QStringList>

class Host;

// 只维护当前可见区域的封面键，像素内存预算与下载合并继续由 Host 管理。
class DiscoverArtwork : public QObject {
  public:
    explicit DiscoverArtwork(Host *host, QObject *parent = nullptr);
    void show(const QString &scope, const QStringList &urls);
    QString image(const QString &url) const;

  private:
    Host *m_host;
    QString m_scope;
    QStringList m_urls;
    QHash<QString, QString> m_images;
    quint64 m_generation = 0;
};
