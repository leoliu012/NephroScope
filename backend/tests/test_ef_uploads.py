import io
import json
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np
import tifffile
from werkzeug.datastructures import FileStorage

from agh_api import create_app
from agh_api.config import Config
from agh_api.ef_uploads import EfUploadStore, PayloadTooLarge
from agh_api.errors import BadRequest, NotFound


def _tiff_bytes(array, axes):
    buf = io.BytesIO()
    tifffile.imwrite(buf, array, metadata={"axes": axes})
    buf.seek(0)
    return buf.getvalue()


def _plain_tiff():
    return _tiff_bytes(np.arange(12, dtype=np.uint16).reshape(3, 4), "YX")


def _zstack_tiff(z=5):
    return _tiff_bytes(np.arange(z * 3 * 4, dtype=np.uint16).reshape(z, 3, 4), "ZYX")


def _file_storage(data, filename):
    return FileStorage(stream=io.BytesIO(data), filename=filename, content_type="image/tiff")


class EfUploadStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "ef_uploads"
        self.store = EfUploadStore(self.root, max_bytes=10 * 1024 * 1024, ttl_seconds=3600)
        # request.content_length is consulted in save(); provide an app context.
        self.app = create_app(_config(Path(self.tmp.name)))
        self.app.testing = True

    def tearDown(self):
        self.tmp.cleanup()

    def _save(self, data, filename):
        with self.app.test_request_context(
            "/agh/api/ef/uploads",
            method="POST",
            content_length=len(data),
        ):
            return self.store.save(_file_storage(data, filename))

    def test_save_returns_upload_id_and_metadata(self):
        result = self._save(_plain_tiff(), "sample.tif")
        self.assertIn("uploadId", result)
        self.assertEqual(result["originalName"], "sample.tif")
        meta = result["meta"]
        self.assertEqual(meta["width"], 4)
        self.assertEqual(meta["height"], 3)
        self.assertEqual(meta["source"], "upload")
        self.assertEqual(meta["uploadId"], result["uploadId"])
        # File really landed under the scratch root.
        stored = self.store.path_for(result["uploadId"])
        self.assertTrue(stored.is_file())
        self.assertTrue(str(stored).startswith(str(self.root.resolve())))

    def test_zstack_metadata_reports_multiple_z(self):
        result = self._save(_zstack_tiff(5), "stack.tif")
        self.assertEqual(int(result["meta"]["zCount"]), 5)

    def test_rejects_non_image_extension(self):
        with self.assertRaises(BadRequest):
            self._save(b"not an image", "notes.txt")
        # Nothing persisted for a rejected upload.
        self.assertEqual(list(self.root.glob("*")) if self.root.exists() else [], [])

    def test_rejects_empty_file(self):
        with self.assertRaises(BadRequest):
            self._save(b"", "empty.tif")

    def test_rejects_declared_oversize(self):
        small = EfUploadStore(self.root, max_bytes=8, ttl_seconds=3600)
        data = _plain_tiff()
        with self.app.test_request_context(
            "/agh/api/ef/uploads", method="POST", content_length=len(data)
        ):
            with self.assertRaises(PayloadTooLarge):
                small.save(_file_storage(data, "sample.tif"))

    def test_rejects_streamed_oversize_without_declared_length(self):
        small = EfUploadStore(self.root, max_bytes=8, ttl_seconds=3600)
        data = _plain_tiff()
        # No content_length header -> the cap must still be enforced while copying.
        with self.app.test_request_context("/agh/api/ef/uploads", method="POST"):
            with self.assertRaises(PayloadTooLarge):
                small.save(_file_storage(data, "sample.tif"))
        leftovers = [p for p in self.root.iterdir() if p.is_dir()] if self.root.exists() else []
        self.assertEqual(leftovers, [], "partial upload directory must be cleaned up")

    def test_unknown_upload_id_is_not_found(self):
        with self.assertRaises(NotFound):
            self.store.path_for("0" * 32)

    def test_traversal_upload_id_is_not_found(self):
        for bad in ("../etc", "..", "not-a-uuid", "/absolute", "a" * 31):
            with self.assertRaises(NotFound):
                self.store.path_for(bad)

    def test_sweep_removes_expired_uploads(self):
        result = self._save(_plain_tiff(), "sample.tif")
        directory = self.root / result["uploadId"]
        self.assertTrue(directory.is_dir())
        record = json.loads((directory / "upload.json").read_text())
        record["createdAt"] = time.time() - 10_000
        (directory / "upload.json").write_text(json.dumps(record))
        self.store.sweep()
        self.assertFalse(directory.exists())


def _config(base: Path) -> Config:
    state = base / "state"
    return Config(
        data_root=base / "data",
        ann_root=base / "annotations",
        users_file=state / "users.json",
        session_root=state / "sessions",
        login_state_file=state / "login_attempts.json",
        audit_log_file=state / "audit_events.jsonl",
        collaboration_state_file=state / "collaboration_state.json",
        auth_required=False,
        ef_upload_root=base / "ef_uploads",
        ef_upload_max_bytes=10 * 1024 * 1024,
        ef_upload_ttl_seconds=3600,
    )


class EfUploadRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        (base / "data").mkdir(parents=True, exist_ok=True)
        app = create_app(_config(base))
        app.testing = True
        self.client = app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def _upload(self, data=None, filename="sample.tif"):
        data = data if data is not None else _plain_tiff()
        return self.client.post(
            "/agh/api/ef/uploads",
            data={"file": (io.BytesIO(data), filename)},
            content_type="multipart/form-data",
        )

    def test_upload_meta_and_preview_roundtrip(self):
        created = self._upload(_zstack_tiff(4))
        self.assertEqual(created.status_code, 200)
        body = created.get_json()
        upload_id = body["uploadId"]
        self.assertEqual(int(body["meta"]["zCount"]), 4)

        meta = self.client.get(f"/agh/api/ef/uploads/{upload_id}/meta")
        self.assertEqual(meta.status_code, 200)
        self.assertEqual(meta.get_json()["uploadId"], upload_id)

        # Preview for two different Z planes both return PNG bytes.
        for z in (0, 3):
            preview = self.client.get(f"/agh/api/ef/uploads/{upload_id}/preview?z={z}&max=256")
            self.assertEqual(preview.status_code, 200)
            self.assertEqual(preview.mimetype, "image/png")
            self.assertTrue(preview.data.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_upload_raw_channel_matches_viewer_pipeline(self):
        # A 2-channel image, so the calibrator renders it exactly like a case
        # image through MultiChannelCanvas (raw little-endian channel planes).
        two_channel = _tiff_bytes(
            np.array([[[1, 2], [3, 4]], [[10, 20], [30, 40]]], dtype=np.uint16),
            "CYX",
        )
        created = self._upload(two_channel, filename="channels.tif")
        self.assertEqual(created.status_code, 200)
        upload_id = created.get_json()["uploadId"]
        self.assertEqual(int(created.get_json()["meta"]["channelCount"]), 2)

        raw = self.client.get(f"/agh/api/ef/uploads/{upload_id}/channels/0/raw")
        self.assertEqual(raw.status_code, 200)
        self.assertEqual(raw.mimetype, "application/octet-stream")
        # 2x2 uint16 plane -> 8 little-endian bytes.
        self.assertEqual(raw.data, np.array([1, 2, 3, 4], dtype="<u2").tobytes())

        # Out-of-range channel is rejected.
        bad = self.client.get(f"/agh/api/ef/uploads/{upload_id}/channels/9/raw")
        self.assertEqual(bad.status_code, 400)

    def test_raw_channel_for_unknown_upload_is_404(self):
        response = self.client.get(f"/agh/api/ef/uploads/{'0' * 32}/channels/0/raw")
        self.assertEqual(response.status_code, 404)

    def test_upload_rejects_bad_extension(self):
        response = self._upload(b"nope", filename="evil.exe")
        self.assertEqual(response.status_code, 400)

    def test_meta_for_unknown_upload_is_404(self):
        response = self.client.get(f"/agh/api/ef/uploads/{'0' * 32}/meta")
        self.assertEqual(response.status_code, 404)

    def test_preview_for_bad_id_is_404(self):
        response = self.client.get("/agh/api/ef/uploads/not-a-uuid/preview")
        self.assertEqual(response.status_code, 404)

    def test_health_still_ok(self):
        # Sanity: registering the EF routes did not break the existing app.
        response = self.client.get("/agh/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])


if __name__ == "__main__":
    unittest.main()
