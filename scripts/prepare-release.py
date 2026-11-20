#!/usr/bin/env python3
"""Stage verified release assets and their SHA-256 checksums."""

import argparse
import hashlib
import importlib.util
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("verify_package", ROOT / "scripts/verify-package.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="배포할 태그, 예: v1.1.0.13")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    package = ROOT / "local.melon.deck.streamDeckPlugin"
    profile = ROOT / "local.melon.deck.sdPlugin/profiles/melon-plus.streamDeckProfile"
    version = verifier.verify_package(package, profile, args.tag)
    args.output.mkdir(parents=True, exist_ok=True)
    checksums = []
    for source in [package, profile]:
        destination = args.output / source.name
        shutil.copyfile(source, destination)
        checksums.append(hashlib.sha256(destination.read_bytes()).hexdigest() + "  " + destination.name)
    (args.output / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n")
    print("melon " + version + " · 검증된 릴리스 파일 준비 완료")
    print(args.output.resolve())


if __name__ == "__main__":
    main()
