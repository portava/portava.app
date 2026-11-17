"""Explicit, bounded public-weight provisioning. Inference never downloads."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
MANIFESTS = {
    "vision": HERE.parent / "media-vision" / "model-manifest.json",
    "captions": HERE / "caption-model-manifest.json",
    "text": HERE / "text-model-manifest.json",
}


def digest_for(expected):
    digest = hashlib.sha256() if "sha256" in expected else hashlib.sha1()
    if "gitBlobSha1" in expected:
        digest.update(f"blob {expected['size']}\0".encode())
    return digest


def verified(path, expected):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != expected["size"]:
        return False
    digest = digest_for(expected)
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == expected.get("sha256", expected.get("gitBlobSha1"))


def provision(kind, root):
    manifest = json.loads(MANIFESTS[kind].read_text())
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        raise ValueError("symlink_root_refused")
    output = root / kind
    if output.is_symlink():
        raise ValueError("symlink_model_refused")
    output.mkdir(mode=0o700, exist_ok=True)
    needed = sum(row["size"] for name, row in manifest["files"].items() if not (output / name).exists())
    if shutil.disk_usage(root).free < needed + 10 * 1024**3:
        raise ValueError("insufficient_disk_reserve")
    for name, expected in manifest["files"].items():
        if Path(name).name != name or not 0 < expected["size"] <= 3 * 1024**3:
            raise ValueError("invalid_manifest")
        target = output / name
        if target.exists() or target.is_symlink():
            if not verified(target, expected):
                raise ValueError("existing_model_checksum_mismatch")
            continue
        partial = output / f".{name}.{uuid.uuid4().hex}.partial"
        request = urllib.request.Request(
            f"https://huggingface.co/{manifest['modelId']}/resolve/{manifest['revision']}/{name}",
            headers={"User-Agent": "Portava-local-model-provisioning/1", "Accept-Encoding": "identity"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response, partial.open("xb") as artifact:
                if not response.url.startswith("https://"):
                    raise ValueError("insecure_download_refused")
                partial.chmod(0o600)
                count = 0
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    count += len(chunk)
                    if count > expected["size"]:
                        raise ValueError("download_size_exceeded")
                    artifact.write(chunk)
            if not verified(partial, expected):
                raise ValueError("download_checksum_mismatch")
            # A concurrently provisioned target must also match; never overwrite it.
            if target.exists():
                if not verified(target, expected):
                    raise ValueError("concurrent_model_mismatch")
            else:
                target.hardlink_to(partial)
            print(json.dumps({"model": kind, "file": name, "bytes": expected["size"], "verified": True}), flush=True)
        finally:
            partial.unlink(missing_ok=True)
    return {"model": manifest["modelId"], "revision": manifest["revision"], "path": str(output), "verified": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=MANIFESTS, required=True)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(provision(args.model, args.root)))
