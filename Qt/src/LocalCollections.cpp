#include "LocalCollections.h"
#include "AppStorage.h"
#include "MusicData.h"
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QSaveFile>
#include <QUuid>
#include <QVector>
#include <algorithm>

LocalCollections::LocalCollections(QString provider, QString storage, QObject *parent)
    : QObject(parent), m_provider(provider.trimmed()),
      m_storage(storage.isEmpty() ? AppStorage::dataDirectory() + "/collections" : storage) {
    load();
}

QString LocalCollections::path() const {
    return m_storage + "/" + m_provider + ".json";
}

QJsonArray LocalCollections::strings(const QJsonValue &value) {
    QJsonArray result;
    QStringList seen;
    for (const auto &entry : value.toArray()) {
        const auto text = entry.toString();
        if (!text.isEmpty() && !seen.contains(text)) {
            seen.append(text);
            result.append(text);
        }
    }
    return result;
}

void LocalCollections::load() {
    m_liked = {};
    m_playlists = {};
    QFile file(path());
    if (!file.open(QIODevice::ReadOnly) || file.size() > 16 * 1024 * 1024) {
        return;
    }
    const auto document = QJsonDocument::fromJson(file.readAll()).object();
    if (document["version"].toInt() != 1 || document["provider"].toString() != m_provider) {
        return;
    }
    m_liked = strings(document["liked"]);
    for (const auto &entry : document["playlists"].toArray()) {
        const auto record = entry.toObject();
        const auto id = record["id"].toString();
        const auto name = record["name"].toString().trimmed();
        if (id.isEmpty() || name.isEmpty()) {
            continue;
        }
        m_playlists.append(QJsonObject{{"id", id},
                                       {"name", name},
                                       {"createdAt", record["createdAt"].toDouble(0)},
                                       {"trackIDs", strings(record["trackIDs"])}});
    }
    QVector<QJsonObject> records;
    for (const auto &value : m_playlists) {
        records.append(value.toObject());
    }
    std::stable_sort(records.begin(), records.end(), [](const QJsonObject &left, const QJsonObject &right) {
        return left["createdAt"].toDouble() > right["createdAt"].toDouble();
    });
    m_playlists = {};
    for (const auto &record : records) {
        m_playlists.append(record);
    }
}

bool LocalCollections::save() {
    if (!QDir().mkpath(m_storage)) {
        return false;
    }
    QSaveFile file(path());
    if (!file.open(QIODevice::WriteOnly)) {
        return false;
    }
    const QJsonObject document{
        {"version", 1}, {"provider", m_provider}, {"liked", m_liked}, {"playlists", m_playlists}};
    file.write(QJsonDocument(document).toJson(QJsonDocument::Compact));
    return file.commit();
}

QStringList LocalCollections::likedIDs() const {
    // 存储按添加顺序追加，读取时反转为从新到旧。
    QStringList result;
    for (qsizetype index = m_liked.size() - 1; index >= 0; --index) {
        result.append(m_liked.at(index).toString());
    }
    return result;
}

bool LocalCollections::isLiked(const QString &id) const {
    for (const auto &value : m_liked) {
        if (value.toString() == id) {
            return true;
        }
    }
    return false;
}

bool LocalCollections::setLiked(const QString &id, bool liked) {
    if (id.isEmpty()) {
        return false;
    }
    for (qsizetype index = 0; index < m_liked.size(); ++index) {
        if (m_liked.at(index).toString() != id) {
            continue;
        }
        if (liked) {
            return true;
        }
        m_liked.removeAt(index);
        save();
        return true;
    }
    if (!liked) {
        return true;
    }
    m_liked.append(id);
    save();
    return true;
}

int LocalCollections::playlistIndex(const QString &id) const {
    for (qsizetype index = 0; index < m_playlists.size(); ++index) {
        if (m_playlists.at(index).toObject()["id"].toString() == id) {
            return int(index);
        }
    }
    return -1;
}

QJsonObject LocalCollections::playlistItem(const QJsonObject &record) const {
    const auto created = qint64(record["createdAt"].toDouble(0));
    auto value =
        MusicData::item("playlist", record["id"].toString(), record["name"].toString(), "", m_provider);
    value["creatorID"] = creatorID();
    value["localCollection"] = true;
    value["trackCount"] = int(record["trackIDs"].toArray().size());
    value["description"] = QStringLiteral("本地歌单 · 仅保存在本机");
    if (created > 0) {
        value["date"] = QDateTime::fromMSecsSinceEpoch(created).date().toString(QStringLiteral("yyyy-MM-dd"));
    }
    return value;
}

QJsonArray LocalCollections::playlists() const {
    QJsonArray result;
    for (const auto &value : m_playlists) {
        result.append(playlistItem(value.toObject()));
    }
    return result;
}

QJsonObject LocalCollections::playlist(const QString &id) const {
    const auto index = playlistIndex(id);
    return index < 0 ? QJsonObject{} : playlistItem(m_playlists.at(index).toObject());
}

QStringList LocalCollections::tracks(const QString &id) const {
    const auto index = playlistIndex(id);
    QStringList result;
    if (index < 0) {
        return result;
    }
    // 曲目按加入顺序存储，读取时反转为从新到旧。
    const auto tracks = m_playlists.at(index).toObject()["trackIDs"].toArray();
    for (qsizetype row = tracks.size() - 1; row >= 0; --row) {
        result.append(tracks.at(row).toString());
    }
    return result;
}

QJsonObject LocalCollections::createPlaylist(const QString &name) {
    const auto title = name.trimmed();
    if (title.isEmpty() || title.toUcs4().size() > 100 || m_playlists.size() >= 200) {
        return {};
    }
    const auto record = QJsonObject{{"id", QUuid::createUuid().toString(QUuid::WithoutBraces)},
                                    {"name", title},
                                    {"createdAt", double(QDateTime::currentMSecsSinceEpoch())},
                                    {"trackIDs", QJsonArray{}}};
    m_playlists.prepend(record);
    save();
    return playlistItem(record);
}

bool LocalCollections::renamePlaylist(const QString &id, const QString &name) {
    const auto index = playlistIndex(id);
    const auto title = name.trimmed();
    if (index < 0 || title.isEmpty() || title.toUcs4().size() > 100) {
        return false;
    }
    auto record = m_playlists.at(index).toObject();
    record["name"] = title;
    m_playlists.replace(index, record);
    save();
    return true;
}

bool LocalCollections::deletePlaylist(const QString &id) {
    const auto index = playlistIndex(id);
    if (index < 0) {
        return false;
    }
    m_playlists.removeAt(index);
    save();
    return true;
}

bool LocalCollections::addTrack(const QString &playlistID, const QString &trackID) {
    const auto index = playlistIndex(playlistID);
    if (index < 0 || trackID.isEmpty()) {
        return false;
    }
    auto record = m_playlists.at(index).toObject();
    auto tracks = record["trackIDs"].toArray();
    for (const auto &value : tracks) {
        if (value.toString() == trackID) {
            return true;
        }
    }
    tracks.append(trackID);
    record["trackIDs"] = tracks;
    m_playlists.replace(index, record);
    save();
    return true;
}

bool LocalCollections::removeTrack(const QString &playlistID, const QString &trackID) {
    const auto index = playlistIndex(playlistID);
    if (index < 0) {
        return false;
    }
    auto record = m_playlists.at(index).toObject();
    auto tracks = record["trackIDs"].toArray();
    for (qsizetype row = 0; row < tracks.size(); ++row) {
        if (tracks.at(row).toString() == trackID) {
            tracks.removeAt(row);
            record["trackIDs"] = tracks;
            m_playlists.replace(index, record);
            save();
            break;
        }
    }
    return true;
}
