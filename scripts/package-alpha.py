"""Package explicit build assets in a clean stage, without modifying an installed app."""
from pathlib import Path
import argparse, hashlib, json, os, shutil, zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "alpha-manifest.json").read_text(encoding="utf-8"))["version"]
RELEASE = ROOT.parent / ("release-" + VERSION)
NAME = "RikkaHub-" + VERSION + "-windows-x64"
STAGE = RELEASE / ".portable-stage" / NAME
EXCLUDED = {".git", "node_modules", ".react-router", ".scratch", ".superpowers", "build", "dist", "target", "pc-data", "alpha-data", "demo-data", "webview2-data", "backups", "alpha-evidence", "pi", "pi-patches", "pi-model-data", "yukkuri-sdk", "demo-profiles", "__pycache__"}


def tauri_shell_exe():
    # build-alpha.ps1 copies the Tauri shell into dist/ so packaging no longer needs
    # to know where CARGO_TARGET_DIR points on this machine.
    bundled = ROOT / "dist" / "RikkaHub.exe"
    if bundled.exists():
        return bundled
    target = Path(os.environ.get("CARGO_TARGET_DIR", str(ROOT / "web-ui" / "src-tauri" / "target"))) / "release"
    for name in ("RikkaHub.exe", "rikkahub.exe"):
        candidate = target / name
        if candidate.exists():
            return candidate
    raise SystemExit("Tauri shell not found under " + str(target) + " or dist/ — run scripts/build-alpha.ps1 (or tauri build) first")


def prepare_stage():
    RELEASE.mkdir(exist_ok=True)
    assert STAGE.resolve().is_relative_to((RELEASE / ".portable-stage").resolve())
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    for name in ["rikkahub-pc.exe", "web-ui", "icons", "fonts", "koffi"]:
        src = ROOT / "dist" / name
        if src.is_dir(): shutil.copytree(src, STAGE / name)
        else: shutil.copy2(src, STAGE / name)
    shutil.copy2(tauri_shell_exe(), STAGE / "RikkaHub.exe")
    # Tauri 壳读同一份 shell.ini 的 dataDir/minimizeToTray（port/serverPath 忽略），
    # Demo 用环境变量改成 demo-data + 固定 17555，不再复制第二份壳。
    (STAGE / "Demo.cmd").write_text('@echo off\nsetlocal\ncd /d "%~dp0"\nset "RIKKAHUB_ALPHA_DEMO=1"\nset "RIKKAHUB_ALPHA_DEBUG_PORT=17556"\nset "RIKKAHUB_ALPHA_CDP_PORT=17567"\nset "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=17567"\nset "RIKKAHUB_PC_DATA_DIR=%~dp0demo-data"\nset "PORT=17555"\nstart "" "%~dp0RikkaHub.exe"\n', encoding="ascii", newline="\r\n")
    for name in ["LICENSE", "LICENSE-AGPL-3.0.txt", "ALPHA.md"]:
        shutil.copy2(ROOT / name, STAGE / name)
    (STAGE / "licenses").mkdir()
    shutil.copy2(ROOT / "vendor/pi-auth/LICENSE", STAGE / "licenses/pi-auth-MIT.txt")
    (STAGE / "shell.ini").write_text("port=17565\nminimizeToTray=0\nserverPath=rikkahub-pc.exe\ndataDir=alpha-data\n", encoding="utf-8")
    (STAGE / "Demo-browser.cmd").write_text('@echo off\nsetlocal\ncd /d "%~dp0"\nset "RIKKAHUB_ALPHA_DEMO=1"\nset "RIKKAHUB_ALPHA_DEBUG_PORT=17556"\nset "RIKKAHUB_PC_DATA_DIR=%~dp0demo-data"\n"%~dp0rikkahub-pc.exe" --alpha-demo --port 17555\npause\n', encoding="ascii", newline="\r\n")
    (STAGE / "README.txt").write_text("RikkaHub Desktop PLUS " + VERSION + "\n\n双击 Demo.cmd：本地模拟模型桌面演示，无需密钥。\nDemo-browser.cmd：系统浏览器备用入口。\nRikkaHub.exe：真实模型模式，请在设置中配置模型。\n演示数据 demo-data 与真实模式 alpha-data 独立。\n详细说明见 ALPHA.md。\n", encoding="utf-8")
    return sorted(p for p in STAGE.rglob("*") if p.is_file())


def source_files():
    for current, dirs, files in os.walk(ROOT, followlinks=False):
        dirs[:] = [d for d in dirs if d not in EXCLUDED and not d.startswith(".alpha") and not (Path(current) / d).is_junction() and not (Path(current) / d).is_symlink() and Path(current) / d != ROOT / "pc-server/assets/bash"]
        for name in files:
            p = Path(current) / name
            if name.startswith(".alpha") or name.endswith((".log", ".tmp", ".tsbuildinfo", ".exe", ".nupkg", ".bun-build", ".pyc")) or name in {".env", "alpha-docs-migrate.py", "retired-pi-manifest.json"} or p.is_symlink(): continue
            yield p


def write_zip(path, files, root, prefix):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for p in files:
            archive_path = Path(prefix) / p.relative_to(root)
            if root == ROOT and p == ROOT / "alpha-manifest.json":
                # Build scripts require this manifest. Keep portable build metadata,
                # excluding local source paths, backup paths, and private QA history.
                metadata = json.loads(p.read_text(encoding="utf-8"))
                allowed = {"version", "note", "kernel", "desktopAdapter", "defaultExecutionMode", "piCheckoutRequired", "oauthSnapshot", "conversationKind", "executionMode", "releaseDirectory"}
                archive.writestr(archive_path.as_posix(), json.dumps({key: value for key, value in metadata.items() if key in allowed}, indent=2) + "\n")
            else:
                archive.write(p, archive_path)
    with zipfile.ZipFile(temporary) as archive:
        assert archive.testzip() is None
    temporary.replace(path)


def update_release_manifest(source_count, payload_files=None):
    manifest_path = RELEASE / "release-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    archives = sorted([*RELEASE.glob("*.zip"), *RELEASE.glob("*.7z"), *RELEASE.glob("*.tar.gz"), *RELEASE.glob("*-setup.exe")])
    assets = []
    for path in archives:
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        assets.append({"name": path.name, "bytes": path.stat().st_size, "sha256": digest})
    (RELEASE / "SHA256SUMS.txt").write_text("".join(asset["sha256"] + "  " + asset["name"] + "\n" for asset in assets), encoding="ascii")
    manifest.update({"version": VERSION, "sourceFiles": source_count, "archives": assets, "dataIncluded": False})
    if payload_files is not None:
        manifest.update({"payloadFiles": len(payload_files), "payloadBytes": sum(path.stat().st_size for path in payload_files)})
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage-only", action="store_true")
    parser.add_argument("--source-only", action="store_true", help="refresh only the source archive and checksums, keeping verified binary packages")
    parser.add_argument("--compact", action="store_true", help="also write a solid BCJ/LZMA2 .7z archive (pip install py7zr)")
    args = parser.parse_args()
    if args.source_only:
        RELEASE.mkdir(exist_ok=True)
        sources = list(source_files())
        write_zip(RELEASE / ("RikkaHub-" + VERSION + "-source.zip"), sources, ROOT, "rikkahub-alpha")
        print(json.dumps(update_release_manifest(len(sources))))
        return
    files = prepare_stage()
    if args.stage_only:
        print(STAGE); return
    sources = list(source_files())
    write_zip(RELEASE / ("RikkaHub-" + VERSION + "-source.zip"), sources, ROOT, "rikkahub-alpha")
    write_zip(RELEASE / (NAME + ".zip"), files, STAGE, NAME)
    if args.compact:
        import py7zr
        target = RELEASE / (NAME + ".7z")
        temporary = target.with_suffix(".7z.tmp")
        with py7zr.SevenZipFile(temporary, "w", filters=[{"id": py7zr.FILTER_X86}, {"id": py7zr.FILTER_LZMA2, "preset": 9}]) as archive:
            for p in files: archive.write(p, str(Path(NAME) / p.relative_to(STAGE)))
        temporary.replace(target)
    manifest = update_release_manifest(len(sources), files)
    print(json.dumps(manifest))


if __name__ == "__main__": main()
