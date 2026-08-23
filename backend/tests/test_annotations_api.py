import tempfile
import unittest
from io import BytesIO
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

from agh_api import create_app
from agh_api.auth import UserStore
from agh_api.config import Config


class AnnotationApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.data_root = base / "data"
        self.ann_root = base / "annotations"
        case_dir = self.data_root / "case1"
        case_dir.mkdir(parents=True)
        tifffile.imwrite(case_dir / "image.tif", np.arange(12, dtype=np.uint16).reshape(3, 4), metadata={"axes": "YX"})
        tifffile.imwrite(
            case_dir / "channels.tif",
            np.array([[[1, 2], [3, 4]], [[100, 200], [300, 400]]], dtype=np.uint16),
            metadata={"axes": "CYX"},
        )

        self.state_root = base / "state"
        app = create_app(Config(
            data_root=self.data_root,
            ann_root=self.ann_root,
            users_file=self.state_root / "users.json",
            session_root=self.state_root / "sessions",
            login_state_file=self.state_root / "login_attempts.json",
            audit_log_file=self.state_root / "audit_events.jsonl",
            collaboration_state_file=self.state_root / "collaboration_state.json",
            auth_required=False,
        ))
        app.testing = True
        self.client = app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_backend_auth_rejects_without_browser_challenge(self):
        state = Path(self.tmp.name) / "state"
        cfg = Config(
            data_root=self.data_root,
            ann_root=self.ann_root,
            users_file=state / "users.json",
            session_root=state / "sessions",
            login_state_file=state / "login_attempts.json",
            audit_log_file=state / "audit_events.jsonl",
            collaboration_state_file=state / "collaboration_state.json",
            auth_required=True,
        )
        UserStore(cfg.users_file).add("leo", "correct horse battery")
        app = create_app(cfg)
        app.testing = True
        client = app.test_client()

        # Protected endpoints are refused, and crucially without a
        # WWW-Authenticate header, so the browser never shows its native
        # credential popup ahead of the SPA login screen.
        missing = client.get("/agh/api/cases")
        self.assertEqual(missing.status_code, 401)
        self.assertNotIn("WWW-Authenticate", missing.headers)
        self.assertEqual(missing.get_json()["error"], "Authentication required")

        bad = client.post("/agh/api/login", json={"username": "leo", "password": "wrong password here"})
        self.assertEqual(bad.status_code, 401)
        self.assertNotIn("WWW-Authenticate", bad.headers)

        good = client.post("/agh/api/login", json={"username": "leo", "password": "correct horse battery"})
        self.assertEqual(good.status_code, 200)
        session = client.get("/agh/api/session")
        self.assertEqual(session.status_code, 200)
        self.assertEqual(session.get_json()["user"], "leo")

    def test_health_meta_and_raw_image(self):
        health = self.client.get("/agh/api/health")
        self.assertEqual(health.status_code, 200)
        health_json = health.get_json()
        self.assertTrue(health_json["ok"])
        self.assertEqual(health_json["service"], "agh-viewer-api")
        self.assertEqual(health_json["version"], "1.6.0")
        self.assertNotIn("analysis", health_json)
        # With auth explicitly disabled for these endpoint tests, the session endpoint
        # reports an authenticated dev identity without any credential.
        session = self.client.get("/agh/api/session")
        self.assertEqual(session.status_code, 200)
        self.assertTrue(session.get_json()["authenticated"])
        self.assertEqual(session.get_json()["user"], "")

        meta = self.client.get("/agh/api/cases/case1/files/image.tif/meta")
        self.assertEqual(meta.status_code, 200)
        self.assertEqual(meta.get_json()["width"], 4)
        self.assertEqual(meta.get_json()["height"], 3)
        self.assertEqual(meta.get_json()["displayPolicy"], "first-plane-no-preprocessing")

        image = self.client.get("/agh/api/cases/case1/files/image.tif/image")
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.mimetype, "image/png")
        image.close()
        preview = self.client.get("/agh/api/cases/case1/files/image.tif/preview?max=2")
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, "image/png")
        self.assertEqual(preview.headers["Cache-Control"], "private, no-cache")
        preview_pixels = np.asarray(Image.open(BytesIO(preview.data)).convert("RGB"))
        visible_pixels = preview_pixels[np.any(preview_pixels > 0, axis=2)]
        self.assertGreater(visible_pixels.size, 0)
        np.testing.assert_array_equal(visible_pixels[:, 0], visible_pixels[:, 1])
        np.testing.assert_array_equal(visible_pixels[:, 1], visible_pixels[:, 2])
        preview.close()

        cached_preview = self.client.get("/agh/api/cases/case1/files/image.tif/preview?max=2&v=test-version")
        self.assertEqual(cached_preview.status_code, 200)
        self.assertIn("max-age=", cached_preview.headers["Cache-Control"])
        self.assertIn("immutable", cached_preview.headers["Cache-Control"])
        cached_preview.close()

    def test_collaboration_presence_workspace_and_view_state(self):
        heartbeat = self.client.post("/agh/api/collaboration/heartbeat", json={
            "clientId": "browser-1",
            "caseId": "case1",
            "filename": "image.tif",
            "viewerOpen": True,
        })
        self.assertEqual(heartbeat.status_code, 200)
        body = heartbeat.get_json()
        self.assertEqual(len(body["presence"]), 1)
        self.assertEqual(body["presence"][0]["filename"], "image.tif")
        self.assertTrue(body["presence"][0]["viewerOpen"])

        workspace = self.client.patch("/agh/api/collaboration/workspace", json={
            "clientId": "browser-1",
            "selectionPanelWidth": 742,
        })
        self.assertEqual(workspace.status_code, 200)
        self.assertEqual(workspace.get_json()["workspace"]["selectionPanelWidth"], 742)

        view_state = self.client.patch("/agh/api/cases/case1/files/image.tif/view-state", json={
            "clientId": "browser-1",
            "channelSettings": [{"index": 0, "visible": True, "min": 1, "max": 10}],
            "measurementSettings": {"pixelSizeUm": "0.25", "expansionEnabled": True, "expansionFactor": "4"},
        })
        self.assertEqual(view_state.status_code, 200)
        saved = view_state.get_json()
        self.assertEqual(saved["revision"], 1)
        self.assertEqual(saved["lastChangedFields"], ["channelSettings", "measurementSettings"])

        current = self.client.get("/agh/api/cases/case1/files/image.tif/view-state")
        self.assertEqual(current.status_code, 200)
        current_json = current.get_json()
        self.assertEqual(current_json["revision"], 1)
        self.assertEqual(current_json["measurementSettings"]["expansionFactor"], "4")

    def test_metadata_and_raw_channel_endpoint(self):
        meta = self.client.get("/agh/api/cases/case1/files/channels.tif/meta")
        self.assertEqual(meta.status_code, 200)
        self.assertEqual(meta.get_json()["channelCount"], 2)
        self.assertEqual(meta.get_json()["channelValueMax"], 65535)

        preview = self.client.get("/agh/api/cases/case1/files/channels.tif/preview?max=2&render=neutral-v2")
        self.assertEqual(preview.status_code, 200)
        preview_pixels = np.asarray(Image.open(BytesIO(preview.data)).convert("RGB"))
        visible_pixels = preview_pixels[np.any(preview_pixels > 0, axis=2)]
        self.assertGreater(visible_pixels.size, 0)
        np.testing.assert_array_equal(visible_pixels[:, 0], visible_pixels[:, 1])
        np.testing.assert_array_equal(visible_pixels[:, 1], visible_pixels[:, 2])

        channel = self.client.get("/agh/api/cases/case1/files/channels.tif/channels/1/raw")
        self.assertEqual(channel.status_code, 200)
        self.assertEqual(channel.mimetype, "application/octet-stream")
        self.assertEqual(channel.headers["Cache-Control"], "private, no-cache")
        np.testing.assert_array_equal(
            np.frombuffer(channel.data, dtype="<u2").reshape(2, 2),
            np.array([[100, 200], [300, 400]], dtype=np.uint16),
        )

        cached_channel = self.client.get("/agh/api/cases/case1/files/channels.tif/channels/1/raw?v=test-version")
        self.assertEqual(cached_channel.status_code, 200)
        self.assertIn("max-age=", cached_channel.headers["Cache-Control"])
        self.assertIn("immutable", cached_channel.headers["Cache-Control"])

        missing = self.client.get("/agh/api/cases/case1/files/channels.tif/channels/2/raw")
        self.assertEqual(missing.status_code, 400)

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

    def test_annotation_z_index_round_trips_and_rejects_invalid_values(self):
        payload = {
            "revision": 0,
            "annotations": [{
                "id": "z-annotation",
                "type": "point",
                "coords": [1, 2],
                "zIndex": 12,
            }],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)
        current = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(current.get_json()["annotations"][0]["zIndex"], 12)

        invalid = {
            "revision": 1,
            "annotations": [{"id": "bad-z", "type": "point", "coords": [1, 2], "zIndex": 1.5}],
        }
        response = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=invalid)
        self.assertEqual(response.status_code, 400)

    def test_put_requires_revision_and_post_is_not_supported(self):
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
        self.assertEqual(legacy.status_code, 405)

        missing_route = self.client.get("/agh/api/does-not-exist")
        self.assertEqual(missing_route.status_code, 404)


    def test_accepts_styled_measurement_annotation(self):
        payload = {
            "revision": 0,
            "annotations": [{
                "id": "m1",
                "type": "measure",
                "coords": [0, 0, 3, 4],
                "color": "#44aaff",
                "strokeWidth": 4,
                "pixelSizeXUm": 0.5,
                "pixelSizeYUm": 0.25,
            }],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)

        current = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(current.status_code, 200)
        annotation = current.get_json()["annotations"][0]
        self.assertEqual(annotation["type"], "measure")
        self.assertEqual(annotation["strokeWidth"], 4)
        self.assertEqual(annotation["pixelSizeXUm"], 0.5)
        self.assertEqual(annotation["pixelSizeYUm"], 0.25)

    def test_per_annotation_annotator_round_trips_and_is_validated(self):
        payload = {
            "revision": 0,
            "annotations": [{
                "id": "p1",
                "type": "point",
                "coords": [5, 6],
                "color": "#44aaff",
                "annotator": "alice",
            }],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)
        current = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(current.get_json()["annotations"][0]["annotator"], "alice")

        # Non-string annotator is rejected.
        bad_type = {
            "revision": 1,
            "annotations": [{"id": "p2", "type": "point", "coords": [1, 2], "annotator": 5}],
        }
        res = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=bad_type)
        self.assertEqual(res.status_code, 400)

        # Over-long annotator is rejected.
        too_long = {
            "revision": 1,
            "annotations": [{"id": "p3", "type": "point", "coords": [1, 2], "annotator": "x" * 201}],
        }
        res = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=too_long)
        self.assertEqual(res.status_code, 400)

    def test_accepts_legacy_measurement_alias_and_normalizes_it(self):
        payload = {
            "revision": 0,
            "annotations": [{
                "id": "legacy-ruler",
                "type": "measurement",
                "coords": [0, 0, 3, 4],
                "color": "#44aaff",
                "strokeWidth": 3,
                "labelDx": 8,
                "labelDy": -5,
                "rotation": 12,
            }],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)

        current = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(current.status_code, 200)
        annotation = current.get_json()["annotations"][0]
        self.assertEqual(annotation["type"], "measure")
        self.assertEqual(annotation["labelDx"], 8)
        self.assertEqual(annotation["labelDy"], -5)
        self.assertEqual(annotation["rotation"], 12)

    def test_accepts_measurement_type_spelling_variants(self):
        variants = [
            "measurements",
            "measurement-line",
            "measurementLine",
            "measure line",
            "distance_line",
            "length-indicator",
            "calipers",
        ]
        payload = {
            "revision": 0,
            "annotations": [
                {
                    "id": f"measurement-{index}",
                    "type": ann_type,
                    "coords": [index, 0, index + 3, 4],
                    "color": "#44aaff",
                }
                for index, ann_type in enumerate(variants)
            ],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)

        current = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(current.status_code, 200)
        annotations = current.get_json()["annotations"]
        self.assertEqual([annotation["type"] for annotation in annotations], ["measure"] * len(variants))

    def test_accepts_measurement_type_field_variants(self):
        payload = {
            "revision": 0,
            "annotations": [
                {
                    "id": "tool-fallback",
                    "tool": "ruler-measurement",
                    "coords": [0, 0, 3, 4],
                    "color": "#44aaff",
                },
                {
                    "id": "kind-fallback",
                    "kind": "distanceMeasurement",
                    "coords": [1, 0, 4, 4],
                    "color": "#44aaff",
                },
                {
                    "id": "object-type",
                    "type": {"id": "calibrated-ruler"},
                    "coords": [2, 0, 5, 4],
                    "color": "#44aaff",
                },
                {
                    "id": "wrapped-type",
                    "type": "annotation",
                    "tool": {"name": "measurement-tool"},
                    "coords": [3, 0, 6, 4],
                    "color": "#44aaff",
                },
                {
                    "id": "pixel-size-hint",
                    "coords": [4, 0, 7, 4],
                    "color": "#44aaff",
                    "pixelSizeUm": 0.75,
                },
                {
                    "id": "blank-type-nested-tool",
                    "type": "",
                    "properties": {"tool": {"id": "measurement-line-tool"}},
                    "coords": [5, 0, 8, 4],
                    "color": "#44aaff",
                },
                {
                    "id": "generic-type-measurement-metadata",
                    "type": "annotation",
                    "metadata": {"measurement": {"lengthUm": 2.5}},
                    "coords": [6, 0, 9, 4],
                    "color": "#44aaff",
                },
                {
                    "id": "camel-tool-name",
                    "toolName": "CaliperLine",
                    "coords": [7, 0, 10, 4],
                    "color": "#44aaff",
                },
                {
                    "id": "classification-display-name",
                    "type": "annotation",
                    "classification": {"displayName": "Ruler Measurement"},
                    "coords": [8, 0, 11, 4],
                    "color": "#44aaff",
                },
            ],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)

        current = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(current.status_code, 200)
        annotations = current.get_json()["annotations"]
        self.assertEqual([annotation["type"] for annotation in annotations], ["measure"] * 9)
        hinted = next(annotation for annotation in annotations if annotation["id"] == "pixel-size-hint")
        self.assertEqual(hinted["pixelSizeXUm"], 0.75)
        self.assertEqual(hinted["pixelSizeYUm"], 0.75)

    def test_accepts_circle_alias_and_normalizes_radius(self):
        payload = {
            "revision": 0,
            "annotations": [{
                "id": "circle-1",
                "type": "circle",
                "coords": [10, 20, 30, 60],
                "color": "#ffee55",
                "strokeWidth": 2,
            }],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)

        current = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(current.status_code, 200)
        annotation = current.get_json()["annotations"][0]
        self.assertEqual(annotation["type"], "point")
        self.assertEqual(annotation["coords"], [20, 40])
        self.assertEqual(annotation["radius"], 20)

    def test_accepts_common_legacy_type_aliases(self):
        payload = {
            "revision": 0,
            "annotations": [
                {"id": "box-1", "type": "box", "coords": [0, 0, 2, 2]},
                {"id": "square-1", "type": "square", "coords": [1, 1, 3, 3]},
                {"id": "dot-1", "type": "dot", "coords": [1, 2]},
                {"id": "distance-1", "type": "distance", "coords": [0, 0, 3, 4]},
                {"id": "polyline-1", "type": "polyline", "coords": [0, 0, 1, 1, 2, 1]},
                {"id": "label-1", "type": "label", "coords": [2, 3], "label": "GBM"},
            ],
        }
        saved = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(saved.status_code, 200)

        current = self.client.get("/agh/api/cases/case1/files/image.tif/annotations")
        self.assertEqual(current.status_code, 200)
        annotations = current.get_json()["annotations"]
        self.assertEqual([annotation["type"] for annotation in annotations], [
            "rect", "rect", "point", "measure", "freehand", "text",
        ])

    def test_unsupported_type_error_names_type(self):
        payload = {
            "revision": 0,
            "annotations": [{
                "id": "bad-1",
                "type": "roi-mask",
                "coords": [0, 0, 1, 1],
            }],
        }
        response = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("roi-mask", response.get_json()["error"])

    def test_rejects_invalid_annotation_style_size(self):
        payload = {
            "revision": 0,
            "annotations": [{
                "id": "a1",
                "type": "line",
                "coords": [0, 0, 1, 1],
                "strokeWidth": 100,
            }],
        }
        response = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(response.status_code, 400)

    def test_rejects_malformed_measurement_coords(self):
        payload = {
            "revision": 0,
            "annotations": [{
                "id": "m1",
                "type": "measure",
                "coords": [0, 0, 1],
            }],
        }
        response = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(response.status_code, 400)

    def test_rejects_traversal(self):
        response = self.client.get("/agh/api/cases/case1/files/..%2Fsecret.tif/meta")
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
