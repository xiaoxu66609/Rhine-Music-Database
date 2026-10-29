const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./core.cjs');

const QQ_LADDER = ['flac', 'ape', '320', '128', 'm4a'];
const NE_LADDER = ['flac', '320', '128'];
const QUALITIES = new Set(QQ_LADDER);
const LYRIC_MODES = new Set(['both', 'embed', 'lrc', 'none']);
const QMC_EXTS = new Set(['.mflac', '.mflac0', '.mgg', '.mgg0', '.mgg1', '.qmc0', '.qmcflac', '.qmcogg']);
const EXT_OF = { flac: 'flac', ape: 'ape', 320: 'mp3', 128: 'mp3', m4a: 'm4a' };

const settings = {
    downloadDir: path.join(os.homedir(), 'Music', 'Rhine'),
    decryptDir: '',
    quality: 'flac',
    lyricMode: 'both',
    concurrency: 2,
    identity: 'account',
};

const jobs = [];
const specs = new Map();
const coversWritten = new Set();
const packager = new core.AlbumPackager();
const rateLimiter = new core.RateLimiter(1000);
let jobSeq = 0;
let dispatchRequest = async () => ({ body: { code: 503, message: '下载服务尚未接上音乐桥' } });

const queue = new core.DownloadQueue({
    concurrency: settings.concurrency,
    rateLimiter: new core.RateLimiter(0),
    runner: (job, report, signal) => runJob(job, report, signal),
});

queue.on('jobDone', (job) => {
    writeAlbumExtras(job).catch(() => {});
});

function applySettings(patch) {
    if (!patch || typeof patch !== 'object') {
        return;
    }
    if (typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) {
        settings.downloadDir = patch.downloadDir.trim();
    }
    if (typeof patch.decryptDir === 'string') {
        settings.decryptDir = patch.decryptDir.trim();
    }
    if (QUALITIES.has(patch.quality)) {
        settings.quality = patch.quality;
    }
    if (LYRIC_MODES.has(patch.lyricMode)) {
        settings.lyricMode = patch.lyricMode;
    }
    if (patch.identity === 'account' || patch.identity === 'anon') {
        settings.identity = patch.identity;
    }
    const concurrency = Number(patch.concurrency);
    if (Number.isFinite(concurrency)) {
        settings.concurrency = Math.min(4, Math.max(1, Math.floor(concurrency)));
        queue.setConcurrency(settings.concurrency);
    }
}

function providerOf(route) {
    const part = String(route || '').split('/')[2];
    if (part === 'qq' || part === 'netease' || part === 'kugou') {
        return part;
    }
    return 'netease';
}

function cookiesFor(provider, cookies, identity) {
    const source = { ...(cookies || {}) };
    if (identity !== 'anon') {
        return source;
    }
    if (provider === 'qq') {
        delete source.qqmusic_session;
        delete source.__qqSessions;
        return source;
    }
    if (provider === 'kugou') {
        delete source.__kugou;
        return source;
    }
    return {};
}

function publicJob(job) {
    return {
        id: job.id,
        source: job.source,
        title: job.track?.name || job.title || '',
        artist: job.track?.artist || job.artist || '',
        state: job.state,
        progress: job.progress || 0,
        error: job.error || '',
        outputPath: job.outputPath || '',
        downgraded: !!job.downgraded,
        finalQuality: job.finalQuality || '',
        anonFallback: !!job.anonFallback,
        album: job.album?.name || '',
    };
}

function snapshot() {
    return {
        jobs: jobs.map(publicJob),
        active: jobs.filter((job) => job.state === 'queued' || job.state === 'running').length,
        settings: {
            downloadDir: settings.downloadDir,
            decryptDir: settings.decryptDir || settings.downloadDir,
            quality: settings.quality,
            lyricMode: settings.lyricMode,
            concurrency: settings.concurrency,
            identity: settings.identity,
        },
    };
}

function ok(value) {
    return { body: { code: 200, value }, cookies: [] };
}

function fail(message) {
    return { body: { code: 400, message, value: snapshot() }, cookies: [] };
}

function trimJobs() {
    while (jobs.length > 500) {
        const index = jobs.findIndex((job) => job.state !== 'queued' && job.state !== 'running');
        if (index < 0) {
            break;
        }
        const [removed] = jobs.splice(index, 1);
        specs.delete(removed.id);
    }
}

function normalizeTrack(raw, index, albumMode) {
    const trackNo = Number(raw.trackNo);
    const disc = Number(raw.disc);
    const track = {
        id: String(raw.id || ''),
        name: String(raw.name || raw.title || '未命名'),
        title: String(raw.title || raw.name || '未命名'),
        artist: String(raw.artist || '未知歌手'),
        album: String(raw.album || ''),
        cover: String(raw.cover || ''),
        mediaId: String(raw.mediaId || ''),
        duration: Number(raw.duration || 0),
        albumID: raw.albumID || '',
        albumAudioID: raw.albumAudioID || 0,
        vip: raw.vip === true,
        vipQuality: raw.vipQuality === true,
        kind: 'song',
        date: typeof raw.date === 'string' ? raw.date : '',
    };
    if (albumMode) {
        track.trackNo = Number.isInteger(trackNo) && trackNo > 0 ? trackNo : index + 1;
        track.disc = Number.isInteger(disc) && disc > 0 ? disc : 1;
    }
    return track;
}

function makeBundle(album, tracks) {
    if (!album || typeof album !== 'object' || !album.id) {
        return undefined;
    }
    const source = album.source === 'qq' || album.source === 'kugou' ? album.source : 'netease';
    const cover =
        source === 'qq'
            ? core.qqAlbumCoverUrl(String(album.id)) || String(album.coverUrl || '')
            : String(album.coverUrl || '');
    const bundle = core.mkBundle(
        source,
        String(album.id),
        String(album.name || album.title || ''),
        String(album.artist || ''),
        core.normalizeDate(album.date),
        String(album.company || ''),
        cover,
        tracks,
    );
    const declared = Number(album.totalTracks);
    if (Number.isFinite(declared) && declared > bundle.totalTracks) {
        bundle.totalTracks = declared;
        if (bundle.discs.length === 1) {
            bundle.discTotals[bundle.discs[0]] = declared;
        } else {
            for (const disc of bundle.discs) {
                bundle.discTotals[disc] = (bundle.discTotals[disc] || 0) + declared;
            }
        }
    }
    return bundle;
}

function qualityFromPrefix(prefix) {
    switch (prefix) {
        case 'F000':
            return 'flac';
        case 'A000':
            return 'ape';
        case 'M800':
            return '320';
        case 'M500':
            return '128';
        case 'C400':
        case 'C200':
            return 'm4a';
        default:
            return undefined;
    }
}

function qualityFromUrl(url, fallback) {
    try {
        const name = new URL(url).pathname.split('/').pop() || '';
        return qualityFromPrefix(name.slice(0, 4)) || fallback;
    } catch {
        return fallback;
    }
}

function qualityFromBr(br) {
    const value = Number(br);
    if (!Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    if (value >= 900000) {
        return 'flac';
    }
    if (value >= 256000) {
        return '320';
    }
    return '128';
}

function ladderIndex(ladder, quality) {
    const index = ladder.indexOf(quality);
    return index < 0 ? ladder.length : index;
}

function extOf(quality, url) {
    try {
        const suffix = new URL(url).pathname.split('.').pop().toLowerCase();
        if (['flac', 'ape', 'mp3', 'm4a', 'ogg'].includes(suffix)) {
            return suffix;
        }
    } catch {
        /* 没有路径后缀时用档位表 */
    }
    return EXT_OF[quality] || 'mp3';
}

function isHttp(error, status) {
    return (
        (error instanceof core.DownloadHttpError && error.status === status) ||
        (error instanceof Error && error.message.includes(`HTTP ${status}`))
    );
}

function playEntry(body, id) {
    const map = body?.data?.playUrl || body?.playUrl;
    if (!map || typeof map !== 'object') {
        return null;
    }
    if (map[id]) {
        return map[id];
    }
    const values = Object.values(map);
    return values.find((entry) => entry && entry.url) || values[0] || null;
}

async function resolveQq(track, preferred, cookies) {
    const target = QQ_LADDER.includes(preferred) ? preferred : 'flac';
    const order = QQ_LADDER.slice(QQ_LADDER.indexOf(target));
    let last = '';
    for (const quality of order) {
        await rateLimiter.wait();
        const response = await dispatchRequest({
            route: '/qq/getMusicPlay',
            params: { songmid: track.id, mediaId: track.mediaId || '', quality },
            cookies,
        });
        const body = response?.body || {};
        if (body.code === 401) {
            throw new Error('QQ 登录已过期（接口已失效，故直链取不到）。请重新登录后重试');
        }
        const entry = playEntry(body, track.id);
        if (entry?.url) {
            const actual = qualityFromUrl(entry.url, quality);
            return {
                url: entry.url,
                quality: actual,
                downgraded: ladderIndex(QQ_LADDER, actual) > ladderIndex(QQ_LADDER, target),
            };
        }
        last =
            entry?.restriction?.hint?.message ||
            (typeof entry?.error === 'string' ? entry.error : '') ||
            body.message ||
            '';
    }
    if (track.vip || track.vipQuality) {
        throw new Error(
            `付费/会员歌曲下载不了：当前账号无该曲下载权限（需 QQ 音乐绿钻/豪华绿钻或单独购买）${last ? `；${last}` : ''}`,
        );
    }
    throw new Error(
        `该曲未拿到可播放 URL：服务端未提供任何档位的下载直链（与所选档位无关，多因版权方未开放下载、仅授权在线试听）${last ? `；${last}` : ''}`,
    );
}

async function resolveNetease(track, preferred, cookies) {
    const id = Number(track.id);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error(`非法的网易云歌曲 ID: ${track.id}`);
    }
    const target = NE_LADDER.includes(preferred) ? preferred : 'flac';
    const levels = { flac: 'lossless', 320: 'exhigh', 128: 'standard' };
    let last = '';
    for (let index = NE_LADDER.indexOf(target); index < NE_LADDER.length; index += 1) {
        const quality = NE_LADDER[index];
        await rateLimiter.wait();
        const response = await dispatchRequest({
            route: '/song/url/v1',
            params: { id: String(id), level: levels[quality] },
            cookies,
        });
        const body = response?.body || {};
        const rows = Array.isArray(body.data) ? body.data : [];
        const row = rows.find((song) => String(song.id) === String(id)) || rows[0];
        if (row?.url && /^https?:\/\//.test(row.url)) {
            const actual =
                qualityFromBr(row.br) || (String(row.type || '').toLowerCase() === 'flac' ? 'flac' : quality);
            return {
                url: row.url,
                quality: actual,
                downgraded: ladderIndex(NE_LADDER, actual) > NE_LADDER.indexOf(target),
            };
        }
        last = body.message || body.msg || '';
    }
    const message =
        last ||
        (cookies.MUSIC_U
            ? '未拿到可播放 URL（可能无版权/未上架，或账号无对应权益）'
            : '未拿到可播放 URL（匿名仅可下普通歌；此歌可能需登录）');
    if (track.vip || track.vipQuality) {
        throw new Error('付费/会员歌曲下载不了：当前账号无该曲权限（需网易云会员或单独购买）');
    }
    throw new Error(message);
}

async function resolveKugou(track, preferred, cookies) {
    const target = preferred === '320' || preferred === '128' ? preferred : 'flac';
    const level = { flac: 'lossless', 320: 'exhigh', 128: 'standard' }[target];
    await rateLimiter.wait();
    const response = await dispatchRequest({
        route: '/native/kugou/playback',
        params: { args: [{ ...track, id: track.id }, level, false] },
        cookies,
    });
    const body = response?.body || {};
    const value = body.value;
    if (!value?.url) {
        throw new Error(body.message || '酷狗未返回可播放地址，请确认账号登录及歌曲权限');
    }
    const ext = String(value.extName || '').toLowerCase();
    let actual = target;
    if (ext === 'flac') {
        actual = 'flac';
    } else if (ext === 'ape') {
        actual = 'ape';
    } else if (ext === 'm4a' || ext === 'aac') {
        actual = 'm4a';
    } else if (ext === 'mp3') {
        actual = Number(value.br) >= 256 ? '320' : '128';
    }
    const fallback = value.qualityFallback ? (actual === 'flac' ? '320' : actual) : actual;
    return {
        url: value.url,
        quality: value.qualityFallback ? fallback : actual,
        downgraded:
            !!value.qualityFallback || ladderIndex(QQ_LADDER, actual) > ladderIndex(QQ_LADDER, target),
    };
}

async function resolve(job, cookies) {
    if (job.source === 'qq') {
        return resolveQq(job.track, job.quality, cookies);
    }
    if (job.source === 'kugou') {
        return resolveKugou(job.track, job.quality, cookies);
    }
    return resolveNetease(job.track, job.quality, cookies);
}

function reserveDest(job, extension) {
    const bundle = job.album;
    const dir = bundle
        ? core.albumTrackDir(settings.downloadDir, bundle, job.track.disc ?? bundle.discs[0] ?? 1)
        : settings.downloadDir;
    const name = bundle
        ? core.trackBaseName(job.track, core.trackPad(bundle))
        : `${core.safeName(job.track.name)} - ${core.safeName(job.track.artist)}`;
    fs.mkdirSync(dir, { recursive: true });
    let dest = core.uniquePath(path.join(dir, `${name}.${extension}`));
    for (;;) {
        try {
            fs.closeSync(fs.openSync(dest, 'wx'));
            return dest;
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            dest = core.uniquePath(dest);
        }
    }
}

function formatLrcTime(ms) {
    const minute = Math.floor(ms / 60000);
    const second = Math.floor((ms % 60000) / 1000);
    const rest = Math.round(ms % 1000);
    const head = `${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    if (rest % 10 !== 0) {
        return `[${head}.${String(rest).padStart(3, '0')}]`;
    }
    return `[${head}.${String(rest / 10).padStart(2, '0')}]`;
}

function lyricsToLrc(document) {
    if (!document || typeof document !== 'object') {
        return '';
    }
    const lines = Array.isArray(document.lines) ? document.lines : [];
    if (!lines.length) {
        return String(document.plainText || '');
    }
    const out = [];
    for (const line of lines) {
        const stamp = formatLrcTime(Number(line.startMs) || 0);
        const text = String(line.text || '');
        out.push(`${stamp}${text}`);
        const translation = String(line.translation || '').trim();
        if (translation && translation !== text.trim()) {
            out.push(`${stamp}${translation}`);
        }
    }
    return out.join('\n');
}

async function fetchLyrics(job, cookies) {
    try {
        const response = await dispatchRequest({
            route: `/native/${job.source}/lyrics`,
            params: { args: [job.track] },
            cookies,
        });
        const body = response?.body || {};
        if (body.code && body.code !== 200) {
            return '';
        }
        return lyricsToLrc(body.value);
    } catch {
        return '';
    }
}

function sniffImageMime(buffer) {
    if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
        return 'image/png';
    }
    return 'image/jpeg';
}

async function fetchCover(url, signal) {
    if (!url) {
        return undefined;
    }
    try {
        const timeout = AbortSignal.timeout(20000);
        const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) {
            try {
                await response.body?.cancel();
            } catch {
                /* 封面失败不挡住歌曲 */
            }
            return undefined;
        }
        const data = Buffer.from(await response.arrayBuffer());
        if (!data.length || data.length > 15 * 1024 * 1024) {
            return undefined;
        }
        return { data, mime: sniffImageMime(data) };
    } catch {
        return undefined;
    }
}

async function downloadResolved(job, resolved, report, signal, cookies) {
    if (/\.m3u8?(\?|$)/i.test(resolved.url)) {
        throw new Error('平台返回的是流媒体播放列表，不是可保存的音频文件');
    }
    const ext = extOf(resolved.quality, resolved.url);
    const dest = reserveDest(job, ext);
    const altUrls = job.source === 'netease' ? (url) => core.cdnFallbackUrls(url) : undefined;
    try {
        await core.downloadFile(resolved.url, dest, {
            retries: 2,
            signal,
            altUrls,
            onProgress: (got, total) => {
                report(total > 0 ? Math.round((got / total) * 100) : Math.min(99, Math.round(got / 1e6)));
            },
        });
    } catch (error) {
        fs.rmSync(dest, { force: true });
        throw error;
    }
    if (signal?.aborted) {
        return { outputPath: dest };
    }
    const lyricMode = job.lyricMode || settings.lyricMode;
    const canTag = ext === 'mp3' || ext === 'flac';
    const wantLrc = lyricMode === 'both' || lyricMode === 'lrc';
    const lrcPath = dest.slice(0, -(ext.length + 1)) + '.lrc';
    try {
        const lyrics = lyricMode === 'none' ? '' : await fetchLyrics(job, cookies);
        if (canTag) {
            const embed = lyricMode === 'both' || lyricMode === 'embed';
            const cover = await fetchCover(job.track.cover, signal);
            if (signal?.aborted) {
                return { outputPath: dest };
            }
            await core.tagFile(
                dest,
                {
                    title: job.track.name,
                    artist: job.track.artist,
                    album: job.track.album || '未知专辑',
                    date: job.track.date || '',
                    copyright: '',
                    genre: '',
                    lyrics: embed ? lyrics : '',
                    track: job.album ? job.track.trackNo : undefined,
                    trackTotal: job.album ? job.album.totalTracks : undefined,
                    disc: job.album ? (job.track.disc ?? job.album.discs[0]) : undefined,
                    discTotal: job.album && job.album.discs.length > 1 ? job.album.discs.length : undefined,
                    cover: cover?.data,
                    coverMime: cover?.mime,
                },
                { saveLrc: false },
            );
        }
        if (wantLrc && lyrics) {
            fs.writeFileSync(lrcPath, lyrics, 'utf8');
        }
    } catch (error) {
        fs.rmSync(dest, { force: true });
        fs.rmSync(lrcPath, { force: true });
        throw error;
    }
    return { outputPath: dest };
}

async function runDownload(job, cookies, report, signal) {
    let resolved = await resolve(job, cookies);
    job.downgraded = resolved.downgraded;
    job.finalQuality = resolved.quality;
    try {
        return await downloadResolved(job, resolved, report, signal, cookies);
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        resolved = await resolve(job, cookies);
        job.downgraded = resolved.downgraded;
        job.finalQuality = resolved.quality;
        return downloadResolved(job, resolved, report, signal, cookies);
    }
}

async function runJob(job, report, signal) {
    const account = job.identity !== 'anon';
    try {
        return await runDownload(job, job.cookies, report, signal);
    } catch (error) {
        if (!(account && job.source === 'netease' && isHttp(error, 403))) {
            throw error;
        }
        job.anonFallback = true;
        return runDownload(job, {}, report, signal);
    }
}

async function writeAlbumExtras(job) {
    const bundle = job.album;
    if (!bundle || !job.outputPath) {
        return;
    }
    const key = core.albumKey(bundle);
    if (!coversWritten.has(key) && bundle.coverUrl) {
        const cover = await fetchCover(bundle.coverUrl);
        if (cover) {
            const ext = cover.mime === 'image/png' ? 'png' : 'jpg';
            const root = core.albumRootDir(settings.downloadDir, bundle);
            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(path.join(root, `cover.${ext}`), cover.data);
            coversWritten.add(key);
        }
    }
    const extension = path.extname(job.outputPath).slice(1);
    const discs = packager.record(bundle, {
        trackNo: job.track.trackNo ?? 1,
        outputPath: job.outputPath,
        ext: extension,
        title: job.track.name,
    });
    for (const disc of discs) {
        const text = core.renderCue(bundle, packager.cueEntries(bundle, disc));
        if (!text) {
            continue;
        }
        const dir = core.albumTrackDir(settings.downloadDir, bundle, disc);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'album.cue'), text, 'utf8');
    }
}

function enqueue(provider, params, cookies) {
    applySettings(params.settings);
    const rawTracks = Array.isArray(params.tracks) ? params.tracks : [];
    const albumMode = !!params.album;
    const seen = new Set();
    const tracks = [];
    for (const raw of rawTracks) {
        const track = normalizeTrack(raw, tracks.length, albumMode);
        if (!track.id || seen.has(track.id)) {
            continue;
        }
        seen.add(track.id);
        tracks.push(track);
    }
    if (!tracks.length) {
        return fail('没有可以下载的曲目');
    }
    const quality = QUALITIES.has(params.quality) ? params.quality : settings.quality;
    const lyricMode = LYRIC_MODES.has(params.lyricMode) ? params.lyricMode : settings.lyricMode;
    const identity =
        params.identity === 'anon' || params.identity === 'account' ? params.identity : settings.identity;
    const album = albumMode ? makeBundle(params.album, tracks) : undefined;
    const created = [];
    for (const track of tracks) {
        const id = `${provider}:${track.id}:${++jobSeq}`;
        const job = {
            id,
            source: provider,
            track,
            quality,
            lyricMode,
            album,
            identity,
            cookies: cookiesFor(provider, cookies, identity),
            state: 'queued',
            progress: 0,
        };
        specs.set(id, job);
        jobs.push(job);
        created.push(job);
    }
    trimJobs();
    if (album) {
        packager.plan(
            album,
            created.map((job) => job.track),
        );
    }
    queue.enqueue(created);
    return ok(snapshot());
}

function cancel(id) {
    const removed = queue.cancel(String(id || ''));
    if (!removed) {
        return fail('该任务不在队列中');
    }
    return ok(snapshot());
}

function retry(id) {
    const spec = specs.get(String(id || ''));
    if (!spec) {
        return fail('找不到该任务记录（重启后记录清空），请重新选择下载');
    }
    if (queue.has(spec.id)) {
        return fail('该任务已在队列中');
    }
    const job = {
        ...spec,
        state: 'queued',
        progress: 0,
        error: undefined,
        outputPath: undefined,
        downgraded: false,
        anonFallback: false,
    };
    specs.set(job.id, job);
    const index = jobs.findIndex((entry) => entry.id === job.id);
    if (index >= 0) {
        jobs.splice(index, 1);
    }
    jobs.push(job);
    queue.enqueue([job]);
    return ok(snapshot());
}

async function searchQq(fileBase, cookies) {
    const parts = fileBase
        .split(/\s+-\s+/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (parts.length < 2) {
        return null;
    }
    const response = await dispatchRequest({
        route: '/native/qq/search',
        params: { args: [`${parts[0]} ${parts.slice(1).join(' ')}`, 'song', 0] },
        cookies,
    });
    const item = response?.body?.value?.items?.[0];
    if (!item?.id) {
        return null;
    }
    return normalizeTrack(item, 0, false);
}

function startUnlock(params, cookies) {
    applySettings(params.settings);
    const files = Array.isArray(params.files) ? params.files.map((file) => String(file)) : [];
    if (!files.length) {
        return fail('没有选择文件');
    }
    const batch = files.map((file) => {
        const base = path.basename(file);
        const job = {
            id: `unlock:${++jobSeq}`,
            source: 'unlock',
            title: base,
            artist: '',
            track: { name: base, artist: '' },
            state: 'queued',
            progress: 0,
            file,
        };
        jobs.push(job);
        return job;
    });
    trimJobs();
    setImmediate(() => {
        processUnlock(batch, cookies).catch((error) => {
            for (const job of batch) {
                if (job.state === 'queued' || job.state === 'running') {
                    job.state = 'failed';
                    job.error = error instanceof Error ? error.message : String(error);
                }
            }
        });
    });
    return ok(snapshot());
}

async function processUnlock(batch, cookies) {
    const outDir = settings.decryptDir || settings.downloadDir;
    fs.mkdirSync(outDir, { recursive: true });
    for (const job of batch) {
        const file = job.file;
        job.state = 'running';
        const ext = path.extname(file).toLowerCase();
        const base = path.basename(file);
        if (!QMC_EXTS.has(ext)) {
            job.state = 'failed';
            job.error = `不支持的扩展名 ${ext || '（无）'}`;
            continue;
        }
        let decrypted;
        try {
            decrypted = core.decryptQmcFile(fs.readFileSync(file));
        } catch (error) {
            job.state = 'failed';
            job.error = error instanceof Error ? error.message : String(error);
            continue;
        }
        const stem = base.slice(0, -ext.length);
        let track = null;
        if (decrypted.ext === 'flac' || decrypted.ext === 'mp3') {
            try {
                track = await searchQq(stem, cookiesFor('qq', cookies, 'account'));
            } catch {
                track = null;
            }
        }
        const outName = track
            ? `${core.safeName(track.name)} - ${core.safeName(track.artist)}.${decrypted.ext}`
            : `${core.safeName(stem)}.${decrypted.ext}`;
        const outputPath = core.uniquePath(path.join(outDir, outName));
        fs.writeFileSync(outputPath, decrypted.audio);
        job.outputPath = outputPath;
        job.track = track || { name: stem, artist: '' };
        job.title = job.track.name;
        job.artist = job.track.artist || '';
        if (!track) {
            job.state = 'done';
            job.progress = 100;
            job.error = '搜索未命中，仅解密';
            continue;
        }
        try {
            const lyricMode = settings.lyricMode;
            const lyrics = lyricMode === 'none' ? '' : await fetchLyrics({ source: 'qq', track }, cookies);
            const embed = lyricMode === 'both' || lyricMode === 'embed';
            const cover = await fetchCover(track.cover);
            await core.tagFile(
                outputPath,
                {
                    title: track.name,
                    artist: track.artist,
                    album: track.album || '未知专辑',
                    date: track.date || '',
                    copyright: '',
                    genre: '',
                    lyrics: embed ? lyrics : '',
                    cover: cover?.data,
                    coverMime: cover?.mime,
                },
                { saveLrc: false },
            );
            if ((lyricMode === 'both' || lyricMode === 'lrc') && lyrics) {
                fs.writeFileSync(outputPath.slice(0, -(decrypted.ext.length + 1)) + '.lrc', lyrics, 'utf8');
            }
            job.state = 'done';
            job.progress = 100;
            job.error = '';
        } catch (error) {
            job.state = 'done';
            job.progress = 100;
            job.error = `补全失败：${error instanceof Error ? error.message : String(error)}`;
        }
    }
}

async function handle(message, request) {
    dispatchRequest = request;
    const operation = String(message.route || '').split('/')[3];
    const provider = providerOf(message.route);
    const params = message.params || {};
    applySettings(params.settings);
    if (operation === 'downloadSnapshot' || operation === 'downloadConfigure') {
        return ok(snapshot());
    }
    if (operation === 'downloadEnqueue') {
        return enqueue(provider, params, message.cookies || {});
    }
    if (operation === 'downloadCancel') {
        return cancel(params.id);
    }
    if (operation === 'downloadRetry') {
        return retry(params.id);
    }
    if (operation === 'downloadUnlock') {
        return startUnlock(params, message.cookies || {});
    }
    return fail('不支持的下载操作');
}

module.exports = { handle, snapshot, settings };
