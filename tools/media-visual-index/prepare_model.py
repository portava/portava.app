import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

REPOSITORY = "openai/clip-vit-base-patch32"
REVISION = "d44250afa9f05af7eca021052567539406661018"
FILES = ("config.json", "preprocessor_config.json", "model.safetensors", "tokenizer_config.json", "special_tokens_map.json", "vocab.json", "merges.txt")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    output = Path(arguments.output)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    manifest = {"repository": REPOSITORY, "revision": REVISION, "files": {}}
    for filename in FILES:
        digest = hashlib.sha256()
        total = 0
        target = output / filename
        url = f"https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{filename}"
        with urllib.request.urlopen(url, timeout=60) as response, target.open("xb") as artifact:
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 700_000_000:
                    raise ValueError("model_artifact_too_large")
                digest.update(chunk)
                artifact.write(chunk)
        target.chmod(0o600)
        manifest["files"][filename] = digest.hexdigest()
    lock_bytes = (json.dumps(manifest, sort_keys=True, indent=2) + "\n").encode()
    (output / "model-lock.json").write_bytes(lock_bytes)
    (output / "model-lock.json").chmod(0o600)
    print(json.dumps({"modelLockSha256": hashlib.sha256(lock_bytes).hexdigest(), "revision": REVISION}))


if __name__ == "__main__":
    main()
