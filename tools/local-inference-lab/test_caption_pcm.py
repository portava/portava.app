import importlib.util
from pathlib import Path
import struct
import json
import subprocess
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

path = Path(__file__).resolve().parents[2] / "artifacts/api-server/src/lib/media/captions/transcribe.py"
spec = importlib.util.spec_from_file_location("caption_pcm", path)
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)


class PcmTests(unittest.TestCase):
    def wav(self, directory, channels=1, width=2, rate=16000):
        path = Path(directory) / "sample.wav"
        with wave.open(str(path), "wb") as audio:
            audio.setnchannels(channels); audio.setsampwidth(width); audio.setframerate(rate)
            audio.writeframes(b"\0" * channels * width * 160)
        return str(path)

    def test_exact_normalized_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self.wav(directory)
            self.assertEqual(worker.read_pcm_wav(path), b"\0" * 320)
            with patch.object(worker.os.path, "getsize", return_value=31 * 1024**2):
                with self.assertRaisesRegex(ValueError, "audio_byte_budget"):
                    worker.read_pcm_wav(path)

    def test_exact_silence_abstains_without_loading_a_model_or_numpy(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = self.wav(directory)
            result = subprocess.run([sys.executable, '-I', '-B', str(path), '--model', directory, '--audio', audio], capture_output=True, text=True, timeout=5, check=True)
            self.assertEqual(json.loads(result.stdout), {"language": "und", "languageProbability": 0, "segments": []})

    def test_rejects_unconverted_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            for changes in ({"channels": 2}, {"width": 1}, {"rate": 44100}):
                with self.assertRaisesRegex(ValueError, "normalized_pcm_required"):
                    worker.read_pcm_wav(self.wav(directory, **changes))

    def test_rejects_truncation_and_unbounded_header(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(self.wav(directory)); original = path.read_bytes()
            path.write_bytes(original[:-2])
            with self.assertRaisesRegex(ValueError, "truncated_pcm"):
                worker.read_pcm_wav(str(path))
            data = bytearray(original); data[40:44] = struct.pack('<I', 16000 * 902 * 2)
            path.write_bytes(data)
            with self.assertRaisesRegex(ValueError, "audio_duration_budget"):
                worker.read_pcm_wav(str(path))


if __name__ == "__main__":
    unittest.main()
