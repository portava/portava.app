import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("vision_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerProtocolTests(unittest.TestCase):
    def request(self, **changes):
        request = {"protocol": "portava-vision-v1", "modelId": worker.MODEL_ID, "modelRevision": worker.MODEL_REVISION,
                   "taxonomyVersion": worker.TAXONOMY_VERSION, "imageBase64": base64.b64encode(b"\xff\xd8\xffsynthetic").decode()}
        request.update(changes)
        return json.dumps(request).encode()

    def test_strict_pixel_protocol_has_no_url_prompt_or_metadata_fallback(self):
        self.assertEqual(worker.parse_request(self.request()), b"\xff\xd8\xffsynthetic")
        for changes in ({"imageUrl": "http://169.254.169.254/"}, {"prompt": "Paris"}, {"modelRevision": "latest"},
                        {"taxonomyVersion": "crowd-scene-v1"}, {"imageBase64": base64.b64encode(b"crowded").decode()}):
            with self.assertRaises(ValueError):
                worker.parse_request(self.request(**changes))
        with self.assertRaises(ValueError):
            worker.parse_request(b'{"protocol":"one","protocol":"two"}')

    def test_fixed_travel_taxonomy_is_bounded_uncalibrated_and_never_a_fact(self):
        scores = [0.1, 0.2, 0.8, 0.3, 0.1] + [0.9] * len(worker.TRAVEL_LABELS)
        result = worker.recognition(scores, 12)
        self.assertEqual(result["crowdLevel"], "busy")
        self.assertEqual(result["confidenceKind"], "uncalibrated_similarity")
        self.assertEqual(result["taxonomyVersion"], "travel-scene-v1")
        self.assertEqual(len(result["travelCandidates"]), 6)
        self.assertEqual(result["travelCandidates"][0]["tag"], "beach")
        self.assertEqual(result["travelCandidates"][4]["category"], "object")
        for candidate in result["travelCandidates"]:
            self.assertIs(candidate["verified"], False)
            self.assertIs(candidate["eligibleAsObservation"], False)
        self.assertEqual(len(set(entry[0] for entry in worker.TRAVEL_LABELS)), len(worker.TRAVEL_LABELS))
        self.assertEqual(len(worker.PROMPTS), len(worker.LABELS) + len(worker.TRAVEL_LABELS))

    def test_abstention_and_low_scores_do_not_fabricate_tags(self):
        result = worker.recognition([0.1, 0.2, 0.3, 0.4, 0.9] + [0.49] * len(worker.TRAVEL_LABELS), 3)
        self.assertIsNone(result["crowdLevel"])
        self.assertEqual(result["travelCandidates"], [])
        for value in (float("nan"), float("inf"), True, -1, 2):
            with self.assertRaises(ValueError):
                worker.recognition([value] * len(worker.PROMPTS), 1)

    def test_unprovisioned_model_fails_before_imports_or_network(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                worker.verify_model(directory)
            with self.assertRaises(ValueError):
                worker.SiglipRecognition(directory)


if __name__ == "__main__":
    unittest.main()
