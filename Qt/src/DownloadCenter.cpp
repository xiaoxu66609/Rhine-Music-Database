#include "DownloadCenter.h"
#include "Host.h"
#include "MusicLibrary.h"
#include <algorithm>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QPointer>
#include <QSet>
#include <QStandardPaths>

namespace {
const QStringList kQualities{"flac", "ape", "320", "128", "m4a"};
const QStringList kStreaming{"flac", "320", "128"};
const QStringList kLyrics{"both", "embed", "lrc", "none"};

QString cycle(const QStringList &values, const QString &current) {
    const int index = values.indexOf(current);
    return values.at((index + 1) % values.size());
}

int trackNumber(const MusicDirectory &directory, const QJsonObject &song, int fallback) {
    const auto id = song["id"].toString();
    for (int index = 0; index < directory.ids.size(); ++index) {
        if (directory.ids.at(index).toString() == id) {
            return index + 1;
        }
    }
    return fallback;
}
}

DownloadCenter::DownloadCenter(Host *host, MusicLibrary *library, QObject *parent)
    : QObject(parent), m_host(host), m_library(library) {
    m_timer.setInterval(800);
    connect(&m_timer, &QTimer::timeout, this, [this] {
        if (!m_inflight) {
            post("downloadSnapshot", {});
        }
    });
}

int DownloadCenter::activeCount() const {
    int count = 0;
    for (const auto &value : jobs) {
        const auto state = value.toObject()["state"].toString();
        if (state == "queued" || state == "running") {
            ++count;
        }
    }
    return count;
}

QString DownloadCenter::quality() const {
    const auto saved = m_host->preference("download-quality");
    return kQualities.contains(saved) ? saved : QStringLiteral("flac");
}

QString DownloadCenter::qualityName(const QString &quality) {
    static const QHash<QString, QString> names{
        {"flac", "无损 FLAC"}, {"ape", "APE"}, {"320", "320k"}, {"128", "128k"}, {"m4a", "M4A"}};
    return names.value(quality, quality);
}

QString DownloadCenter::qualityLabel() const {
    auto label = qualityName(quality());
    if ((m_library->provider == "netease" || m_library->provider == "kugou") &&
        (quality() == "ape" || quality() == "m4a")) {
        label += QStringLiteral(" · 此平台按无损起跳");
    }
    return label;
}

QString DownloadCenter::lyricMode() const {
    const auto saved = m_host->preference("download-lyric");
    return kLyrics.contains(saved) ? saved : QStringLiteral("both");
}

QString DownloadCenter::lyricLabel() const {
    static const QHash<QString, QString> names{
        {"both", "内嵌 + 另存"}, {"embed", "仅内嵌"}, {"lrc", "仅另存"}, {"none", "不保存"}};
    return names.value(lyricMode(), lyricMode());
}

QString DownloadCenter::identity() const {
    return m_host->preference("download-identity") == "anon" ? QStringLiteral("anon")
                                                             : QStringLiteral("account");
}

QString DownloadCenter::identityLabel() const {
    return identity() == "anon" ? QStringLiteral("匿名") : QStringLiteral("登录账户");
}

int DownloadCenter::concurrency() const {
    bool ok = false;
    const int saved = m_host->preference("download-concurrency").toInt(&ok);
    if (!ok) {
        return 2;
    }
    return std::clamp(saved, 1, 4);
}

QString DownloadCenter::directory() const {
    const auto saved = m_host->preference("download-dir").trimmed();
    if (!saved.isEmpty()) {
        return saved;
    }
    auto music = QStandardPaths::writableLocation(QStandardPaths::MusicLocation);
    if (music.isEmpty()) {
        music = QDir::homePath() + QStringLiteral("/Music");
    }
    return QDir(music).filePath(QStringLiteral("Rhine"));
}

void DownloadCenter::cycleQuality() {
    const auto options =
        (m_library->provider == "netease" || m_library->provider == "kugou") ? kStreaming : kQualities;
    if (!options.contains(quality())) {
        m_host->setPreference("download-quality", options.first());
        m_library->changed();
        return;
    }
    m_host->setPreference("download-quality", cycle(options, quality()));
    m_library->changed();
}

void DownloadCenter::cycleLyric() {
    m_host->setPreference("download-lyric", cycle(kLyrics, lyricMode()));
    m_library->changed();
}

void DownloadCenter::cycleIdentity() {
    m_host->setPreference("download-identity", identity() == "anon" ? "account" : "anon");
    m_library->changed();
}

void DownloadCenter::cycleConcurrency() {
    m_host->setPreference("download-concurrency", QString::number(concurrency() % 4 + 1));
    post("downloadConfigure", {});
}

void DownloadCenter::setDirectory(const QString &path) {
    const auto clean = QFileInfo(path).absoluteFilePath();
    if (clean.isEmpty()) {
        return;
    }
    m_host->setPreference("download-dir", clean);
    m_library->status = QStringLiteral("下载目录已改为 ") + clean;
    post("downloadConfigure", {});
}

void DownloadCenter::setFilter(const QString &value) {
    if (!QStringList{"all", "running", "done", "failed"}.contains(value) || value == filter) {
        return;
    }
    filter = value;
    offset = 0;
    m_library->changed();
}

void DownloadCenter::refresh() {
    post("downloadSnapshot", {});
}

QString DownloadCenter::providerRoute() const {
    return m_library->provider == "qq" || m_library->provider == "kugou" || m_library->provider == "netease"
               ? m_library->provider
               : QStringLiteral("qq");
}

QJsonObject DownloadCenter::settingsObject() const {
    return {{"downloadDir", directory()},
            {"quality", quality()},
            {"lyricMode", lyricMode()},
            {"identity", identity()},
            {"concurrency", concurrency()}};
}

void DownloadCenter::post(const QString &operation, const QJsonObject &params) {
    static const QSet<QString> offlineLocalOps{
        QStringLiteral("downloadUnlock"),  QStringLiteral("downloadSnapshot"),
        QStringLiteral("downloadConfigure"), QStringLiteral("downloadCancel"),
        QStringLiteral("downloadRetry"),
    };
    if (m_host->offline && !offlineLocalOps.contains(operation)) {
        notice = QStringLiteral("当前离线，不能下载");
        m_library->changed();
        return;
    }
    auto body = params;
    body["settings"] = settingsObject();
    m_inflight = true;
    QPointer<DownloadCenter> self(this);
    m_host->requestJson("/native/" + providerRoute() + "/" + operation, body,
                        [self](QJsonObject response, QString error) {
                            if (self) {
                                self->m_inflight = false;
                                self->apply(response, error);
                            }
                        });
}

void DownloadCenter::apply(const QJsonObject &response, const QString &error) {
    if (!error.isEmpty()) {
        notice = error;
        m_library->changed();
        return;
    }
    const auto body = response["body"].toObject();
    if (body["code"].toInt(200) != 200) {
        notice = body["message"].toString(QStringLiteral("下载服务没有响应"));
    } else {
        notice.clear();
    }
    const auto value = body["value"].toObject();
    if (value.contains("jobs")) {
        jobs = value["jobs"].toArray();
    }
    const int active = value["active"].toInt(activeCount());
    if (active > 0) {
        if (!m_timer.isActive()) {
            m_timer.start();
        }
    } else {
        m_timer.stop();
    }
    const auto maximum = std::max(0, int(jobs.size()) - 6);
    offset = std::clamp(offset, 0, maximum);
    m_library->changed();
}

void DownloadCenter::enqueue(const QJsonArray &tracks, const QJsonObject &album) {
    if (m_library->isLocal()) {
        notice = QStringLiteral("本地曲目已在磁盘上");
        m_library->changed();
        return;
    }
    QJsonArray clean;
    for (const auto &value : tracks) {
        auto song = value.toObject();
        if (song["deferred"].toBool() || song["id"].toString().isEmpty()) {
            continue;
        }
        if (song["kind"].toString() != "song" && !song["kind"].toString().isEmpty()) {
            continue;
        }
        if (song["provider"].toString().isEmpty()) {
            song["provider"] = m_library->provider;
        }
        clean.append(song);
    }
    if (clean.isEmpty()) {
        notice = QStringLiteral("没有可以下载的曲目");
        m_library->changed();
        return;
    }
    QJsonObject params{{"tracks", clean}};
    if (!album.isEmpty()) {
        params["album"] = album;
    }
    m_library->status =
        QStringLiteral("已加入下载 · ") + QString::number(clean.size()) + QStringLiteral(" 首");
    post("downloadEnqueue", params);
}

void DownloadCenter::enqueueCurrent() {
    if (m_library->current.value("kind") != "song") {
        return;
    }
    enqueue({m_library->current});
}

QJsonArray DownloadCenter::loadedTracks(bool *albumMode, QJsonObject *album, int *loaded, int *total) const {
    QJsonArray songs;
    QJsonObject item;
    if (m_library->directory) {
        item = m_library->directory->item;
        songs =
            item["kind"] == "playlist" ? m_library->directory->orderedSongs() : m_library->directory->songs;
    } else if (m_library->selectedLane == 1) {
        songs = m_library->lists[1];
        item = QJsonObject{{"kind", "playlist"}, {"title", "我喜欢的音乐"}, {"trackCount", songs.size()}};
    }
    QJsonArray ready;
    int index = 0;
    for (const auto &value : songs) {
        auto song = value.toObject();
        ++index;
        if (song["deferred"].toBool() || song["id"].toString().isEmpty() || song["kind"] != "song") {
            continue;
        }
        if (m_library->directory && item["kind"] == "album") {
            song["trackNo"] = trackNumber(*m_library->directory, song, index);
            const int disc = song["disc"].toInt(song["cd"].toInt(1));
            song["disc"] = disc >= 1 ? disc : 1;
        }
        ready.append(song);
    }
    const int declared =
        std::max({item["trackCount"].toInt(),
                  m_library->directory ? int(m_library->directory->ids.size()) : 0, int(ready.size())});
    if (loaded) {
        *loaded = int(ready.size());
    }
    if (total) {
        *total = declared;
    }
    const bool wholeAlbum = item["kind"] == "album" && !item["id"].toString().isEmpty();
    if (albumMode) {
        *albumMode = wholeAlbum;
    }
    if (album && wholeAlbum) {
        *album =
            QJsonObject{{"source", m_library->provider}, {"id", item["id"]},     {"name", item["title"]},
                        {"artist", item["artist"]},      {"date", item["date"]}, {"coverUrl", item["cover"]},
                        {"totalTracks", declared}};
    }
    return ready;
}

bool DownloadCenter::needsAlbumConfirm(int *loadedCount, int *totalCount) const {
    bool albumMode = false;
    int loaded = 0;
    int total = 0;
    loadedTracks(&albumMode, nullptr, &loaded, &total);
    if (loadedCount) {
        *loadedCount = loaded;
    }
    if (totalCount) {
        *totalCount = total;
    }
    return albumMode && total > loaded;
}

void DownloadCenter::enqueueLoaded() {
    bool albumMode = false;
    QJsonObject album;
    int loaded = 0;
    int total = 0;
    const auto tracks = loadedTracks(&albumMode, &album, &loaded, &total);
    enqueue(tracks, albumMode ? album : QJsonObject{});
}

void DownloadCenter::cancel(const QString &id) {
    post("downloadCancel", {{"id", id}});
}

void DownloadCenter::retry(const QString &id) {
    post("downloadRetry", {{"id", id}});
}

void DownloadCenter::unlockFiles(const QStringList &paths) {
    if (paths.isEmpty()) {
        return;
    }
    QJsonArray files;
    for (const auto &path : paths) {
        files.append(path);
    }
    m_library->status =
        QStringLiteral("正在解密 ") + QString::number(paths.size()) + QStringLiteral(" 个文件");
    post("downloadUnlock", {{"files", files}});
}

bool DownloadCenter::matches(const QJsonObject &job, const QString &filter) {
    const auto state = job["state"].toString();
    if (filter == "running") {
        return state == "queued" || state == "running";
    }
    if (filter == "done") {
        return state == "done";
    }
    if (filter == "failed") {
        return state == "failed" || state == "cancelled";
    }
    return true;
}

QString DownloadCenter::stateLabel(const QJsonObject &job) {
    const auto state = job["state"].toString();
    if (state == "queued") {
        return QStringLiteral("排队");
    }
    if (state == "running") {
        return QString::number(job["progress"].toInt()) + QStringLiteral("%");
    }
    if (state == "done") {
        if (job["downgraded"].toBool()) {
            return QStringLiteral("完成 · 已降级为 ") + qualityName(job["finalQuality"].toString());
        }
        if (job["anonFallback"].toBool()) {
            return QStringLiteral("完成 · 已切匿名");
        }
        if (!job["error"].toString().isEmpty()) {
            return QStringLiteral("完成 · ") + job["error"].toString();
        }
        return QStringLiteral("完成");
    }
    if (state == "cancelled") {
        return QStringLiteral("已取消");
    }
    return job["error"].toString().isEmpty() ? QStringLiteral("失败") : job["error"].toString();
}
