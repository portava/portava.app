import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


prepare = load("lab_prepare", HERE / "prepare_models.py")
benchmark = load("lab_benchmark", HERE / "benchmark.py")


class LabTests(unittest.TestCase):
    def test_word_error_preserves_language_and_rejects_silence_hallucination(self):
        self.assertEqual(benchmark.word_error("Hello, world!", "hello world"), 0)
        self.assertEqual(benchmark.word_error("quiet morning", "loud morning"), .5)
        self.assertGreater(benchmark.word_error("Đà Nẵng", "Da Nang"), 0)
        self.assertEqual(benchmark.word_error("", ""), 0)
        self.assertIsNone(benchmark.word_error("", "imaginary speech"))

    def test_checksum_and_symlink_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / "weights"; path.write_bytes(b"approved")
            expected = {"size": 8, "sha256": hashlib.sha256(b"approved").hexdigest()}
            self.assertTrue(prepare.verified(path, expected))
            (root / "alias").symlink_to(path)
            self.assertFalse(prepare.verified(root / "alias", expected))
            path.write_bytes(b"modified")
            self.assertFalse(prepare.verified(path, expected))

    def test_verified_download_and_retry_use_exact_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"modelId": "fixture/model", "revision": "pinned", "files": {"model.bin": {"size": 3, "sha256": hashlib.sha256(b"abc").hexdigest()}}}))
            response = io.BytesIO(b"abc"); response.url = "https://cdn.example.test/model.bin"
            with patch.dict(prepare.MANIFESTS, {"fixture": manifest}), patch.object(prepare.shutil, "disk_usage", return_value=SimpleNamespace(free=20 * 1024**3)), patch.object(prepare.urllib.request, "urlopen", return_value=response) as fetch:
                prepare.provision("fixture", root / "models")
                self.assertIn("/resolve/pinned/model.bin", fetch.call_args.args[0].full_url)
                prepare.provision("fixture", root / "models")
                self.assertEqual(fetch.call_count, 1)
                self.assertEqual((root / "models/fixture/model.bin").read_bytes(), b"abc")

    def test_oversized_download_never_publishes_partial_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"modelId": "fixture/model", "revision": "pinned", "files": {"model.bin": {"size": 3, "sha256": hashlib.sha256(b"abc").hexdigest()}}}))
            response = io.BytesIO(b"oversized"); response.url = "https://cdn.example.test/model.bin"
            with patch.dict(prepare.MANIFESTS, {"fixture": manifest}), patch.object(prepare.shutil, "disk_usage", return_value=SimpleNamespace(free=20 * 1024**3)), patch.object(prepare.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(ValueError, "download_size_exceeded"):
                    prepare.provision("fixture", root / "models")
            self.assertEqual(list((root / "models/fixture").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
