#include "Gamepad.h"
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <XInput.h>
#endif

#ifdef Q_OS_WIN
namespace {
constexpr int DPadInitialDelay = 350;
constexpr int DPadRepeatInterval = 110;
constexpr int ConnectedPollInterval = 16;
constexpr int DisconnectedPollInterval = 500;
constexpr int IdlePollInterval = 1000;
} // namespace
#endif

Gamepad::Gamepad(QObject *parent) : QObject(parent) {
#ifdef Q_OS_WIN
    m_clock.start();
    m_timer.setTimerType(Qt::PreciseTimer);
    m_timer.setInterval(ConnectedPollInterval);
    connect(&m_timer, &QTimer::timeout, this, &Gamepad::poll);
    m_timer.start();
#endif
}

void Gamepad::setEnabled(bool enabled) {
    if (m_enabled == enabled) {
        return;
    }
    m_enabled = enabled;
    if (!enabled) {
        reset();
    }
#ifdef Q_OS_WIN
    m_timer.setInterval(enabled ? ConnectedPollInterval : IdlePollInterval);
#endif
}

QString Gamepad::name(Button button) {
    switch (button) {
    case Up:
        return QStringLiteral("up");
    case Down:
        return QStringLiteral("down");
    case Left:
        return QStringLiteral("left");
    case Right:
        return QStringLiteral("right");
    case A:
        return QStringLiteral("a");
    case B:
        return QStringLiteral("b");
    case Select:
        return QStringLiteral("select");
    case Start:
        return QStringLiteral("start");
    case LB:
        return QStringLiteral("lb");
    case RB:
        return QStringLiteral("rb");
    case LT:
        return QStringLiteral("lt");
    case RT:
        return QStringLiteral("rt");
    case LS:
        return QStringLiteral("ls");
    case RS:
        return QStringLiteral("rs");
    case ButtonCount:
        break;
    }
    return {};
}

void Gamepad::reset() {
    for (auto &held : m_held) {
        held = false;
    }
    for (auto &next : m_nextRepeat) {
        next = 0;
    }
}

void Gamepad::update(Button button, bool down, qint64 now, qint64 initialDelay, qint64 repeatInterval) {
    const auto index = int(button);
    if (!down) {
        m_held[index] = false;
        m_nextRepeat[index] = 0;
        return;
    }
    if (!m_held[index]) {
        m_held[index] = true;
        m_nextRepeat[index] = initialDelay > 0 ? now + initialDelay : 0;
        emit pressed(name(button));
        return;
    }
    if (repeatInterval > 0 && m_nextRepeat[index] != 0 && now >= m_nextRepeat[index]) {
        m_nextRepeat[index] = now + repeatInterval;
        emit pressed(name(button));
    }
}

void Gamepad::poll() {
#ifdef Q_OS_WIN
    if (!m_enabled) {
        return;
    }
    XINPUT_STATE state{};
    DWORD result = ERROR_SUCCESS;
    if (m_slot >= 0) {
        result = XInputGetState(DWORD(m_slot), &state);
    }
    if (m_slot < 0 || result != ERROR_SUCCESS) {
        m_slot = -1;
        for (DWORD slot = 0; slot < XUSER_MAX_COUNT; ++slot) {
            if (XInputGetState(slot, &state) == ERROR_SUCCESS) {
                m_slot = int(slot);
                result = ERROR_SUCCESS;
                break;
            }
        }
    }
    if (result != ERROR_SUCCESS) {
        if (m_connected) {
            reset();
        }
        m_connected = false;
        m_timer.setInterval(DisconnectedPollInterval);
        return;
    }
    if (!m_connected) {
        m_connected = true;
        reset();
        m_timer.setInterval(ConnectedPollInterval);
    }
    const auto &pad = state.Gamepad;
    const auto buttons = pad.wButtons;
    const qint64 now = m_clock.elapsed();
    update(Up, buttons & XINPUT_GAMEPAD_DPAD_UP, now, DPadInitialDelay, DPadRepeatInterval);
    update(Down, buttons & XINPUT_GAMEPAD_DPAD_DOWN, now, DPadInitialDelay, DPadRepeatInterval);
    update(Left, buttons & XINPUT_GAMEPAD_DPAD_LEFT, now, DPadInitialDelay, DPadRepeatInterval);
    update(Right, buttons & XINPUT_GAMEPAD_DPAD_RIGHT, now, DPadInitialDelay, DPadRepeatInterval);
    update(A, buttons & XINPUT_GAMEPAD_A, now, 0, 0);
    update(B, buttons & XINPUT_GAMEPAD_B, now, 0, 0);
    update(Select, buttons & XINPUT_GAMEPAD_BACK, now, 0, 0);
    update(Start, buttons & XINPUT_GAMEPAD_START, now, 0, 0);
    update(LB, buttons & XINPUT_GAMEPAD_LEFT_SHOULDER, now, 0, 0);
    update(RB, buttons & XINPUT_GAMEPAD_RIGHT_SHOULDER, now, 0, 0);
    update(LT, pad.bLeftTrigger >= XINPUT_GAMEPAD_TRIGGER_THRESHOLD, now, 0, 0);
    update(RT, pad.bRightTrigger >= XINPUT_GAMEPAD_TRIGGER_THRESHOLD, now, 0, 0);
    update(LS, buttons & XINPUT_GAMEPAD_LEFT_THUMB, now, 0, 0);
    update(RS, buttons & XINPUT_GAMEPAD_RIGHT_THUMB, now, 0, 0);
#endif
}
