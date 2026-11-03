import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const core = require('./core.cjs');
const service = require('./service.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));

test('qmc0 静态密码向量能还原成原始 mp3', () => {
    const raw = fs.readFileSync(path.join(here, 'fixtures/qmc0_static_raw.bin'));
    const suffix = fs.readFileSync(path.join(here, 'fixtures/qmc0_static_suffix.bin'));
    const target = fs.readFileSync(path.join(here, 'fixtures/qmc0_static_target.bin'));
    const result = core.decryptQmcFile(Buffer.concat([raw, suffix]));
    assert.equal(result.ext, 'mp3');
    assert.equal(Buffer.from(result.audio).equals(target), true);
});

test('网易云 403 节点会换成 m701/m801/m802，路径和签名保留', () => {
    const url = 'https://m804.music.126.net/song/abc.flac?authSecret=1';
    const alts = core.cdnFallbackUrls(url);
    assert.deepEqual(
        alts.map((item) => new URL(item).host),
        ['m701.music.126.net', 'm801.music.126.net', 'm802.music.126.net'],
    );
    assert.equal(new URL(alts[0]).search, '?authSecret=1');
    assert.deepEqual(core.cdnFallbackUrls('https://example.com/a'), []);
});

test('整张专辑齐了才写带 BOM 的 cue，m4a 整碟不出 cue', () => {
    const tracks = [
        { name: '一', trackNo: 1, disc: 1 },
        { name: '二', trackNo: 2, disc: 1 },
    ];
    const bundle = core.mkBundle('netease', '9', '专辑', '歌手', '2020-01-02', '', '', tracks);
    const packager = new core.AlbumPackager();
    packager.plan(bundle, tracks);
    assert.equal(packager.cueEntries(bundle, 1).length, 0);
    packager.record(bundle, { trackNo: 1, outputPath: '/tmp/专辑/01 一.flac', ext: 'flac', title: '一' });
    assert.equal(packager.cueEntries(bundle, 1).length, 0);
    packager.record(bundle, { trackNo: 2, outputPath: '/tmp/专辑/02 二.flac', ext: 'flac', title: '二' });
    const cue = core.renderCue(bundle, packager.cueEntries(bundle, 1));
    assert.equal(cue.charCodeAt(0), 0xfeff);
    assert.match(cue, /FILE "01 一.flac" FLAC\r\n/);
    assert.match(cue, /REM DATE 2020\r\n/);
    const ape = new core.AlbumPackager();
    ape.plan(bundle, tracks);
    ape.record(bundle, { trackNo: 1, outputPath: '/tmp/01 一.m4a', ext: 'm4a', title: '一' });
    ape.record(bundle, { trackNo: 2, outputPath: '/tmp/02 二.m4a', ext: 'm4a', title: '二' });
    assert.equal(core.renderCue(bundle, ape.cueEntries(bundle, 1)), null);
});

test('下载队列把直链落成文件，403 换节点失败后再走匿名', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhine-download-'));
    const server = http.createServer((request, response) => {
        if (request.url.startsWith('/deny')) {
            response.writeHead(403);
            response.end('no');
            return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(Buffer.from('audio-bytes'));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    let neteaseResolves = 0;
    const request = async (message) => {
        if (message.route === '/qq/getMusicPlay') {
            const id = message.params.songmid;
            return { body: { data: { playUrl: { [id]: { url: `${base}/qq/${id}.m4a` } } } } };
        }
        if (message.route === '/song/url/v1') {
            neteaseResolves += 1;
            const anon = !message.cookies?.MUSIC_U;
            return {
                body: {
                    data: [
                        {
                            id: Number(message.params.id),
                            url: anon ? `${base}/ok.m4a` : `${base}/deny.m4a`,
                            br: 128000,
                            type: 'mp3',
                        },
                    ],
                },
            };
        }
        if (String(message.route).endsWith('/lyrics')) {
            return {
                body: {
                    code: 200,
                    value: { lines: [{ startMs: 1000, text: '原文', translation: '译文' }], plainText: '' },
                },
            };
        }
        return { body: { code: 404, message: message.route } };
    };
    const before = new Set(service.snapshot().jobs.map((job) => job.id));
    const settings = {
        downloadDir: dir,
        quality: 'm4a',
        lyricMode: 'none',
        concurrency: 2,
        identity: 'account',
    };
    const queued = await service.handle(
        {
            route: '/native/qq/downloadEnqueue',
            params: {
                settings,
                tracks: [{ id: 'mid1', title: '晴天', artist: '周杰伦', album: '叶惠美' }],
            },
            cookies: { qqmusic_session: 'token' },
        },
        request,
    );
    assert.equal(queued.body.code, 200);
    const ne = await service.handle(
        {
            route: '/native/netease/downloadEnqueue',
            params: {
                settings: { ...settings, quality: '128' },
                tracks: [{ id: '42', title: '匿名回退', artist: '测试', album: '单曲' }],
                album: {
                    source: 'netease',
                    id: '99',
                    name: '测试专辑',
                    artist: '测试',
                    date: '2024-05-01',
                    coverUrl: '',
                    totalTracks: 1,
                },
            },
            cookies: { MUSIC_U: 'user' },
        },
        request,
    );
    assert.equal(ne.body.code, 200);
    const finished = await waitFor(request, before);
    server.close();
    const qq = finished.find((job) => job.title === '晴天');
    const anon = finished.find((job) => job.title === '匿名回退');
    assert.equal(qq.state, 'done', qq.error);
    assert.equal(fs.existsSync(qq.outputPath), true);
    assert.equal(path.basename(qq.outputPath), '晴天 - 周杰伦.m4a');
    assert.equal(anon.state, 'done', anon.error);
    assert.equal(anon.anonFallback, true);
    assert.equal(fs.existsSync(anon.outputPath), true);
    assert.match(anon.outputPath, /测试 - 测试专辑 \(2024\)/);
    assert.equal(fs.existsSync(path.join(path.dirname(anon.outputPath), 'album.cue')), false);
    assert.ok(neteaseResolves >= 3);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('QQ 加密文件解密后落盘，无法识别的扩展名记失败', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhine-unlock-'));
    const raw = fs.readFileSync(path.join(here, 'fixtures/qmc0_static_raw.bin'));
    const suffix = fs.readFileSync(path.join(here, 'fixtures/qmc0_static_suffix.bin'));
    const encrypted = path.join(dir, '周杰伦 - 晴天.qmc0');
    fs.writeFileSync(encrypted, Buffer.concat([raw, suffix]));
    const plain = path.join(dir, 'note.txt');
    fs.writeFileSync(plain, 'no');
    const request = async (message) => {
        if (String(message.route).endsWith('/search')) {
            return { body: { code: 200, value: { items: [] } } };
        }
        return { body: { code: 200, value: null } };
    };
    const before = new Set(service.snapshot().jobs.map((job) => job.id));
    const result = await service.handle(
        {
            route: '/native/qq/downloadUnlock',
            params: { settings: { downloadDir: dir, lyricMode: 'none' }, files: [encrypted, plain] },
            cookies: {},
        },
        request,
    );
    assert.equal(result.body.code, 200);
    const started = Date.now();
    let jobs = [];
    for (;;) {
        jobs = service.snapshot().jobs.filter((job) => !before.has(job.id));
        if (jobs.length === 2 && jobs.every((job) => job.state === 'done' || job.state === 'failed')) {
            break;
        }
        if (Date.now() - started > 5000) {
            throw new Error(`解密没有结束 ${JSON.stringify(jobs)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const decrypted = jobs.find((job) => job.outputPath);
    const failed = jobs.find((job) => job.state === 'failed');
    assert.equal(decrypted.state, 'done');
    assert.equal(decrypted.error, '搜索未命中，仅解密');
    assert.equal(fs.existsSync(decrypted.outputPath), true);
    assert.equal(path.extname(decrypted.outputPath), '.mp3');
    assert.match(failed.error, /不支持的扩展名/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('NCM 密钥段 AES 向量与 ncmc 一致', () => {
    const input = Buffer.from([
        44, 206, 213, 235, 105, 234, 251, 20, 85, 13, 69, 191, 97, 221, 23, 29, 18, 21, 246, 51, 21, 69, 239,
        181, 244, 6, 32, 104, 211, 135, 179, 202, 61, 32, 50, 218, 231, 3, 85, 33, 145, 113, 162, 72, 254, 143,
        136, 190, 39, 101, 206, 78, 98, 101, 116, 215, 145, 212, 45, 190, 39, 210, 209, 192, 188, 100, 141, 243,
        48, 248, 186, 138, 64, 32, 93, 82, 40, 16, 113, 0, 51, 165, 195, 243, 34, 188, 96, 243, 168, 178, 144, 252,
        165, 149, 122, 109, 247, 164, 233, 37, 82, 40, 214, 0, 159, 5, 178, 114, 243, 218, 126, 60, 20, 5, 164,
        198, 166, 244, 88, 15, 95, 132, 197, 175, 252, 215, 77, 30,
    ]);
    const key = core.decryptNcmKeyBlock(input);
    assert.equal(
        Buffer.from(key).toString('utf8'),
        '143621215014397E7fT49x7dof9OKCgg9cdvhEuezy3iZCL1nFvBFd1T4uSktAJKmwZXsijPbijliionVUXXg9plTbXEclAE9Lb',
    );
});

test('makeBundle 多碟懒加载只抬高整辑 totalTracks，不污染各碟 discTotals', () => {
    const tracks = [
        { id: '1', name: '碟一', artist: '歌手', disc: 1, trackNo: 1 },
        { id: '2', name: '碟二', artist: '歌手', disc: 2, trackNo: 1 },
    ];
    const bundle = service.makeBundle(
        { source: 'netease', id: '9', name: '双碟', artist: '歌手', totalTracks: 30 },
        tracks,
    );
    assert.equal(bundle.totalTracks, 30);
    assert.equal(bundle.partialBatch, true);
    assert.equal(bundle.discTotals[1], 1);
    assert.equal(bundle.discTotals[2], 1);
});

test('partialBatch 阻止多碟残缺 album.cue', () => {
    const tracks = [
        { id: '1', name: '碟一', artist: '歌手', disc: 1, trackNo: 1 },
        { id: '2', name: '碟二', artist: '歌手', disc: 2, trackNo: 1 },
    ];
    const bundle = service.makeBundle(
        { source: 'netease', id: '9', name: '双碟', artist: '歌手', totalTracks: 30 },
        tracks,
    );
    const packager = new core.AlbumPackager();
    packager.plan(bundle, tracks);
    packager.record(bundle, {
        trackNo: 1,
        outputPath: '/tmp/CD01/01 碟一.flac',
        ext: 'flac',
        title: '碟一',
    });
    packager.record(bundle, {
        trackNo: 1,
        outputPath: '/tmp/CD02/01 碟二.flac',
        ext: 'flac',
        title: '碟二',
    });
    assert.equal(packager.cueEntries(bundle, 1).length, 0);
    assert.equal(packager.cueEntries(bundle, 2).length, 0);
});

test('NCM 内嵌封面写入前转为 Buffer', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x11, 0x22, 0x33]);
    const asUint = Uint8Array.from(jpeg);
    const fromBuffer = service.coverBytes(jpeg);
    const fromUint = service.coverBytes(asUint);
    assert.equal(Buffer.isBuffer(fromBuffer), true);
    assert.equal(Buffer.isBuffer(fromUint), true);
    assert.equal(fromUint.equals(jpeg), true);
});

test('解锁任务登记 specs，失败后可重试', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhine-unlock-retry-'));
    const bad = path.join(dir, 'missing.ncm');
    const settings = { downloadDir: dir, decryptDir: dir, lyricMode: 'none', concurrency: 1 };
    const request = async () => ({ body: { code: 404 } });
    const started = await service.handle(
        {
            route: '/native/qq/downloadUnlock',
            params: { settings, files: [bad] },
            cookies: {},
        },
        request,
    );
    assert.equal(started.body.code, 200);
    const deadline = Date.now() + 5000;
    let failed;
    for (;;) {
        failed = service.snapshot().jobs.find(
            (job) => job.source === 'unlock' && job.title === 'missing.ncm' && job.state === 'failed',
        );
        if (failed || Date.now() > deadline) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(failed);
    const retried = await service.handle(
        { route: '/native/qq/downloadRetry', params: { id: failed.id }, cookies: {} },
        request,
    );
    assert.equal(retried.body.code, 200);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('解密目录扫描与分平台下载身份', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhine-unlock-dir-'));
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'a.ncm'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'skip');
    const request = async () => ({ body: { code: 200, value: { items: [] } } });
    const started = await service.handle(
        {
            route: '/native/netease/downloadUnlock',
            params: { directories: [dir], settings: { decryptDir: dir } },
            cookies: {},
        },
        request,
    );
    assert.equal(started.body.code, 200);
    assert.ok(started.body.value.jobs.some((job) => job.title === 'a.ncm'));

    const enqueued = await service.handle(
        {
            route: '/native/qq/downloadEnqueue',
            params: {
                tracks: [{ id: 'mid', name: 't', artist: 'a', kind: 'song' }],
                settings: { qqIdentity: 'anon', neIdentity: 'account' },
            },
            cookies: { qqmusic_session: 'x' },
        },
        async (message) => {
            if (message.route === '/qq/getSongInfo') {
                return {
                    body: {
                        songinfo: {
                            data: {
                                track_info: {
                                    file: { size_128mp3: 1 },
                                },
                            },
                        },
                    },
                };
            }
            if (message.route === '/qq/getMusicPlay') {
                return {
                    body: { data: { playUrl: { mid: { url: 'http://127.0.0.1/1.mp3' } } } },
                };
            }
            return { body: { code: 404 } };
        },
    );
    assert.equal(enqueued.body.code, 200);
    fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(request, before) {
    const started = Date.now();
    for (;;) {
        const snap = await service.handle({ route: '/native/qq/downloadSnapshot', params: {} }, request);
        const jobs = snap.body.value.jobs.filter((job) => !before.has(job.id));
        if (
            jobs.length >= 2 &&
            jobs.every((job) => job.state === 'done' || job.state === 'failed' || job.state === 'cancelled')
        ) {
            return jobs;
        }
        if (Date.now() - started > 20000) {
            throw new Error(`下载没有在时限内结束 ${JSON.stringify(jobs)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
}
