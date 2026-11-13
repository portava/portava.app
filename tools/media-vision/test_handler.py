import base64
import unittest
from unittest.mock import patch
import handler
import worker


class ManagedHandlerTests(unittest.TestCase):
    def request(self):
        return {"protocol": "portava-vision-v1", "modelId": worker.MODEL_ID,
                "modelRevision": worker.MODEL_REVISION, "taxonomyVersion": worker.TAXONOMY_VERSION,
                "imageBase64": base64.b64encode(b"\xff\xd8\xffsynthetic").decode()}

    def test_uses_same_pinned_worker_and_only_decoded_pixels(self):
        with patch.object(handler, "SiglipRecognition") as runtime:
            runtime.return_value.infer.return_value = {"synthetic": True}
            endpoint = handler.EndpointHandler("/approved/model")
            runtime.assert_called_once_with("/approved/model")
            self.assertEqual(endpoint(self.request()), {"ok": True, "value": {"synthetic": True}})
            runtime.return_value.infer.assert_called_once_with(b"\xff\xd8\xffsynthetic")

    def test_rejects_identity_urls_wrong_pins_and_oversized_data_before_inference(self):
        with patch.object(handler, "SiglipRecognition") as runtime:
            endpoint = handler.EndpointHandler("/approved/model")
            for change in [{"userId": "someone"}, {"url": "https://private.test/photo"},
                           {"modelRevision": "latest"}, {"imageBase64": "x" * (4 * 1024 * 1024)}]:
                request = self.request()
                request.update(change)
                with self.assertRaises(ValueError):
                    endpoint(request)
            runtime.return_value.infer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
