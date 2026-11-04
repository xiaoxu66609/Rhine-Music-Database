const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    acquireFfmpegTree,
    downloadVerifiedArchive,
    releaseCurlArguments,
} = require('../../scripts/ffmpeg-source.cjs');

const source = require('../../vendor/ffmpeg/source.json');
const args = releaseCurlArguments(source.download, '/tmp/ffmpeg.tar.xz');
assert.equal(args[args.indexOf('--retry') + 1], '5');
assert.ok(args.includes('--retry-all-errors'));
assert.equal(args[args.indexOf('--retry-delay') + 1], '5');
assert.equal(args[args.indexOf('--connect-timeout') + 1], '20');
assert.equal(args[args.indexOf('--speed-time') + 1], '30');
assert.equal(args[args.indexOf('--speed-limit') + 1], '1000');
assert.equal(args.at(-1), source.download);
console.log('FFmpeg curl retries connection resets and stalled transfers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhine-ffmpeg-source-'));
const payload = Buffer.from('pinned ffmpeg release bytes');
const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
const destination = path.join(root, 'ok.tar.xz');
downloadVerifiedArchive({
    url: source.download,
    sha256,
    destination,
    run(command, curlArgs) {
        assert.equal(command, 'curl');
        assert.ok(curlArgs.includes('--retry-all-errors'));
        fs.writeFileSync(curlArgs[curlArgs.indexOf('--output') + 1], payload);
    },
});
assert.equal(fs.readFileSync(destination).equals(payload), true);
assert.equal(fs.existsSync(`${destination}.partial`), false);

assert.throws(
    () =>
        downloadVerifiedArchive({
            url: source.download,
            sha256,
            destination: path.join(root, 'bad.tar.xz'),
            run(_command, curlArgs) {
                fs.writeFileSync(curlArgs[curlArgs.indexOf('--output') + 1], Buffer.from('not the release'));
            },
        }),
    /checksum mismatch/,
);
assert.equal(fs.existsSync(path.join(root, 'bad.tar.xz')), false);
assert.equal(fs.existsSync(path.join(root, 'bad.tar.xz.partial')), false);

const brokenPartial = path.join(root, 'reset.tar.xz');
assert.throws(
    () =>
        downloadVerifiedArchive({
            url: source.download,
            sha256,
            destination: brokenPartial,
            run(_command, curlArgs) {
                fs.writeFileSync(curlArgs[curlArgs.indexOf('--output') + 1], payload);
                throw new Error('curl exited with 35');
            },
        }),
    /curl exited with 35/,
);
assert.equal(fs.existsSync(brokenPartial), false);
assert.equal(fs.existsSync(`${brokenPartial}.partial`), false);
console.log('Failed or corrupt FFmpeg downloads do not leave a reusable archive');

const calls = [];
const commit = 'a'.repeat(40);
const acquired = acquireFfmpegTree({
    directory: path.join(root, 'fallback'),
    version: '9.0.1',
    download: source.download,
    sha256,
    repository: 'https://github.com/FFmpeg/FFmpeg.git',
    tag: 'n9.0.1',
    commit,
    run(command, commandArgs) {
        calls.push([command, commandArgs]);
        if (command === 'curl') {
            throw new Error('curl exited with 35');
        }
    },
    spawn() {
        return { status: 0, stdout: `${commit}\n`, stderr: '' };
    },
});
assert.equal(acquired.provenance.kind, 'git');
assert.equal(acquired.provenance.revision, commit);
assert.deepEqual(calls[1], [
    'git',
    [
        'clone',
        '--depth',
        '1',
        '--branch',
        'n9.0.1',
        'https://github.com/FFmpeg/FFmpeg.git',
        path.join(root, 'fallback', 'ffmpeg-9.0.1'),
    ],
]);
assert.throws(
    () =>
        acquireFfmpegTree({
            directory: path.join(root, 'mismatch'),
            version: '9.0.1',
            download: source.download,
            sha256,
            repository: 'https://github.com/FFmpeg/FFmpeg.git',
            tag: 'n9.0.1',
            commit,
            run(command) {
                if (command === 'curl') {
                    throw new Error('curl exited with 35');
                }
            },
            spawn() {
                return { status: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
            },
        }),
    /expected a{40}/,
);
fs.rmSync(root, { recursive: true, force: true });
console.log('FFmpeg download failure falls back to the pinned tag and rejects a moved tag');
