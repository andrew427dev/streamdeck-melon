#!/usr/bin/env python3
"""Verify the release package, profile, version and universal native helper."""

import argparse
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "local.melon.deck.sdPlugin"
PREFIX = PLUGIN.name + "/"
PROFILE_PATH = "profiles/melon-plus.streamDeckProfile"


def checked_archive(source):
    archive = zipfile.ZipFile(source)
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    if len(set(names)) != len(names):
        archive.close()
        raise ValueError("압축 파일 안에 중복 경로가 있습니다")
    if sum(entry.file_size for entry in entries) > 32 * 1024 * 1024:
        archive.close()
        raise ValueError("예상한 패키지 크기를 초과했습니다")
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            archive.close()
            raise ValueError("압축 파일에 잘못된 경로가 있습니다")
    if archive.testzip():
        archive.close()
        raise ValueError("압축 파일 무결성 검사가 실패했습니다")
    return archive


def profile_versions(data):
    versions = []

    def visit(value):
        if isinstance(value, dict):
            plugin = value.get("Plugin")
            if isinstance(plugin, dict) and plugin.get("UUID") == "local.melon.deck":
                versions.append(plugin.get("Version"))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    with checked_archive(io.BytesIO(data)) as profile:
        package = json.loads(profile.read("package.json"))
        if "local.melon.deck" not in package.get("RequiredPlugins", []):
            raise ValueError("프로필에 멜론 플러그인 의존성이 없습니다")
        for name in profile.namelist():
            if name.endswith("/manifest.json"):
                visit(json.loads(profile.read(name)))
    if not versions:
        raise ValueError("프로필에 멜론 동작이 없습니다")
    return versions


def verify_package(package, profile, tag=None):
    source_manifest = json.loads((PLUGIN / "manifest.json").read_text())
    version = source_manifest["Version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", version):
        raise ValueError("플러그인의 버전 형식을 확인해 주세요")
    if tag and tag != "v" + version:
        raise ValueError("릴리스 태그와 플러그인 버전이 다릅니다")
    with checked_archive(package) as archive:
        manifest = json.loads(archive.read(PREFIX + "manifest.json"))
        if manifest != source_manifest:
            raise ValueError("설치 파일과 소스의 manifest가 다릅니다")
        source_paths = {
            PREFIX + path.relative_to(PLUGIN).as_posix()
            for path in PLUGIN.rglob("*")
            if path.is_file() and "logs" not in path.relative_to(PLUGIN).parts
            and not any(part.startswith(".") for part in path.relative_to(PLUGIN).parts)
        }
        generated = {PREFIX + "bin/MelonBridge"}
        for action in manifest["Actions"]:
            generated.add(PREFIX + action["States"][0]["Image"] + ".svg")
            if action.get("Encoder"):
                generated.add(PREFIX + action["Encoder"]["Icon"] + ".svg")
        expected_files = source_paths | generated
        archive_files = {entry.filename for entry in archive.infolist() if not entry.is_dir()}
        if archive_files != expected_files:
            difference = sorted(archive_files.symmetric_difference(expected_files))
            raise ValueError("소스와 패키지의 파일 목록이 다릅니다: " + ", ".join(difference))
        for path in PLUGIN.rglob("*"):
            relative = path.relative_to(PLUGIN)
            if not path.is_file() or "logs" in relative.parts or any(part.startswith(".") for part in relative.parts):
                continue
            name = PREFIX + relative.as_posix()
            if path.read_bytes() != archive.read(name):
                raise ValueError("소스와 패키지 파일이 다릅니다: " + relative.as_posix())
        bundled = archive.read(PREFIX + PROFILE_PATH)
        if bundled != profile.read_bytes() or bundled != (PLUGIN / PROFILE_PATH).read_bytes():
            raise ValueError("내장 프로필과 별도 배포 프로필이 다릅니다")
        if any(found != version for found in profile_versions(bundled)):
            raise ValueError("프로필의 동작 버전과 플러그인 버전이 다릅니다")
        with tempfile.TemporaryDirectory(prefix="melon-verify-") as work:
            native = Path(work) / "MelonBridge"
            native.write_bytes(archive.read(PREFIX + "bin/MelonBridge"))
            architectures = subprocess.check_output(["xcrun", "lipo", "-archs", str(native)], text=True).split()
            if set(architectures) != {"arm64", "x86_64"}:
                raise ValueError("Apple Silicon 및 Intel 실행 파일이 모두 필요합니다")
            subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(native)], check=True)
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package", type=Path, default=ROOT / "local.melon.deck.streamDeckPlugin")
    parser.add_argument("--profile", type=Path, default=PLUGIN / PROFILE_PATH)
    parser.add_argument("--tag")
    args = parser.parse_args()
    version = verify_package(args.package, args.profile, args.tag)
    print("melon " + version + " · 패키지·프로필·Universal 서명 검사 완료")


if __name__ == "__main__":
    main()
