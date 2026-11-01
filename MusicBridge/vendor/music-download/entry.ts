/** 供 esbuild 打成 download/core.cjs。逻辑来自音乐下载器，运行时不依赖 Electron。 */
export { safeName, uniquePath, ensureDir } from './fsUtils'
export {
    mkBundle,
    normalizeDate,
    discOf,
    qqAlbumCoverUrl,
    albumDirName,
    albumRootDir,
    albumTrackDir,
    trackPad,
    trackBaseName,
    trackFileName,
} from './albumBundle'
export { renderCue, albumKey, AlbumPackager } from './albumPackaging'
export { mergeLyricTranslation, formatLrcTime, parseLrcLine } from './lyricMerge'
export { cdnFallbackUrls, isNeteaseCdnUrl, NE_CDN_NODES } from './neteaseapi/cdn'
export { downloadFile, DownloadHttpError } from './downloader/file'
export { DownloadQueue } from './downloader/queue'
export { RateLimiter } from './downloader/ratelimit'
export { tagFile } from './tagger/index'
export { decryptQmcFile } from './unlock/decrypt'
export {
  decryptNcmFile,
  decryptNcmKeyBlock,
  decryptNcmMetaBlock,
  parseNcmMetaJson,
} from './unlock/ncm'
