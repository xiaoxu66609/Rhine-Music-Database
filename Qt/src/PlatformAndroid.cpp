#include "PlatformAndroid.h"
#include "AppStorage.h"
#include "Host.h"
#include <QDebug>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileDevice>
#include <QFileInfo>
#include <QStandardPaths>

namespace {
QString credentialPath() {
    return AppStorage::dataDirectory() + QStringLiteral("/account.credential");
}

bool copyAssetTree(const QString &from, const QString &to) {
    QDirIterator iterator(from, QDir::Files, QDirIterator::Subdirectories);
    bool copied = false;
    while (iterator.hasNext()) {
        iterator.next();
        const auto relative = QDir(from).relativeFilePath(iterator.filePath());
        const auto target = QDir(to).filePath(relative);
        if (!QDir().mkpath(QFileInfo(target).absolutePath())) {
            return false;
        }
        QFile::remove(target);
        if (!QFile::copy(iterator.filePath(), target)) {
            qWarning() << "Unable to extract" << iterator.filePath();
            return false;
        }
        QFile::setPermissions(target, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ReadUser |
                                           QFileDevice::WriteUser);
        copied = true;
    }
    return copied;
}
}

QString prepareAndroidResources() {
    const auto source = QStringLiteral("assets:/RhineAssets");
    if (!QFileInfo::exists(source + QStringLiteral("/slots.json"))) {
        qCritical("Android package is missing RhineAssets");
        return {};
    }
    const auto destination =
        QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + QStringLiteral("/RhineAssets");
    QString stamp;
    QFile stampFile(source + QStringLiteral("/bundle-stamp.txt"));
    if (stampFile.open(QIODevice::ReadOnly)) {
        stamp = QString::fromUtf8(stampFile.readAll()).trimmed();
    }
    QFile installed(destination + QStringLiteral("/bundle-stamp.txt"));
    const bool current = !stamp.isEmpty() && installed.open(QIODevice::ReadOnly) &&
                         QString::fromUtf8(installed.readAll()).trimmed() == stamp &&
                         QFileInfo::exists(destination + QStringLiteral("/slots.json")) &&
                         QFileInfo::exists(destination + QStringLiteral("/MusicBridge/worker.cjs"));
    if (!current) {
        QDir(destination).removeRecursively();
        if (!copyAssetTree(source, destination) ||
            !QFileInfo::exists(destination + QStringLiteral("/slots.json"))) {
            qCritical("Unable to extract Android resources");
            return {};
        }
    }
    const auto cache = QStandardPaths::writableLocation(QStandardPaths::CacheLocation);
    QDir().mkpath(cache + QStringLiteral("/tmp"));
    qputenv("HOME", QFileInfo(destination).dir().absolutePath().toUtf8());
    qputenv("TMPDIR", (cache + QStringLiteral("/tmp")).toUtf8());
    return destination;
}

QByteArray platformCredential() {
    QFile file(credentialPath());
    if (!file.open(QIODevice::ReadOnly)) {
        return {};
    }
    return file.readAll();
}

QString platformSaveCredential(const QByteArray &bytes) {
    const auto path = credentialPath();
    if (!QDir().mkpath(QFileInfo(path).absolutePath())) {
        return QStringLiteral("登录成功，但 Android 凭据当前不可写");
    }
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        return QStringLiteral("登录成功，但 Android 凭据当前不可写");
    }
    return file.write(bytes) == bytes.size() ? QString()
                                             : QStringLiteral("登录成功，但 Android 凭据当前不可写");
}

void platformDeleteCredential() {
    QFile::remove(credentialPath());
}

void platformPlay(const QString &, bool, std::function<void(QString)> done) {
    done(QStringLiteral("Android 仅支持面板内播放"));
}
