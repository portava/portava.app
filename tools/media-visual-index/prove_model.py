import argparse
import base64
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--lock-sha256", required=True)
    arguments = parser.parse_args()
    from PIL import Image, ImageDraw
    spec = importlib.util.spec_from_file_location("clip_worker", Path(__file__).with_name("clip_worker.py"))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    root = worker.verified_model(arguments.model_dir, arguments.lock_sha256)
    vectors = []
    for color, shape in [("red", "circle"), ("blue", "square")]:
        image = Image.new("RGB", (224, 224), "white")
        draw = ImageDraw.Draw(image)
        if shape == "circle":
            draw.ellipse((45, 45, 179, 179), fill=color)
        else:
            draw.rectangle((45, 45, 179, 179), fill=color)
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        result = worker.encode({"kind": "image", "bytes": base64.b64encode(stream.getvalue()).decode()}, root)
        vectors.append(result["vector"])
    text = worker.encode({"kind": "text", "language": "en", "text": "a red circle on a white background"}, root)["vector"]
    for values in [*vectors, text]:
        assert len(values) == 512 and all(math.isfinite(value) for value in values)
        assert abs(math.sqrt(sum(value * value for value in values)) - 1) < 0.0001
    scores = [sum(left * right for left, right in zip(values, text)) for values in vectors]
    assert scores[0] > scores[1], {"redCircle": scores[0], "blueSquare": scores[1]}
    assert sum(left * right for left, right in zip(*vectors)) < 0.9999
    print(json.dumps({"modelId": worker.MODEL_ID, "syntheticOnly": True, "redCircleTextCosine": scores[0], "blueSquareTextCosine": scores[1],
                      "imageVectorDigest": hashlib.sha256(json.dumps(vectors[0]).encode()).hexdigest()}))


if __name__ == "__main__":
    main()
