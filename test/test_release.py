import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("verify_package", ROOT / "scripts/verify-package.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class ReleaseValidation(unittest.TestCase):
    def archive(self, entries):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            for name, data in entries:
                archive.writestr(name, data)
        output.seek(0)
        return output

    def test_rejects_duplicate_paths(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            archive = self.archive([("manifest.json", "{}"), ("manifest.json", "{}")])
        with self.assertRaisesRegex(ValueError, "중복"):
            verifier.checked_archive(archive)

    def test_rejects_parent_paths(self):
        with self.assertRaisesRegex(ValueError, "경로"):
            verifier.checked_archive(self.archive([("../manifest.json", "{}")]))

    def test_reads_each_profile_action_version(self):
        entries = [
            ("package.json", json.dumps({"RequiredPlugins": ["local.melon.deck"]})),
            ("Profiles/page/manifest.json", json.dumps({"Actions": [
                {"Plugin": {"UUID": "local.melon.deck", "Version": "1.1.0.13"}},
                {"Plugin": {"UUID": "local.melon.deck", "Version": "1.1.0.12"}},
            ]})),
        ]
        self.assertEqual(verifier.profile_versions(self.archive(entries).getvalue()), ["1.1.0.13", "1.1.0.12"])

    def test_rejects_profile_without_melon_dependency(self):
        archive = self.archive([("package.json", '{"RequiredPlugins":[]}')])
        with self.assertRaisesRegex(ValueError, "의존성"):
            verifier.profile_versions(archive.getvalue())

    def test_rejects_tag_version_mismatch(self):
        with self.assertRaisesRegex(ValueError, "태그"):
            verifier.verify_package(Path("absent"), Path("absent"), "v0.0.0.0")

    def release_fixture(self, work, action_version="1.1.0.13", extra=False):
        plugin = Path(work) / "local.melon.deck.sdPlugin"
        (plugin / "profiles").mkdir(parents=True)
        (plugin / "bin").mkdir()
        (plugin / "manifest.json").write_text(json.dumps({"Version": "1.1.0.13", "Actions": []}))
        (plugin / "bin/MelonBridge").write_bytes(b"fixture")
        profile = plugin / verifier.PROFILE_PATH
        profile.write_bytes(self.archive([
            ("package.json", json.dumps({"RequiredPlugins": ["local.melon.deck"]})),
            ("Profiles/page/manifest.json", json.dumps({"Plugin": {
                "UUID": "local.melon.deck", "Version": action_version}})),
        ]).getvalue())
        entries = [("local.melon.deck.sdPlugin/" + path.relative_to(plugin).as_posix(), path.read_bytes())
                   for path in plugin.rglob("*") if path.is_file()]
        if extra:
            entries.append(("local.melon.deck.sdPlugin/unlisted.txt", b"extra"))
        package = Path(work) / "test.streamDeckPlugin"
        package.write_bytes(self.archive(entries).getvalue())
        return plugin, package, profile

    def test_rejects_extra_package_file(self):
        with tempfile.TemporaryDirectory() as work:
            plugin, package, profile = self.release_fixture(work, extra=True)
            with patch.object(verifier, "PLUGIN", plugin), self.assertRaisesRegex(ValueError, "파일 목록"):
                verifier.verify_package(package, profile, "v1.1.0.13")

    def test_rejects_mismatched_action_version(self):
        with tempfile.TemporaryDirectory() as work:
            plugin, package, profile = self.release_fixture(work, action_version="1.1.0.12")
            with patch.object(verifier, "PLUGIN", plugin), self.assertRaisesRegex(ValueError, "동작 버전"):
                verifier.verify_package(package, profile, "v1.1.0.13")


if __name__ == "__main__":
    unittest.main()
