"""Local feasibility probes, not a representative provider-parity benchmark.

Run with network access denied. This harness calls the existing CPU workers;
the optional Metal experiment stays in this lab and cannot change app routing.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import re
import resource
import signal
import statistics
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "DO_NOT_TRACK"):
    os.environ[key] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def word_error(reference, hypothesis):
    words = lambda value: re.findall(r"\w+", value.casefold(), flags=re.UNICODE)
    expected, actual = words(reference), words(hypothesis)
    if not expected:
        return 0.0 if not actual else None
    row = list(range(len(actual) + 1))
    for i, wanted in enumerate(expected, 1):
        previous, row = row, [i]
        for j, got in enumerate(actual, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j-1] + (wanted != got)))
    return row[-1] / len(expected)


def vision(models, fixtures):
    worker = load_module("portava_vision_probe", HERE.parent / "media-vision" / "worker.py")
    from PIL import Image
    started = time.monotonic()
    runtime = worker.SiglipRecognition(models / "vision")
    load_ms = (time.monotonic() - started) * 1000
    print(json.dumps({"loaded": "siglip", "milliseconds": load_ms}), flush=True)
    examples = [("blank_white", Image.new("RGB", (224, 224), "white")),
                ("blank_black", Image.new("RGB", (224, 224), "black"))]
    with Image.open(fixtures / "coffee.png") as image:
        examples.append(("public_coffee_photo", image.convert("RGB")))
    records = []
    for name, image in examples:
        image.thumbnail((1024, 1024))
        output = io.BytesIO(); image.save(output, format="JPEG", quality=90)
        pixels = output.getvalue()
        trials = [runtime.infer(pixels) for _ in range(3)]
        records.append({"case": name, "inputSha256": hashlib.sha256(pixels).hexdigest(),
                        "latencyMs": [trial["inferenceMs"] for trial in trials], "result": trials[-1]})
        print(json.dumps({"completed": name, "latencyMs": records[-1]["latencyMs"]}), flush=True)
    metal = {"available": runtime.torch.backends.mps.is_available(), "productionEnabled": False}
    if metal["available"]:
        # Compare actual tensors for one identical batch, not just the top label.
        inputs = runtime.processor(text=list(worker.PROMPTS), images=examples[-1][1], padding="max_length", return_tensors="pt")
        with runtime.torch.inference_mode():
            cpu_scores = runtime.torch.sigmoid(runtime.model(**inputs).logits_per_image)[0].cpu().tolist()
            runtime.model.to("mps")
            gpu_inputs = {key: value.to("mps") for key, value in inputs.items()}
            durations = []
            for _ in range(5):
                runtime.torch.mps.synchronize(); started = time.monotonic()
                gpu_scores = runtime.torch.sigmoid(runtime.model(**gpu_inputs).logits_per_image)[0].cpu().tolist()
                runtime.torch.mps.synchronize()
                durations.append((time.monotonic() - started) * 1000)
        metal.update({"latencyMs": durations, "warmMedianMs": statistics.median(durations[1:]),
                      "maxScoreDifferenceFromCpu": max(abs(a-b) for a,b in zip(cpu_scores,gpu_scores)),
                      "result": worker.recognition(gpu_scores, durations[-1])})
    return {"worker": "existing_siglip_cpu", "modelLoadMs": load_ms, "cases": records, "experimentalMetal": metal}


def captions(models, fixtures, checkpoint=None):
    prepare = load_module("portava_caption_model_verify", HERE / "prepare_models.py")
    manifest = json.loads((HERE / "caption-model-manifest.json").read_text())
    for name, expected in manifest["files"].items():
        if not prepare.verified(models / "captions" / name, expected):
            raise ValueError("caption_model_mismatch")
    silence = fixtures / "silence.wav"
    with wave.open(str(silence), "wb") as stream:
        stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(16000); stream.writeframes(b"\0\0" * 16000 * 8)
    cases = [
        ("public_jfk", "jfk.wav", "en", "And so my fellow Americans ask not what your country can do for you ask what you can do for your country", False),
        ("tts_english", "english.wav", "en", "Please plan a quiet afternoon in Da Nang. I prefer vegetarian food, short walks, and a budget of twenty dollars.", True),
        ("tts_spanish", "spanish.wav", "es", "Quiero visitar un museo por la mañana y comer cerca de la playa. Mi presupuesto es de treinta euros y prefiero caminar.", True),
        ("tts_vietnamese", "vietnamese.wav", "vi", "Tôi muốn đi bộ gần biển vào buổi sáng. Hãy tìm một quán cà phê yên tĩnh ở Đà Nẵng.", True),
        ("silence", "silence.wav", "auto", "", True),
    ]
    records = []
    result_summary = {"worker": "existing_transcribe_py_cpu_int8_two_threads", "model": manifest["modelId"], "revision": manifest["revision"], "cases": records, "completedAllCases": False}
    script = ROOT / "artifacts/api-server/src/lib/media/captions/transcribe.py"
    for name, filename, language, reference, synthetic in cases:
        path = fixtures / filename
        with wave.open(str(path)) as audio:
            duration = audio.getnframes() / audio.getframerate()
        if not 0 < duration <= 60:
            raise ValueError("invalid_fixture_audio_duration")
        started = time.monotonic()
        try:
            result = subprocess.run([sys.executable, "-I", "-B", str(script), "--model", str(models / "captions"), "--audio", str(path), "--language", language], capture_output=True, text=True, timeout=180, check=True)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
            records.append({"case": name, "ok": False, "reason": "timeout" if isinstance(error, subprocess.TimeoutExpired) else "worker_failed",
                            "wallSecondsIncludingModelLoad": time.monotonic() - started, "audioSeconds": duration})
            if checkpoint: checkpoint(result_summary)
            return result_summary
        elapsed = time.monotonic() - started
        value = json.loads(result.stdout)
        hypothesis = " ".join(segment["text"].strip() for segment in value["segments"])
        record = {"case": name, "ok": True, "synthetic": synthetic, "inputSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                  "audioSeconds": duration, "wallSecondsIncludingModelLoad": elapsed, "realTimeFactorIncludingLoad": elapsed / duration,
                  "language": value["language"], "wordErrorRate": word_error(reference, hypothesis), "transcript": hypothesis,
                  "silenceHallucination": name == "silence" and bool(hypothesis.strip()),
                  "segmentBoundsValid": all(0 <= segment["start"] < segment["end"] <= duration + 1 for segment in value["segments"])}
        records.append(record)
        if checkpoint: checkpoint(result_summary)
        print(json.dumps({"completed": name, "seconds": round(elapsed, 3), "wordErrorRate": record["wordErrorRate"]}), flush=True)
    result_summary["completedAllCases"] = True
    return result_summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", choices=["vision", "captions"], required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    signal.alarm(600)
    report = {"schemaVersion": 1, "kind": "local_feasibility_probe", "eligibleForReplacement": False,
              "startedAt": datetime.now(timezone.utc).isoformat(), "platform": platform.platform(), "python": platform.python_version(),
              "limitations": ["tiny_public_and_synthetic_sample", "no_paid_baseline", "not_a_production_load_test"]}
    def checkpoint(value):
        report[args.kind] = value
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    report[args.kind] = vision(args.models, args.fixtures) if args.kind == "vision" else captions(args.models, args.fixtures, checkpoint)
    # macOS reports bytes; Linux reports KiB. Include children (caption subprocess).
    peak = max(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
    report["peakProcessRssMiB"] = peak / (1024**2 if sys.platform == "darwin" else 1024)
    report["completedAt"] = datetime.now(timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"output": str(args.output), "eligibleForReplacement": False, "peakProcessRssMiB": report["peakProcessRssMiB"]}))
    if args.kind == "captions" and not report["captions"]["completedAllCases"]:
        sys.exit(2)
