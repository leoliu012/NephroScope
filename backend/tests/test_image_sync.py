import sqlite3
import tempfile
import unittest
import json
from pathlib import Path

from agh_api.config import Config
from agh_api.image_sync import RemoteImageSync, request_manual_sync, sync_status


class RemoteImageSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.remote = base / "remote"
        self.local = base / "local"
        self.config = Config(
            data_root=self.local,
            ann_root=base / "annotations",
            remote_data_root=self.remote,
            sync_state_dir=base / "sync-state",
            sync_fingerprint_bytes=1024,
            audit_log_file=base / "state" / "audit_events.jsonl",
        )
        self.remote.mkdir()
        self.syncer = RemoteImageSync(self.config)

    def tearDown(self):
        self.tmp.cleanup()

    def _remote_file(self, relative, payload):
        path = self.remote / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
        return path

    def test_only_final_supported_extensions_are_copied_case_insensitively(self):
        self._remote_file("case-a/scan.TIFF", b"tiff")
        self._remote_file("case-a/stack.Nd2", b"nd2")
        self._remote_file("case-a/notes.txt", b"ignore")
        self._remote_file("case-a/scan.partial.tif", b"partial")
        self._remote_file("case-a/~thumbnail.TIF", b"thumb")

        result = self.syncer.sync_once()

        self.assertEqual(result["counts"]["copied"], 2)
        self.assertEqual(result["progress"]["phase"], "complete")
        self.assertEqual(result["progress"]["percent"], 100)
        self.assertEqual((self.local / "case-a/scan.TIFF").read_bytes(), b"tiff")
        self.assertEqual((self.local / "case-a/stack.Nd2").read_bytes(), b"nd2")
        self.assertFalse((self.local / "case-a/notes.txt").exists())
        self.assertFalse((self.local / "case-a/scan.partial.tif").exists())
        self.assertFalse((self.local / "case-a/~thumbnail.TIF").exists())

    def test_remote_rename_moves_the_cached_file_without_a_second_copy(self):
        old_remote = self._remote_file("case-a/sample01.nd2", b"microscopy-data" * 500)
        self.syncer.sync_once()
        old_local = self.local / "case-a/sample01.nd2"
        cached_inode = old_local.stat().st_ino

        new_remote = old_remote.with_name("patient01.nd2")
        old_remote.rename(new_remote)
        result = self.syncer.sync_once()

        new_local = self.local / "case-a/patient01.nd2"
        self.assertEqual(result["counts"]["renamed"], 1)
        self.assertEqual(result["counts"]["copied"], 0)
        self.assertFalse(old_local.exists())
        self.assertEqual(new_local.read_bytes(), b"microscopy-data" * 500)
        self.assertEqual(new_local.stat().st_ino, cached_inode)
        with sqlite3.connect(self.config.sync_state_dir / "sync-index.sqlite") as conn:
            self.assertEqual(conn.execute("SELECT remote_path FROM sync_index").fetchone()[0], "case-a/patient01.nd2")

    def test_remote_delete_removes_cached_file_and_initial_stale_cache(self):
        remote_file = self._remote_file("case-a/image.tif", b"image")
        stale = self.local / "case-a/orphan.TIF"
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_bytes(b"old")

        self.syncer.sync_once()
        self.assertFalse(stale.exists())
        self.assertTrue((self.local / "case-a/image.tif").exists())

        remote_file.unlink()
        result = self.syncer.sync_once()
        self.assertFalse((self.local / "case-a/image.tif").exists())
        self.assertGreaterEqual(result["counts"]["deleted"], 1)

    def test_manual_request_is_persisted_for_the_background_service(self):
        queued = request_manual_sync(self.config, actor="admin")

        self.assertTrue(queued["manualRequestPending"])
        self.assertTrue(sync_status(self.config)["manualRequestPending"])
        payload = (self.config.sync_state_dir / "manual-sync-request.json").read_text(encoding="utf-8")
        self.assertIn('"requestedBy": "admin"', payload)

    def test_actual_sync_records_completion_audit_not_request_success(self):
        self._remote_file("case-a/image.tif", b"image")

        self.syncer.sync_once(reason="manual", actor="ha")

        events = [json.loads(line) for line in self.config.audit_log_file.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(events[-1]["action"], "IMAGE_SYNC")
        self.assertEqual(events[-1]["result"], "success")
        self.assertEqual(events[-1]["actor"], "ha")
        self.assertEqual(events[-1]["details"]["copied"], 1)


if __name__ == "__main__":
    unittest.main()
