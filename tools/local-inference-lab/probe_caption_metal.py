"""Experimental GPU feasibility only; production caption device stays CPU."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import signal
import time

from prepare_models import verified
from benchmark import word_error

HERE = Path(__file__).resolve().parent
for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
    os.environ[key] = "1"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    signal.alarm(240)
    manifest = json.loads((HERE / "caption-model-manifest.json").read_text())
    for name, expected in manifest["files"].items():
        if not verified(args.models / "captions" / name, expected):
            raise ValueError("model_checksum_mismatch")
    spec = importlib.util.spec_from_file_location("portava_pcm", HERE.parents[1] / "artifacts/api-server/src/lib/media/captions/transcribe.py")
    pcm = importlib.util.module_from_spec(spec); spec.loader.exec_module(pcm)
    import numpy as np
    from faster_whisper import WhisperModel
    report = {"schemaVersion": 1, "kind": "experimental_mps_feasibility", "eligibleForReplacement": False, "completed": False,
              "model": manifest["modelId"], "revision": manifest["revision"], "cases": [], "startedAt": datetime.now(timezone.utc).isoformat()}
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    started = time.monotonic()
    model = WhisperModel(str(args.models / "captions"), device="mps", compute_type="float16", cpu_threads=2, num_workers=1, local_files_only=True)
    report["modelLoadSeconds"] = time.monotonic() - started
    cases = [
        ("jfk.wav", "en", "And so my fellow Americans ask not what your country can do for you ask what you can do for your country"),
        ("english.wav", "en", "Please plan a quiet afternoon in Da Nang. I prefer vegetarian food, short walks, and a budget of twenty dollars."),
        ("spanish.wav", "es", "Quiero visitar un museo por la mañana y comer cerca de la playa. Mi presupuesto es de treinta euros y prefiero caminar."),
        ("vietnamese.wav", "vi", "Tôi muốn đi bộ gần biển vào buổi sáng. Hãy tìm một quán cà phê yên tĩnh ở Đà Nẵng."),
        ("silence.wav", "auto", ""),
    ]
    for filename, language, reference in cases:
        source = args.fixtures / filename
        audio = np.frombuffer(pcm.read_pcm_wav(str(source)), dtype="<i2").astype(np.float32) / 32768.0
        started = time.monotonic()
        segments, info = model.transcribe(audio, language=None if language == "auto" else language, beam_size=1, vad_filter=False, condition_on_previous_text=False)
        texts = []
        for segment in segments:
            if len(texts) >= 100: raise ValueError("probe_segment_budget")
            texts.append(segment.text.strip())
        text = " ".join(texts); elapsed = time.monotonic() - started
        record = {"case": filename, "secondsExcludingModelLoad": elapsed, "audioSeconds": len(audio) / 16000,
                  "transcript": text, "wordErrorRate": word_error(reference, text), "silenceHallucination": filename == "silence.wav" and bool(text)}
        report["cases"].append(record)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({"completed": filename, "seconds": elapsed, "wordErrorRate": record["wordErrorRate"]}), flush=True)
    report["completed"] = True
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
