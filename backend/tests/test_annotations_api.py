import tempfile
import unittest
from pathlib import Path

import numpy as np
import tifffile

from agh_api import create_app
from agh_api.config import Config


class AnnotationApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.data_root = base / "data"
        self.ann_root = base / "annotations"
        self.cache_root = base / "cache"
        case_dir = self.data_root / "case1"
        case_dir.mkdir(parents=True)
        tifffile.imwrite(case_dir / "image.tif", np.arange(12, dtype=np.uint16).reshape(3, 4), metadata={"axes": "YX"})

        app = create_app(Config(
            data_root=self.data_root,
            ann_root=self.ann_root,
            cache_root=self.cache_root,
        ))
        app.testing = True
        self.client = app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_health_meta_channel_and_thumbnail(self):
        health = self.client.get("/agh/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.get_json(), {
            "ok": True,
            "service": "agh-viewer-api",
            "version": "0.2.0",
        })

        meta = self.client.get("/agh/api/cases/case1/files/image.tif/meta")
        self.assertEqual(meta.status_code, 200)
        self.assertEqual(meta.get_json()["numChannels"], 1)

        channel = self.client.get("/agh/api/cases/case1/files/image.tif/channel/0")
        self.assertEqual(channel.status_code, 200)
        self.assertEqual(channel.mimetype, "image/png")
        channel.close()

        thumbnail = self.client.get("/agh/api/cases/case1/files/image.tif/thumbnail")
        self.assertEqual(thumbnail.status_code, 200)
        self.assertEqual(thumbnail.mimetype, "image/png")
        thumbnail.close()

    def test_annotation_revision_conflict(self):
        first = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["revision"], 0)

        payload = {
            "revision": 0,
            "updatedBy": "leo",
            "annotations": [{
                "id": "a1",
                "type": "rect",
                "coords": [1, 2, 3, 4],
                "label": "Region A",
                "color": "#ffee55",
            }],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.get_json()["revision"], 1)

        conflict = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(conflict.status_code, 409)

    def test_put_requires_revision_but_post_allows_legacy_payload(self):
        payload = {
            "annotations": [{
                "id": "a1",
                "type": "point",
                "coords": [1, 2],
                "color": "#ffee55",
            }],
        }
        missing = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(missing.status_code, 400)

        legacy = self.client.post("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(legacy.get_json()["revision"], 1)

    def test_rejects_traversal(self):
        response = self.client.get("/agh/api/cases/case1/files/..%2Fsecret.tif/meta")
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
