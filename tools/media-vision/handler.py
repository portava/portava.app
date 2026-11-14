"""Hugging Face dedicated/private endpoint adapter. Uses the same pinned local model.

Deploy with worker.py, model-manifest.json and the approved model artifacts.
The serving layer must enforce token authentication and disable request-body logs.
"""
import json
import threading
from worker import SiglipRecognition, parse_request


class EndpointHandler:
    def __init__(self, path=""):
        self.runtime = SiglipRecognition(path)
        self.lock = threading.Lock()

    def __call__(self, data):
        # Exact protocol validation refuses URLs, identity fields and extra metadata.
        pixels = parse_request(json.dumps(data, separators=(",", ":")))
        with self.lock:
            return {"ok": True, "value": self.runtime.infer(pixels)}
