"""检查签名后的 Android release APK：架构、桥接资源和签名块。不代替真机验收。"""

import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

apk = pathlib.Path(sys.argv[1]).resolve()
if apk.stat().st_size < 1024 * 1024 or apk.stat().st_size > 2 * 1024 * 1024 * 1024:
    raise SystemExit(f"Unexpected APK size: {apk}")
if "debug" in apk.name.lower() or "unsigned" in apk.name.lower():
    raise SystemExit(f"Refusing a debug or unsigned package name: {apk.name}")

with zipfile.ZipFile(apk) as package:
    names = set(package.namelist())

required = [
    "AndroidManifest.xml",
    "lib/arm64-v8a/libnode.so",
    "assets/RhineAssets/slots.json",
    "assets/RhineAssets/bundle-stamp.txt",
    "assets/RhineAssets/MusicBridge/worker.cjs",
    "assets/RhineAssets/MusicBridge/ios-runtime.cjs",
    "assets/RhineAssets/MusicBridge/xhr-sync-worker.js",
    "assets/RhineAssets/MusicBridge/NODE-LICENSE",
    "assets/RhineAssets/third-party/nodejs-mobile/android.json",
]
missing = [name for name in required if name not in names]
if missing:
    raise SystemExit("Missing APK entries:\n" + "\n".join(missing))
if "resources.arsc" not in names:
    raise SystemExit("Compiled Android resources are missing")


def find_readelf():
    sdk = os.environ.get("ANDROID_NDK_ROOT") or os.environ.get("ANDROID_HOME") or os.environ.get(
        "ANDROID_SDK_ROOT"
    )
    if sdk:
        prebuilt = pathlib.Path(sdk) / "toolchains/llvm/prebuilt"
        if prebuilt.is_dir():
            for host in prebuilt.iterdir():
                candidate = host / "bin/llvm-readelf"
                if candidate.is_file():
                    return candidate
    return shutil.which("llvm-readelf") or shutil.which("readelf")


def max_load_alignment(elf_path: pathlib.Path) -> int:
    readelf = find_readelf()
    if not readelf:
        raise SystemExit("readelf or llvm-readelf is required to verify libnode.so page alignment")
    output = subprocess.check_output([str(readelf), "-lW", str(elf_path)], text=True, errors="replace")
    aligns = []
    for line in output.splitlines():
        if not line.startswith("  LOAD"):
            continue
        parts = line.split()
        if len(parts) < 8:
            continue
        token = parts[-1]
        if token.startswith("0x"):
            aligns.append(int(token, 16))
    if not aligns:
        raise SystemExit(f"No LOAD segments found in {elf_path.name}")
    return max(aligns)


with zipfile.ZipFile(apk) as package:
    libnode = pathlib.Path(tempfile.gettempdir()) / "rhine-libnode-audit.so"
    libnode.write_bytes(package.read("lib/arm64-v8a/libnode.so"))
    if max_load_alignment(libnode) < 16384:
        raise SystemExit("lib/arm64-v8a/libnode.so is not 16 KB ELF-aligned (required for targetSdk 36)")
    libnode.unlink(missing_ok=True)

def find_aapt():
    sdk = os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME")
    if sdk:
        tools = pathlib.Path(sdk) / "build-tools"
        if tools.is_dir():
            candidates = sorted(tools.glob("*/aapt"))
            if candidates:
                return candidates[-1]
    return shutil.which("aapt")


aapt = find_aapt()
if not aapt:
    raise SystemExit("aapt is required to audit the release APK")
badging = subprocess.check_output([str(aapt), "dump", "badging", str(apk)], text=True)
checks = {
    "package: name='rhine.music.database'": "package name",
    "native-code: 'arm64-v8a'": "arm64-v8a native code",
    "application: label='RHINE MUSIC DATABASE'": "application label",
    "launchable-activity: name='org.qtproject.qt.android.bindings.QtActivity'": "launcher activity",
}
for needle, label in checks.items():
    if needle not in badging:
        raise SystemExit(f"APK badging missing {label}")
if "application-debuggable" in badging:
    raise SystemExit("Release APK is marked debuggable")
if "icon=" not in badging.split("application:", 1)[-1].split("\n", 1)[0]:
    raise SystemExit("Launcher icon was not packaged")
if any(name.endswith("/MusicBridge/node") or name.endswith("/MusicBridge/node.exe") for name in names):
    raise SystemExit("Desktop Node binary was packaged into the APK")
libraries = [name for name in names if name.startswith("lib/arm64-v8a/libRhineMusicDatabase")]
if len(libraries) != 1:
    raise SystemExit(f"Expected one Rhine native library, found {libraries}")
other_abis = {name.split("/")[1] for name in names if name.startswith("lib/") and name.count("/") >= 2}
if other_abis != {"arm64-v8a"}:
    raise SystemExit(f"Release APK must be arm64-v8a only, found {sorted(other_abis)}")
signed = [name for name in names if name.startswith("META-INF/") and name.endswith((".SF", ".RSA", ".EC"))]
payload = apk.read_bytes()
if not signed and b"APK Sig Block 42" not in payload:
    raise SystemExit("APK has no v1 signature and no APK signing block")
print(f"Android release APK audit passed: {apk.name}, {libraries[0]}")
