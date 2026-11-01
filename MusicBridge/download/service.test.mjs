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
    assert.equal(bundle.discTotals[1], 1);
    assert.equal(bundle.discTotals[2], 1);
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
