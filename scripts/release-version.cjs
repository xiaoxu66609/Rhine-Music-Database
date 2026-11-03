const { execFileSync } = require('node:child_process');
const path = require('node:path');

// 发布标识
const distributionPlatforms = [
    'macOS-arm64.zip',
    'Windows-x64-Setup.exe',
    'Linux-x86_64.AppImage',
    'ios-unsigned.ipa',
    'Android-arm64.apk',
];

/** 发布 tag 在编译前确定；普通构建明确标记为开发版，避免缓存上次的发布身份。 */
function buildVersion(value = process.env.RHINE_VERSION) {
    if (!value) {
        let commitSha = 'unknown';
        try {
            commitSha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
                cwd: path.resolve(__dirname, '..'),
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
        } catch {
            // 源码归档可能没有 Git 元数据；明确标记未知提交，不冒用正式版本。
        }
        return { version: '0.0.0', release: false, commitSha };
    }
    if (!/^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error('Release version must use vMAJOR.MINOR.PATCH, e.g. v1.0.0');
    }
    const version = value.replace(/^v/, '');
    if (version.split('.').some((segment) => Number(segment) > 65535)) {
        throw new Error('Release version components must be at most 65535 for Windows VERSIONINFO');
    }
    return { version, release: true };
}
function packageIdentity(version = buildVersion()) {
    return version.release ? `v${version.version}` : version.commitSha;
}

/** Canonical GitHub release tag: vMAJOR.MINOR.PATCH (accepts input with or without v). */
function normalizeReleaseTag(value) {
    const built = buildVersion(String(value).trim());
    if (!built.release) {
        throw new Error('Release version must use vMAJOR.MINOR.PATCH, e.g. v1.0.0');
    }
    return `v${built.version}`;
}

/** Android versionCode。开发包固定为 1；正式版由 major.minor.patch 展开，且能装进有符号 32 位。 */
function androidVersionCode(version = buildVersion()) {
    if (!version.release) {
        return 1;
    }
    const [major, minor, patch] = version.version.split('.').map(Number);
    return major * 10000 + minor * 100 + patch;
}

module.exports = {
    androidVersionCode,
    buildVersion,
    packageIdentity,
    normalizeReleaseTag,
    distributionPlatforms,
};
