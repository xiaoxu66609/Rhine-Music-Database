#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QTimer>

class Host;
class MusicLibrary;

/** 下载队列的界面侧。真正的直链、标签、专辑封装和解密在 MusicBridge 里跑，这里只发命令并保留快照。 */
class DownloadCenter : public QObject {
    Q_OBJECT
  public:
    DownloadCenter(Host *host, MusicLibrary *library, QObject *parent = nullptr);
    QJsonArray jobs;
    QString filter = "all";
    int offset = 0;
    QString notice;
    int activeCount() const;
    QString quality() const;
    QString qualityLabel() const;
    QString lyricMode() const;
    QString lyricLabel() const;
    QString identity() const;
    QString identityLabel() const;
    QString qqIdentity() const;
    QString neIdentity() const;
    int concurrency() const;
    QString directory() const;
    QString decryptDirectory() const;
    void cycleQuality();
    void cycleLyric();
    void cycleIdentity();
    void cycleConcurrency();
    void setDirectory(const QString &path);
    void setDecryptDirectory(const QString &path);
    void setFilter(const QString &value);
    void refresh();
    void enqueue(const QJsonArray &tracks, const QJsonObject &album = {});
    void enqueueCurrent();
    void enqueueLoaded();
    void enqueueSelected(const QJsonArray &tracks);
    bool needsAlbumConfirm(int *loaded = nullptr, int *total = nullptr) const;
    void cancel(const QString &id);
    void retry(const QString &id);
    void revealJob(const QString &id);
    void unlockFiles(const QStringList &paths);
    void unlockDirectories(const QStringList &paths);
    static bool matches(const QJsonObject &job, const QString &filter);
    static QString stateLabel(const QJsonObject &job);
    static QString qualityName(const QString &quality);

  private:
    Host *m_host;
    MusicLibrary *m_library;
    QTimer m_timer;
    bool m_inflight = false;
    QJsonObject settingsObject() const;
    void post(const QString &operation, const QJsonObject &params);
    void apply(const QJsonObject &response, const QString &error);
    QString providerRoute() const;
    QJsonArray loadedTracks(bool *albumMode, QJsonObject *album, int *loaded, int *total) const;
};
