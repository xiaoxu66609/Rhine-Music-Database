import QtQuick

// 触摸拖动
DragHandler {
    required property var stage
    required property var backend
    target: null
    acceptedDevices: PointerDevice.TouchScreen
    enabled: stage.touchInput && (!!backend.state.modal || backend.state.mode === "detail")
    xAxis.enabled: false
    property real previousY: 0
    onActiveChanged: previousY = 0
    onTranslationChanged: {
        if (active) {
            const delta = translation.y - previousY;
            previousY = translation.y;
            backend.wheelInput(centroid.scenePosition.x / stage.stageScale, centroid.scenePosition.y / stage.stageScale, delta / stage.stageScale, 0);
        }
    }
}
