import QtQuick
import QtQuick.Dialogs
import QtQuick.Window

// 本地文件选择共享组件
Item {
    id: dialogs
    property var hostWindow: Window.window
    required property var backend
    FolderDialog {
        id: localFolderDialog
        objectName: "localMusicFolderDialog"
        Binding on parentWindow {
            when: Qt.platform.os === "windows"
            value: dialogs.hostWindow
        }
        title: "导入本地音乐文件夹"
        onAccepted: backend.importLocal([selectedFolder])
    }
    FileDialog {
        id: localFileDialog
        objectName: "localMusicFileDialog"
        Binding on parentWindow {
            when: Qt.platform.os === "windows"
            value: dialogs.hostWindow
        }
        title: "导入本地音乐文件"
        fileMode: FileDialog.OpenFiles
        nameFilters: ["音乐文件 (*.mp3 *.flac *.m4a *.mp4 *.aac *.ogg *.opus *.ape *.wav *.aiff *.aif *.wv *.wma *.mpc)"]
        onAccepted: backend.importLocal(selectedFiles)
    }
    FolderDialog {
        id: pluginFolderDialog
        objectName: "pluginFolderDialog"
        Binding on parentWindow {
            when: Qt.platform.os === "windows"
            value: dialogs.hostWindow
        }
        title: "导入插件文件夹"
        onAccepted: backend.importPluginFolder(selectedFolder)
    }
    FolderDialog {
        id: downloadFolderDialog
        objectName: "downloadFolderDialog"
        Binding on parentWindow {
            when: Qt.platform.os === "windows"
            value: dialogs.hostWindow
        }
        title: "选择下载目录"
        onAccepted: backend.setDownloadDirectory(selectedFolder)
    }
    FileDialog {
        id: decryptFileDialog
        objectName: "decryptFileDialog"
        Binding on parentWindow {
            when: Qt.platform.os === "windows"
            value: dialogs.hostWindow
        }
        title: "选择加密音乐文件"
        fileMode: FileDialog.OpenFiles
        nameFilters: ["QQ 音乐加密 / 网易云 NCM (*.mflac *.mflac0 *.mgg *.mgg0 *.mgg1 *.qmc0 *.qmcflac *.qmcogg *.ncm)"]
        onAccepted: backend.decryptLocal(selectedFiles)
    }
    FolderDialog {
        id: decryptFolderDialog
        objectName: "decryptFolderDialog"
        Binding on parentWindow {
            when: Qt.platform.os === "windows"
            value: dialogs.hostWindow
        }
        title: "选择要解密的文件夹"
        onAccepted: backend.decryptLocalFolder(selectedFolder)
    }
    FolderDialog {
        id: decryptOutFolderDialog
        objectName: "decryptOutFolderDialog"
        Binding on parentWindow {
            when: Qt.platform.os === "windows"
            value: dialogs.hostWindow
        }
        title: "选择解密输出目录"
        onAccepted: backend.setDecryptDirectory(selectedFolder)
    }
    Connections {
        target: backend
        function onLocalImportRequested(folder: bool) {
            if (folder) {
                localFolderDialog.open();
            } else {
                localFileDialog.open();
            }
        }
        function onPluginImportRequested() {
            pluginFolderDialog.open();
        }
        function onDownloadDirectoryRequested() {
            downloadFolderDialog.open();
        }
        function onDownloadDecryptRequested() {
            decryptFileDialog.open();
        }
        function onDownloadDecryptFolderRequested() {
            decryptFolderDialog.open();
        }
        function onDownloadDecryptDirectoryRequested() {
            decryptOutFolderDialog.open();
        }
    }
}
