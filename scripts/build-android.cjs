const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { androidVersionCode, buildVersion, packageIdentity } = require('./release-version.cjs');

const root = path.resolve(__dirname, '..');
process.chdir(root);
const prepareOnly = process.argv.includes('--prepare-only');
const qtVersion = '6.12.0';
const ndkVersion = '27.2.12479018';
const resources = path.resolve('output/android-resources');
const bundle = path.resolve('output/android-bridge-build');
const packageSource = path.resolve('output/android-package');
const build = path.resolve('output/android-arm64-build');
const dependencies = path.resolve('output/dependencies/node-mobile-android');
const version = buildVersion();
const release = require('../vendor/nodejs-mobile/android.json');
const keystore =
    process.env.RHINE_ANDROID_KEYSTORE || path.resolve('Qt/android/rhine-release.keystore');
const keyAlias = process.env.RHINE_ANDROID_KEY_ALIAS || 'rhine';
const storePass = process.env.RHINE_ANDROID_KEYSTORE_PASSWORD || 'rhine-sideload';
const keyPass = process.env.RHINE_ANDROID_KEY_PASSWORD || storePass;

/** 串行准备资源、配置 CMake 并打出已签名的 release APK。 */
function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} exited with ${result.status}`);
    }
}

function ensureHostNode() {
    if (process.env.RHINE_NODE_BINARY && process.env.RHINE_NODE_LICENSE) {
        return;
    }
    const license = [
        path.join(path.dirname(process.execPath), 'LICENSE'),
        path.resolve(path.dirname(process.execPath), '../LICENSE'),
    ].find((candidate) => fs.existsSync(candidate));
    if (!license) {
        throw new Error('Provide RHINE_NODE_BINARY and its matching RHINE_NODE_LICENSE');
    }
    process.env.RHINE_NODE_BINARY = process.execPath;
    process.env.RHINE_NODE_LICENSE = license;
}

function prepareNodeMobile() {
    const archive = path.join(dependencies, 'nodejs-mobile-android.zip');
    fs.mkdirSync(dependencies, { recursive: true });
    if (!fs.existsSync(archive)) {
        run('curl', ['-L', '--fail', '--retry', '3', release.download, '-o', archive]);
    }
    const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    if (hash !== release.sha256) {
        throw new Error('nodejs-mobile Android archive checksum mismatch; remove the archive and retry');
    }
    const library = path.join(dependencies, release.library);
    if (!fs.existsSync(library)) {
        run('unzip', ['-q', '-o', archive, '-d', dependencies]);
    }
    if (!fs.existsSync(library)) {
        throw new Error(`libnode.so missing after extract: ${library}`);
    }
}

function prepareResources() {
    ensureHostNode();
    run(process.execPath, ['scripts/build.cjs', '--resources-only']);
    run(process.execPath, ['scripts/bundle-bridge.cjs', 'output/resources/MusicBridge', bundle], {
        env: { ...process.env, RHINE_ANDROID_BUILD: '1' },
    });
    fs.rmSync(resources, { recursive: true, force: true });
    run(process.execPath, ['scripts/package-resources.cjs', resources]);
    const bridge = path.join(resources, 'MusicBridge');
    fs.rmSync(path.join(bridge, 'node'), { force: true });
    fs.rmSync(path.join(bridge, 'node.exe'), { force: true });
    for (const name of ['worker.cjs', 'xhr-sync-worker.js']) {
        fs.copyFileSync(path.join(bundle, 'MusicBridge', name), path.join(bridge, name));
    }
    fs.copyFileSync('MusicBridge/ios-runtime.cjs', path.join(bridge, 'ios-runtime.cjs'));
    fs.cpSync('licenses/nodejs-mobile', path.join(resources, 'third-party/nodejs-mobile'), {
        recursive: true,
    });
    fs.copyFileSync(
        'vendor/nodejs-mobile/android.json',
        path.join(resources, 'third-party/nodejs-mobile/android.json'),
    );
    fs.copyFileSync('licenses/nodejs-mobile/LICENSE', path.join(bridge, 'NODE-LICENSE'));
    fs.cpSync('licenses/Qt', path.join(resources, 'Qt-Licenses'), { recursive: true });
    fs.copyFileSync('LICENSE', path.join(resources, 'LICENSE'));
    fs.cpSync('licenses/FFmpeg', path.join(resources, 'third-party/FFmpeg'), { recursive: true });
    fs.copyFileSync('vendor/ffmpeg/source.json', path.join(resources, 'third-party/FFmpeg/source.json'));
    fs.copyFileSync('vendor/qrcodegen/qrcodegen.hpp', path.join(resources, 'qrcodegen-LICENSE.hpp'));
    for (const name of ['taglib', 'utfcpp']) {
        fs.cpSync(path.join('vendor', name), path.join(resources, 'third-party', name), {
            recursive: true,
            filter: (source) => !source.endsWith('.tar.gz'),
        });
    }
    fs.writeFileSync(path.join(resources, 'bundle-stamp.txt'), `${packageIdentity(version)}\n`);
    fs.rmSync(packageSource, { recursive: true, force: true });
    fs.mkdirSync(path.join(packageSource, 'res/drawable'), { recursive: true });
    fs.copyFileSync('Qt/android/AndroidManifest.xml', path.join(packageSource, 'AndroidManifest.xml'));
    fs.copyFileSync('Assets/icons/icon-256.png', path.join(packageSource, 'res/drawable/icon.png'));
    fs.cpSync(resources, path.join(packageSource, 'assets/RhineAssets'), { recursive: true });
}

function qtKit() {
    const candidates = [
        process.env.RHINE_ANDROID_QT,
        process.env.QT_ROOT_DIR,
        path.join(os.homedir(), 'Qt', qtVersion, 'android_arm64_v8a'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'bin/qt-cmake')) &&
            fs.existsSync(path.join(candidate, 'lib/libQt6Core_arm64-v8a.so'))) {
            return candidate;
        }
    }
    throw new Error(`Qt ${qtVersion} android_arm64_v8a kit not found. Set RHINE_ANDROID_QT.`);
}

function qtHost(androidKit) {
    const candidates = [
        process.env.QT_HOST_PATH,
        process.env.RHINE_QT_HOST,
        path.join(path.dirname(androidKit), 'gcc_64'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (
            fs.existsSync(path.join(candidate, 'bin/androiddeployqt')) ||
            fs.existsSync(path.join(candidate, 'libexec/androiddeployqt'))
        ) {
            return candidate;
        }
    }
    throw new Error(
        `Qt ${qtVersion} linux desktop host kit not found. Install gcc_64 beside the Android kit or set QT_HOST_PATH.`,
    );
}

function androidSdk() {
    const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
    if (!sdk || !fs.existsSync(path.join(sdk, 'platforms'))) {
        throw new Error('Set ANDROID_SDK_ROOT to an SDK with platform android-36 and build-tools 36.0.0');
    }
    return sdk;
}

function androidNdk(sdk) {
    const pinned = path.join(sdk, 'ndk', ndkVersion);
    const requested = process.env.ANDROID_NDK_ROOT;
    if (requested && fs.existsSync(path.join(requested, 'build/cmake/android.toolchain.cmake'))) {
        if (path.basename(requested) !== ndkVersion) {
            throw new Error(`Qt ${qtVersion} requires Android NDK ${ndkVersion}`);
        }
        return requested;
    }
    if (fs.existsSync(path.join(pinned, 'build/cmake/android.toolchain.cmake'))) {
        return pinned;
    }
    throw new Error(`Android NDK ${ndkVersion} not found under ${sdk}`);
}

function ensureKeystore() {
    if (fs.existsSync(keystore)) {
        return;
    }
    fs.mkdirSync(path.dirname(keystore), { recursive: true });
    run('keytool', [
        '-genkeypair',
        '-noprompt',
        '-keystore',
        keystore,
        '-alias',
        keyAlias,
        '-keyalg',
        'RSA',
        '-keysize',
        '2048',
        '-validity',
        '10000',
        '-storepass',
        storePass,
        '-keypass',
        keyPass,
        '-dname',
        'CN=RHINE MUSIC DATABASE, OU=Sideload, O=Rhine Music Database, L=Shanghai, ST=Shanghai, C=CN',
    ]);
}

function findApk(directory) {
    const found = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.apk')) {
                found.push(full);
            }
        }
    };
    walk(directory);
    const releaseApks = found.filter(
        (file) => /\/outputs\/apk\/release\//.test(file) && !/unsigned|unaligned/.test(file),
    );
    if (releaseApks.length !== 1) {
        throw new Error(`Expected one signed release APK, found:\n${found.join('\n') || '(none)'}`);
    }
    return releaseApks[0];
}

prepareNodeMobile();
prepareResources();
if (prepareOnly) {
    console.log(`Android package source: ${packageSource}`);
    process.exit(0);
}
ensureKeystore();
const sdk = androidSdk();
const ndk = androidNdk(sdk);
const qt = qtKit();
const host = qtHost(qt);
process.env.ANDROID_SDK_ROOT = sdk;
process.env.ANDROID_NDK_ROOT = ndk;
process.env.QT_ANDROID_KEYSTORE_PATH = keystore;
process.env.QT_ANDROID_KEYSTORE_ALIAS = keyAlias;
process.env.QT_ANDROID_KEYSTORE_STORE_PASS = storePass;
process.env.QT_ANDROID_KEYSTORE_KEY_PASS = keyPass;
if (!process.env.GRADLE_OPTS) {
    process.env.GRADLE_OPTS = '-Dorg.gradle.jvmargs=-Xmx3g -Dorg.gradle.daemon=false';
}
run(path.join(qt, 'bin/qt-cmake'), [
    '-S',
    '.',
    '-B',
    build,
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    `-DANDROID_SDK_ROOT=${sdk}`,
    `-DANDROID_NDK_ROOT=${ndk}`,
    `-DQT_HOST_PATH=${host}`,
    '-DQT_ANDROID_SIGN_APK=ON',
    `-DRHINE_NODE_MOBILE_ROOT=${dependencies}`,
    `-DRHINE_ANDROID_PACKAGE_SOURCE=${packageSource}`,
    `-DRHINE_ANDROID_VERSION_CODE=${androidVersionCode(version)}`,
    '-DRHINE_PACKAGE_APP=OFF',
    `-DRHINE_VERSION=${version.version}`,
    `-DRHINE_RELEASE_BUILD=${version.release ? 'ON' : 'OFF'}`,
]);
run('cmake', ['--build', build, '--target', 'apk', '--parallel', process.env.RHINE_BUILD_JOBS || '2']);
const apk = findApk(build);
const identity = packageIdentity(version);
const published = path.resolve(`output/RhineMusicDatabase-${identity}-Android-arm64.apk`);
fs.copyFileSync(apk, published);
run(process.env.PYTHON || 'python3', ['scripts/audit-android.py', published]);
console.log(`Signed release APK: ${published}`);
