import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, handler):
        self.connections = threading.BoundedSemaphore(8)
        super().__init__(address, handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def handle_error(self, *_args):
        pass


class LocalTranslationModel:
    def __init__(self, directory):
        self.ready = False
        self.source = None
        self.target = None
        self.version = None
        self.detector = None
        if not directory:
            return
        try:
            import ctranslate2
            import sentencepiece
            root = Path(directory).resolve(strict=True)
            manifest = json.loads((root / "translation.json").read_text())
            source, target = manifest["source"], manifest["target"]
            if not all(isinstance(code, str) and re.fullmatch(r"[a-z]{2,3}(?:-[a-z0-9]{2,8})*", code) for code in [source, target]):
                return
            if source == target or source in ["und", "zxx"] or target in ["und", "zxx"]:
                return
            digest = hashlib.sha256()
            paths = [root / filename for filename in ["translation.json", "source.spm", "target.spm"]]
            paths += sorted(path for path in (root / "model").rglob("*") if path.is_file())
            if not (root / "model/model.bin").is_file():
                return
            for path in paths:
                digest.update(str(path.relative_to(root)).encode())
                with path.open("rb") as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(block)
            self.encoder = sentencepiece.SentencePieceProcessor(model_file=str(root / "source.spm"))
            self.decoder = sentencepiece.SentencePieceProcessor(model_file=str(root / "target.spm"))
            self.translator = ctranslate2.Translator(str(root / "model"), device="cpu", inter_threads=1, intra_threads=2)
            self.source, self.target = source, target
            self.version = "ctranslate2-" + ctranslate2.__version__ + ":" + digest.hexdigest()
            self.ready = True
            detector_path = root / "language-identification.bin"
            if detector_path.is_file():
                try:
                    import fasttext
                    self.detector = fasttext.load_model(str(detector_path))
                except Exception:
                    self.detector = None
        except Exception:
            self.ready = False

    def translate(self, text, source, target):
        if not self.ready or (source, target) != (self.source, self.target):
            raise ValueError("translation_unavailable")
        tokens = self.encoder.encode(text, out_type=str)
        if not tokens or len(tokens) > 1024:
            raise ValueError("translation_input_limit")
        result = self.translator.translate_batch([tokens], beam_size=2, max_input_length=0, max_decoding_length=2048)[0]
        hypothesis = result.hypotheses[0]
        if not hypothesis or len(hypothesis) >= 2048:
            raise ValueError("translation_output_limit")
        translated = self.decoder.decode(hypothesis)
        if not translated.strip() or len(translated) > 32000:
            raise ValueError("translation_output_limit")
        return {"translatedText": translated, "source": source, "target": target, "providerVersion": self.version}

    def detect(self, text):
        if self.detector is None:
            raise ValueError("detection_unavailable")
        labels, scores = self.detector.predict(text.replace("\n", " "), k=1)
        language = labels[0].removeprefix("__label__")
        if not re.fullmatch(r"[a-z]{2,3}", language) or language in ["und", "zxx"] or float(scores[0]) < 0.5:
            raise ValueError("detection_unavailable")
        return {"language": language, "confidence": "high" if float(scores[0]) >= 0.8 else "low"}


def make_server(model, token, port):
    work = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode())

        def do_GET(self):
            if not self.authorized():
                self.respond(401, {"error": "unauthorized"})
            elif self.path != "/health":
                self.respond(404, {"error": "not_found"})
            else:
                self.respond(200 if model.ready else 503, {"ready": model.ready,
                    "pairs": [[model.source, model.target]] if model.ready else [],
                    "detection": model.detector is not None, "providerVersion": model.version if model.ready else None})

        def do_POST(self):
            self.connection.settimeout(5)
            if not self.authorized():
                self.respond(401, {"error": "unauthorized"})
                return
            if self.path not in ["/v1/translate", "/v1/detect"]:
                self.respond(404, {"error": "not_found"})
                return
            if not work.acquire(blocking=False):
                self.respond(503, {"error": "translation_busy"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 64000 or self.headers.get("Transfer-Encoding"):
                    self.respond(413, {"error": "input_limit"})
                    return
                payload = json.loads(self.rfile.read(length))
                text = payload.get("text") if isinstance(payload, dict) else None
                if not isinstance(text, str) or not text.strip() or len(text) > 8000:
                    self.respond(400, {"error": "invalid_input"})
                    return
                if self.path == "/v1/detect":
                    result = model.detect(text)
                else:
                    result = model.translate(text, payload.get("source"), payload.get("target"))
                self.respond(200, result)
            except Exception:
                self.respond(503, {"error": "translation_unavailable"})
            finally:
                work.release()

    return BoundedHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--model-dir", default=os.environ.get("TRANSLATION_MODEL_DIR"))
    args = parser.parse_args()
    secret = os.environ.get("TRANSLATION_SELF_HOSTED_TOKEN", "")
    if len(secret) < 32:
        raise SystemExit("A private token of at least 32 characters is required")
    runtime = make_server(LocalTranslationModel(args.model_dir), secret, args.port)
    print(json.dumps({"port": runtime.server_port}), flush=True)
    runtime.serve_forever()
