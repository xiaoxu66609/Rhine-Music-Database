#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QRectF>
#include <algorithm>
#include <cmath>
#include <optional>

/** 各面板共用的连续像素滚动与轨道计算 */
namespace HudScroll {
constexpr double DefaultWheelStep = 60.;

inline double maximum(double contentHeight, double viewportHeight) {
    return std::max(0., contentHeight - viewportHeight);
}

inline double clampOffset(double offset, double contentHeight, double viewportHeight) {
    return std::clamp(offset, 0., maximum(contentHeight, viewportHeight));
}

/** 平滑帧只补距离时原样累加；只有角度步进时才退回到面板给定的行高。 */
inline double applyWheel(double offset, double contentHeight, double viewportHeight,
                         std::optional<double> distance, int steps, double stepPixels) {
    const auto movement = distance.has_value() && *distance != 0. ? *distance : steps * stepPixels;
    return clampOffset(offset + movement, contentHeight, viewportHeight);
}

struct VisibleRange {
    int first = 0;
    int last = -1;
};

inline VisibleRange visibleRange(double offset, double viewportHeight, double rowHeight, int count,
                                 int overscan = 1) {
    if (rowHeight <= 0. || count <= 0) {
        return {};
    }
    const auto first = std::max(0, int(std::floor(offset / rowHeight)) - overscan);
    const auto last = std::min(count - 1, int(std::ceil((offset + viewportHeight) / rowHeight)) + overscan);
    return {first, last};
}

struct Rail {
    bool visible = false;
    QRectF track;
    QRectF thumb;
};

/** track 是固定轨道矩形；没有可滚动内容时不返回 thumb。 */
inline Rail rail(const QRectF &track, double contentHeight, double viewportHeight, double offset,
                 double minThumbHeight = 30.) {
    Rail result;
    result.track = track;
    const auto range = maximum(contentHeight, viewportHeight);
    if (range <= 0. || track.height() <= 0.) {
        return result;
    }
    result.visible = true;
    const auto thumbHeight = std::clamp(track.height() * viewportHeight / contentHeight,
                                        std::min(minThumbHeight, track.height()), track.height());
    const auto thumbY = track.top() + std::clamp(offset / range, 0., 1.) * (track.height() - thumbHeight);
    result.thumb = QRectF(track.x(), thumbY, track.width(), thumbHeight);
    return result;
}

/** 列表绘制与命中必须使用同一裁剪区，半行不能遮挡表头/页脚。 */
inline void clipHits(QJsonArray &hits, int first, const QRectF &area) {
    QJsonArray clipped;
    for (qsizetype index = 0; index < hits.size(); ++index) {
        auto entry = hits.at(index).toObject();
        if (index >= first) {
            const QRectF rectangle(entry["x"].toDouble(), entry["y"].toDouble(), entry["width"].toDouble(),
                                   entry["height"].toDouble());
            const auto visible = rectangle.intersected(area);
            if (visible.isEmpty()) {
                continue;
            }
            entry["x"] = visible.x();
            entry["y"] = visible.y();
            entry["width"] = visible.width();
            entry["height"] = visible.height();
        }
        clipped.append(entry);
    }
    hits = clipped;
}
}
