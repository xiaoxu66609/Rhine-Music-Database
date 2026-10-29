# 下载管线来源

`MusicBridge/vendor/music-download` 与 `MusicBridge/download/core.cjs` 来自
[music-download](https://github.com/xiaoxu66609/music-download) 的主进程实现
（队列、限速、直链落盘、网易云 CDN 节点替换、歌词合并、专辑目录 / cue、
MP3 / FLAC 标签、QQ 音乐加密文件解密）。

解密算法移植自 [UnlockMusicProject_Archive](https://github.com/showhwa/UnlockMusicProject_Archive)。
MP3 标签通过 [node-id3](https://github.com/Zazama/node-id3)（MIT）写入，已打进 `core.cjs`。

Rhine 不使用该项目的 Electron / Vue 界面。登录、搜索和歌单仍走 Rhine 自己的桥接；
这里只负责把已经拿到的曲目写成带标签的文件。

重新生成核心包（在仓库根目录，需能解析 `node-id3`）：

```sh
npm install --prefix MusicBridge/vendor/music-download node-id3@0.2.6
npx esbuild MusicBridge/vendor/music-download/entry.ts \
  --bundle --platform=node --format=cjs \
  --outfile=MusicBridge/download/core.cjs
rm -rf MusicBridge/vendor/music-download/node_modules \
  MusicBridge/vendor/music-download/package.json \
  MusicBridge/vendor/music-download/package-lock.json
```
