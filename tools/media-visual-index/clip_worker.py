import argparse
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import warnings

MODEL_REPO = "openai/clip-vit-base-patch32"
MODEL_REVISION = "d44250afa9f05af7eca021052567539406661018"
MODEL_ID = f"{MODEL_REPO}@{MODEL_REVISION}:clip-rgb224-v1"
MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 16_777_216
FILES = {"config.json", "preprocessor_config.json", "model.safetensors", "tokenizer_config.json", "special_tokens_map.json", "vocab.json", "merges.txt"}


def verified_model(directory, expected_lock):
    root = Path(directory).resolve(strict=True)
    lock_bytes = (root / "model-lock.json").read_bytes()
    if hashlib.sha256(lock_bytes).hexdigest() != expected_lock:
        raise ValueError("model_lock_mismatch")
    lock = json.loads(lock_bytes)
    if lock.get("repository") != MODEL_REPO or lock.get("revision") != MODEL_REVISION or set(lock.get("files", {})) != FILES:
        raise ValueError("model_identity_mismatch")
    for filename, expected in lock["files"].items():
        artifact = root / filename
        if artifact.is_symlink() or not artifact.is_file() or artifact.stat().st_size > 700_000_000:
            raise ValueError("model_artifact_invalid")
        digest = hashlib.sha256()
        with artifact.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError("model_artifact_mismatch")
    return root


def encode(request, root):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    import torch
    from PIL import Image, ImageOps
    from transformers import CLIPImageProcessor, CLIPModel, CLIPTokenizer

    torch.set_num_threads(1)
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    model = CLIPModel.from_pretrained(str(root), local_files_only=True, use_safetensors=True, trust_remote_code=False).eval().to("cpu")
    with torch.inference_mode():
        if request.get("kind") == "image":
            encoded = request.get("bytes")
            if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_BYTES + 2) // 3):
                raise ValueError("image_size_invalid")
            raw = base64.b64decode(encoded, validate=True)
            if not raw or len(raw) > MAX_BYTES:
                raise ValueError("image_size_invalid")
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"} or getattr(image, "n_frames", 1) != 1 or image.width * image.height > MAX_PIXELS:
                    raise ValueError("image_format_invalid")
                pixels = ImageOps.exif_transpose(image).convert("RGB")
                processor = CLIPImageProcessor.from_pretrained(str(root), local_files_only=True)
                features = model.get_image_features(**processor(images=pixels, return_tensors="pt"))
        elif request.get("kind") == "text":
            text = request.get("text")
            if request.get("language") != "en" or not isinstance(text, str) or not text.strip() or len(text) > 512 or any(ord(character) < 32 for character in text):
                raise ValueError("text_query_invalid")
            tokenizer = CLIPTokenizer.from_pretrained(str(root), local_files_only=True)
            tokens = tokenizer([text], return_tensors="pt", padding=True, truncation=False)
            if tokens["input_ids"].shape[-1] > 77:
                raise ValueError("text_query_too_long")
            features = model.get_text_features(**tokens)
        else:
            raise ValueError("request_kind_invalid")
        normalized = features.float() / features.float().norm(dim=-1, keepdim=True)
        values = normalized[0].cpu().tolist()
    if len(values) != 512 or not all(math.isfinite(value) for value in values):
        raise ValueError("embedding_invalid")
    return {"modelId": MODEL_ID, "vector": values}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--lock-sha256", required=True)
    arguments = parser.parse_args()
    raw = sys.stdin.buffer.read(4 * ((MAX_BYTES + 2) // 3) + 4097)
    if len(raw) > 4 * ((MAX_BYTES + 2) // 3) + 4096:
        raise ValueError("request_too_large")
    request = json.loads(raw)
    if not isinstance(request, dict):
        raise ValueError("request_invalid")
    root = verified_model(arguments.model_dir, arguments.lock_sha256)
    print(json.dumps(encode(request, root), allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("visual_inference_failed", file=sys.stderr)
        sys.exit(1)
