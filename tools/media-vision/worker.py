import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import time

MODEL_ID = "google/siglip-base-patch16-224"
MODEL_REVISION = "7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed"
TAXONOMY_VERSION = "travel-scene-v1"
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_LINE_BYTES = 3 * 1024 * 1024
LABELS = ("empty", "quiet", "busy", "social", None)
CROWD_PROMPTS = (
    "A photo of an empty public space with no people.",
    "A photo of a quiet public space with very few people.",
    "A photo of a busy public space with a crowd of people.",
    "A photo of groups of people gathered together in a public social setting.",
    "A photo that does not show enough of a public space to judge crowd activity.",
)
TRAVEL_LABELS = (
    ("beach", "scene", "A photo of a sandy or rocky beach beside water."),
    ("ocean", "scene", "A photo of the ocean or sea."),
    ("mountain", "scene", "A photo of a mountain landscape."),
    ("architecture", "scene", "A photo showing the architecture of buildings."),
    ("food", "object", "A photo of prepared food or a meal."),
    ("sunset", "scene", "A photo of a sunset sky."),
    ("forest", "scene", "A photo of a forest with many trees."),
    ("snow", "scene", "A photo of a landscape covered in snow."),
    ("desert", "scene", "A photo of a dry desert landscape."),
    ("waterfall", "scene", "A photo of a waterfall."),
    ("lake", "scene", "A photo of a lake surrounded by land."),
    ("garden", "scene", "A photo of a garden with plants and flowers."),
    ("boat", "object", "A photo showing a boat or ship."),
    ("market", "scene", "A photo of market stalls selling goods."),
)
PROMPTS = CROWD_PROMPTS + tuple(entry[2] for entry in TRAVEL_LABELS)


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def parse_request(line):
    if len(line) > MAX_LINE_BYTES:
        raise ValueError("request_too_large")
    request = json.loads(line, object_pairs_hook=strict_object)
    expected = {"protocol", "modelId", "modelRevision", "taxonomyVersion", "imageBase64"}
    if not isinstance(request, dict) or set(request) != expected:
        raise ValueError("invalid_request")
    if request["protocol"] != "portava-vision-v1" or request["modelId"] != MODEL_ID or request["modelRevision"] != MODEL_REVISION or request["taxonomyVersion"] != TAXONOMY_VERSION:
        raise ValueError("model_contract_mismatch")
    encoded = request["imageBase64"]
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
        raise ValueError("invalid_pixels")
    pixels = base64.b64decode(encoded, validate=True)
    if not 3 < len(pixels) <= MAX_IMAGE_BYTES or not pixels.startswith(b"\xff\xd8\xff"):
        raise ValueError("invalid_pixels")
    return pixels


def recognition(scores, inference_ms):
    if len(scores) != len(PROMPTS) or any(isinstance(score, bool) or not isinstance(score, (float, int)) or not math.isfinite(score) or not 0 <= score <= 1 for score in scores):
        raise ValueError("invalid_scores")
    winner = max(range(len(LABELS)), key=lambda index: scores[index])
    selected = sorted(range(len(TRAVEL_LABELS)), key=lambda index: scores[len(LABELS) + index], reverse=True)
    travel_candidates = [
        {"tag": TRAVEL_LABELS[index][0], "category": TRAVEL_LABELS[index][1], "confidence": float(scores[len(LABELS) + index]),
         "basis": "visual_inference", "verified": False, "eligibleAsObservation": False}
        for index in selected[:6] if scores[len(LABELS) + index] >= 0.5
    ]
    return {
        "modelId": MODEL_ID,
        "modelRevision": MODEL_REVISION,
        "taxonomyVersion": TAXONOMY_VERSION,
        "crowdLevel": LABELS[winner],
        "confidence": float(scores[winner]),
        "confidenceKind": "uncalibrated_similarity",
        "inferenceMs": inference_ms,
        "travelCandidates": travel_candidates,
    }


def verify_model(directory):
    manifest = json.loads(Path(__file__).with_name("model-manifest.json").read_text())
    if manifest["modelId"] != MODEL_ID or manifest["revision"] != MODEL_REVISION:
        raise ValueError("manifest_mismatch")
    root = Path(directory).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("model_directory_missing")
    for name, expected in manifest["files"].items():
        filename = root / name
        if filename.is_symlink() or not filename.is_file() or filename.stat().st_size != expected["size"]:
            raise ValueError("model_file_mismatch")
        digest = hashlib.sha256() if "sha256" in expected else hashlib.sha1()
        if "gitBlobSha1" in expected:
            digest.update(f"blob {expected['size']}\0".encode())
        with filename.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        if digest.hexdigest() != expected.get("sha256", expected.get("gitBlobSha1")):
            raise ValueError("model_digest_mismatch")
    return root


class SiglipRecognition:
    def __init__(self, model_directory):
        root = verify_model(model_directory)
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        import torch
        from PIL import Image
        from transformers import SiglipModel, SiglipProcessor
        torch.set_num_threads(2)
        Image.MAX_IMAGE_PIXELS = 1024 * 1024
        self.torch = torch
        self.image = Image
        self.processor = SiglipProcessor.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
        self.model = SiglipModel.from_pretrained(str(root), local_files_only=True, trust_remote_code=False, use_safetensors=True).to("cpu").eval()

    def infer(self, pixels):
        started = time.monotonic()
        with self.image.open(io.BytesIO(pixels)) as image:
            if image.format != "JPEG" or image.width > 1024 or image.height > 1024 or getattr(image, "n_frames", 1) != 1:
                raise ValueError("image_refused")
            image.load()
            inputs = self.processor(text=list(PROMPTS), images=image.convert("RGB"), padding="max_length", return_tensors="pt")
        with self.torch.inference_mode():
            output = self.model(**inputs)
            scores = self.torch.sigmoid(output.logits_per_image)[0].cpu().tolist()
        return recognition(scores, round((time.monotonic() - started) * 1000, 3))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    args = parser.parse_args()
    runtime = None
    while True:
        line = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES:
            print(json.dumps({"ok": False, "reason": "request_too_large"}), flush=True)
            return
        try:
            pixels = parse_request(line)
        except (ValueError, TypeError):
            print(json.dumps({"ok": False, "reason": "invalid_request"}), flush=True)
            continue
        del line
        try:
            if runtime is None:
                runtime = SiglipRecognition(args.model_dir)
            result = runtime.infer(pixels)
            print(json.dumps({"ok": True, "value": result}, allow_nan=False), flush=True)
        except Exception:
            print(json.dumps({"ok": False, "reason": "inference_unavailable"}), flush=True)
            return
        finally:
            del pixels


if __name__ == "__main__":
    main()
