#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QStringList>

/**
 * 塞壬唱片本地收藏与自建歌单
 */
class LocalCollections : public QObject {
  public:
    explicit LocalCollections(QString provider, QString storage = {}, QObject *parent = nullptr);

    QString provider() const {
        return m_provider;
    }
    QString creatorID() const {
        return m_provider + QStringLiteral("-local");
    }
    QStringList likedIDs() const;
    bool isLiked(const QString &id) const;
    /// 返回操作是否落地；重复喜欢/取消保持幂等。
    bool setLiked(const QString &id, bool liked);

    QJsonArray playlists() const;
    QJsonObject playlist(const QString &id) const;
    QStringList tracks(const QString &id) const;
    QJsonObject createPlaylist(const QString &name);
    bool renamePlaylist(const QString &id, const QString &name);
    bool deletePlaylist(const QString &id);
    bool addTrack(const QString &playlistID, const QString &trackID);
    bool removeTrack(const QString &playlistID, const QString &trackID);

  private:
    QString m_provider;
    QString m_storage;
    QJsonArray m_liked;
    QJsonArray m_playlists;
    QString path() const;
    void load();
    bool save();
    int playlistIndex(const QString &id) const;
    QJsonObject playlistItem(const QJsonObject &record) const;
    static QJsonArray strings(const QJsonValue &value);
};
