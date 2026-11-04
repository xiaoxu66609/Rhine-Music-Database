// ffmpeg.org 的发布包在 CI 上会遇到 curl 35（连接被对端重置）。
// curl 默认的 --retry 只重试超时和少数 HTTP 状态，不包含这类错误，
// 所以这里显式打开 --retry-all-errors，并在下载仍失败时改克隆锁定的 tag。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function releaseCurlArguments(url, destination) {
    return [
        '--location',
        '--fail',
        '--retry',
        '5',
        '--retry-all-errors',
        '--retry-delay',
        '5',
        '--connect-timeout',
        '20',
        '--speed-time',
        '30',
        '--speed-limit',
        '1000',
        '--output',
        destination,
        url,
    ];
}

function fileSha256(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function downloadVerifiedArchive({ url, sha256, destination, run }) {
    const partial = `${destination}.partial`;
    fs.rmSync(partial, { force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
        run('curl', releaseCurlArguments(url, partial));
    } catch (error) {
        fs.rmSync(partial, { force: true });
        throw error;
    }
    let hash;
    try {
        hash = fileSha256(partial);
    } catch (error) {
        fs.rmSync(partial, { force: true });
        throw error;
    }
    if (hash !== sha256) {
        fs.rmSync(partial, { force: true });
        throw new Error('FFmpeg source checksum mismatch');
    }
    fs.renameSync(partial, destination);
    return hash;
}

function clonePinnedRelease({ url, tag, commit, tree, run, spawn = spawnSync }) {
    fs.rmSync(tree, { recursive: true, force: true });
    run('git', ['clone', '--depth', '1', '--branch', tag, url, tree]);
    const result = spawn('git', ['-C', tree, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        throw result.error || new Error((result.stderr || '').trim() || 'git rev-parse failed');
    }
    const revision = String(result.stdout || '').trim();
    if (revision !== commit) {
        throw new Error(`FFmpeg ${tag} resolved to ${revision}, expected ${commit}`);
    }
    return revision;
}

/** 取出官方源码树：优先使用校验通过的发布包，下载失败时克隆锁定 tag。 */
function acquireFfmpegTree({ directory, version, download, sha256, repository, tag, commit, run, spawn }) {
    const archive = path.join(directory, `ffmpeg-${version}.tar.xz`);
    const tree = path.join(directory, `ffmpeg-${version}`);
    fs.mkdirSync(directory, { recursive: true });
    let hash = null;
    if (fs.existsSync(archive)) {
        hash = fileSha256(archive);
        if (hash !== sha256) {
            console.warn('Discarding FFmpeg archive that does not match the pinned checksum');
            fs.rmSync(archive, { force: true });
            hash = null;
        }
    }
    if (!hash) {
        try {
            hash = downloadVerifiedArchive({ url: download, sha256, destination: archive, run });
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            console.warn(`FFmpeg release tarball unavailable (${message}); cloning ${tag}`);
            const revision = clonePinnedRelease({ url: repository, tag, commit, tree, run, spawn });
            return {
                tree,
                provenance: { kind: 'git', tag, revision, download },
            };
        }
    }
    if (!fs.existsSync(tree)) {
        run('tar', ['-xf', archive]);
    }
    return {
        tree,
        provenance: { kind: 'release', download, sha256: hash },
    };
}

module.exports = {
    releaseCurlArguments,
    downloadVerifiedArchive,
    clonePinnedRelease,
    acquireFfmpegTree,
};
