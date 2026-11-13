#pragma once
#include <QtGlobal>
#if !defined(Q_OS_IOS) && !defined(Q_OS_ANDROID)
#include <QProcess>
using BridgeProcess = QProcess;
#else
#include <QJsonObject>
#include <QObject>

// iOS 与 Android 使用常驻 Node 运行时和可销毁的 Worker，会话之间不共享模块和环境变量。
class BridgeProcess : public QObject {
    Q_OBJECT
  public:
    enum ProcessState { NotRunning, Starting, Running };
    enum ProcessError { FailedToStart, Crashed, UnknownError };
    explicit BridgeProcess(QObject *parent = nullptr);
    ~BridgeProcess() override;
    void start(const QString &root, const QString &temporary, const QString &edition);
    void write(const QByteArray &bytes);
    QByteArray readAllStandardOutput();
    void kill();
    void terminate();
    void closeWriteChannel();
    bool waitForFinished(int);
    ProcessState state() const {
        return m_state;
    }
    ProcessError error() const {
        return m_error;
    }
    void accept(const QJsonObject &message);

  signals:
    void started();
    void errorOccurred(ProcessError error);
    void readyReadStandardOutput();
    void finished();

  private:
    ProcessState m_state = NotRunning;
    ProcessError m_error = UnknownError;
    QString m_session;
    QByteArray m_output;
};
#endif
