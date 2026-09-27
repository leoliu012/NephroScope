import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import tifffile

from agh_api import create_app
from agh_api.auth import UserStore
from agh_api.config import Config
from agh_api.data_source import (
    SETTINGS_FILENAME, SourceConfigurationError, _mounted_windows_paths,
    resolve_folder, source_settings,
)
from agh_api.image_sync import (
    LOCK_FILENAME, RemoteImageSync, RemoteImageSyncService, SyncConfigurationError,
    _process_lock, request_manual_sync, save_image_source, sync_status,
)


class ImageSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        state = self.base / "state"
        self.cfg = Config(
            data_root=self.base / "cache", ann_root=self.base / "annotations",
            users_file=state / "users.json", session_root=state / "sessions",
            login_state_file=state / "login.json", audit_log_file=state / "audit.jsonl",
            collaboration_state_file=state / "collaboration.json",
            ef_upload_root=state / "uploads", sync_state_dir=state / "sync",
            model_checkpoint=self.base / "model.pt",
        )
        self.cfg.model_checkpoint.write_bytes(b"test checkpoint")
        self.root = self.base / "direct data"
        self.make_image(self.root)

    def make_image(self, root, case="case-a", value=1):
        folder = root / case
        folder.mkdir(parents=True, exist_ok=True)
        image = folder / "image.tif"
        tifffile.imwrite(image, np.full((3, 4), value, dtype=np.uint16), metadata={"axes": "YX"})
        return image

    def save(self, mode="direct", folder=None):
        return save_image_source(self.cfg, {"mode": mode, "folderPath": str(folder or self.root)}, "admin")

    def login(self, app, role="admin"):
        users = UserStore(self.cfg.users_file)
        users.add(role, "password", allow_update=True)
        users.set_role(role, role)
        client = app.test_client()
        token = client.post("/agh/api/login", json={"username": role, "password": "password"}).get_json()["csrfToken"]
        return client, {"X-AGH-CSRF": token}

    def test_admin_can_save_direct_source_and_existing_api_process_reads_it(self):
        app = create_app(self.cfg)
        other_app = create_app(self.cfg)
        client, headers = self.login(app)
        response = client.put("/agh/api/admin/image-sync", headers=headers, json={"mode": "direct", "folderPath": str(self.root)})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertFalse(response.get_json()["configured"])
        self.assertEqual(client.get("/agh/api/cases").get_json()["cases"], ["case-a"])
        prefix = "/agh/api/cases/case-a/files"
        self.assertEqual(client.get(prefix).get_json()["files"], ["image.tif"])
        self.assertEqual(client.get(prefix + "/image.tif/meta").get_json()["width"], 4)
        self.assertEqual(client.get(prefix + "/image.tif/channels/0/raw").status_code, 200)
        other_client, _ = self.login(other_app)
        self.assertEqual(other_client.get("/agh/api/cases").get_json()["cases"], ["case-a"])
        restarted_client, _ = self.login(create_app(self.cfg))
        self.assertEqual(restarted_client.get("/agh/api/cases").get_json()["cases"], ["case-a"])
        self.assertFalse((self.cfg.data_root / "case-a").exists())

    def test_source_changes_require_admin_and_csrf(self):
        app = create_app(self.cfg)
        payload = {"mode": "direct", "folderPath": str(self.root)}
        self.assertEqual(app.test_client().put("/agh/api/admin/image-sync", json=payload).status_code, 401)
        for role in ("viewer", "annotator"):
            client, headers = self.login(app, role)
            self.assertEqual(client.put("/agh/api/admin/image-sync", headers=headers, json=payload).status_code, 403)
        client, _ = self.login(app)
        self.assertEqual(client.put("/agh/api/admin/image-sync", json=payload).status_code, 403)
        self.assertFalse((self.cfg.sync_state_dir / SETTINGS_FILENAME).exists())

    def test_invalid_folder_layouts_in_both_modes_preserve_previous_setting(self):
        self.save()
        original = source_settings(self.cfg)
        empty = self.base / "empty"
        empty.mkdir()
        no_images = self.base / "no-images"
        (no_images / "case").mkdir(parents=True)
        nested = self.base / "nested"
        self.make_image(nested / "case" / "extra")
        loose = self.base / "loose"
        self.make_image(loose)
        (loose / "loose.tif").write_bytes(b"image")
        for mode in ("sync", "direct"):
            for root in (empty, no_images, nested, loose, self.root / "case-a", self.base / "missing", self.root / "case-a/image.tif"):
                with self.subTest(mode=mode, root=root):
                    with self.assertRaises(SourceConfigurationError):
                        self.save(mode, root)
                    self.assertEqual(source_settings(self.cfg), original)

    def test_invalid_payloads_return_400_without_writing(self):
        client, headers = self.login(create_app(self.cfg))
        for payload in ([], {}, {"mode": []}, {"mode": "invalid"}, {"mode": "direct", "folderPath": 12}, {"mode": "direct", "folderPath": "relative/path"}):
            with self.subTest(payload=payload):
                self.assertEqual(client.put("/agh/api/admin/image-sync", headers=headers, json=payload).status_code, 400)

    def test_nested_directories_are_ignored_in_both_folder_modes(self):
        self.make_image(self.root, "#3")
        nested = self.root / "#3" / "nested.tif"
        self.make_image(nested, "deeper")
        client, headers = self.login(create_app(self.cfg))
        for mode in ("sync", "direct"):
            with self.subTest(mode=mode):
                response = client.put("/agh/api/admin/image-sync", headers=headers, json={"mode": mode, "folderPath": str(self.root)})
                self.assertEqual(response.status_code, 200, response.get_json())
                if mode == "sync":
                    result = RemoteImageSync(self.cfg).sync_once()
                    self.assertEqual(result["counts"]["remote"], 2)
                    self.assertFalse((self.cfg.data_root / "#3/nested.tif").exists())
                files = client.get("/agh/api/cases/%233/files").get_json()["files"]
                self.assertEqual(files, ["image.tif"])
                self.assertTrue((nested / "deeper/image.tif").exists())

    def test_unreadable_image_and_symlinked_case_are_rejected(self):
        with patch("pathlib.Path.open", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(SourceConfigurationError, "unreadable"):
                self.save()
        link_root = self.base / "links"
        link_root.mkdir()
        (link_root / "case-a").symlink_to(self.root / "case-a", target_is_directory=True)
        with self.assertRaisesRegex(SourceConfigurationError, "symbolic links"):
            self.save(folder=link_root)

    def test_sync_worker_reloads_source_and_direct_mode_never_copies(self):
        worker = RemoteImageSync(self.cfg)  # Created before the admin saves anything.
        status = self.save("sync")
        self.assertTrue(status["manualRequestPending"])
        self.assertEqual(self.cfg.active_data_root, self.cfg.data_root)
        self.assertEqual(worker.sync_once()["counts"]["copied"], 1)
        self.assertTrue((self.cfg.data_root / "case-a/image.tif").exists())
        replacement = self.base / "replacement"
        self.make_image(replacement, "case-b", 2)
        self.save("sync", replacement)
        worker.sync_once()
        self.assertTrue((self.cfg.data_root / "case-b/image.tif").exists())
        self.assertFalse((self.cfg.data_root / "case-a/image.tif").exists())
        self.save("direct")
        with patch.object(worker, "_scan_remote", side_effect=AssertionError("Direct mode must not sync")):
            self.assertFalse(worker.sync_once()["configured"])
        self.assertFalse(sync_status(self.cfg)["manualRequestPending"])
        self.assertNotIn("lastSuccessAt", sync_status(self.cfg))
        with self.assertRaises(SyncConfigurationError):
            request_manual_sync(self.cfg)
        self.assertTrue((self.root / "case-a/image.tif").exists())

    def test_scheduler_stays_idle_in_direct_mode_then_consumes_admin_sync_choice(self):
        service = RemoteImageSyncService(self.cfg)
        calls = 0

        def tick(_):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.assertFalse(self.cfg.data_root.exists())
                self.save("sync")
            else:
                raise KeyboardInterrupt

        with patch("agh_api.image_sync.time.sleep", side_effect=tick):
            with self.assertRaises(KeyboardInterrupt):
                service.run_forever()
        self.assertTrue((self.cfg.data_root / "case-a/image.tif").exists())
        self.assertFalse(sync_status(self.cfg)["manualRequestPending"])

    def test_overlapping_sync_source_and_cache_are_rejected(self):
        self.make_image(self.cfg.data_root)
        for root in (self.cfg.data_root, self.cfg.data_root.parent, self.cfg.data_root / "inside"):
            with patch("agh_api.image_sync.validate_case_folder"):
                with self.assertRaisesRegex(SourceConfigurationError, "non-overlapping"):
                    self.save("sync", root)

    def test_change_during_sync_returns_conflict_and_preserves_choice(self):
        self.save()
        original = source_settings(self.cfg)
        client, headers = self.login(create_app(self.cfg))
        with _process_lock(self.cfg.sync_state_dir / LOCK_FILENAME):
            response = client.put("/agh/api/admin/image-sync", headers=headers, json={"mode": "sync", "folderPath": str(self.root)})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(source_settings(self.cfg), original)

    def test_unavailable_sync_source_reports_error_and_preserves_cache(self):
        self.save("sync")
        worker = RemoteImageSync(self.cfg)
        worker.sync_once()
        self.root.rename(self.base / "offline")
        with self.assertLogs("agh_api.image_sync", level="ERROR"):
            with self.assertRaises(SyncConfigurationError):
                worker.sync_once()
        self.assertEqual(sync_status(self.cfg)["state"], "error")
        self.assertTrue((self.cfg.data_root / "case-a/image.tif").exists())

    def test_saved_direct_folder_does_not_fall_back_when_unavailable(self):
        self.save()
        self.root.rename(self.base / "offline")
        self.assertEqual(self.cfg.active_data_root, self.root)
        client, _ = self.login(create_app(self.cfg))
        self.assertEqual(client.get("/agh/api/cases").status_code, 404)
        self.assertFalse(self.root.exists())

    def test_switching_same_named_images_changes_browser_cache_identity(self):
        client, _ = self.login(create_app(self.cfg))
        self.save()
        endpoint = "/agh/api/cases/case-a/files/image.tif"
        old_meta = client.get(endpoint + "/meta").get_json()
        old_raw = client.get(endpoint + "/channels/0/raw?v=old")
        second = self.base / "second"
        second_image = self.make_image(second, value=99)
        stat = (self.root / "case-a/image.tif").stat()
        os.utime(second_image, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.save(folder=second)
        new_meta = client.get(endpoint + "/meta").get_json()
        new_raw = client.get(endpoint + "/channels/0/raw?v=new", headers={"If-None-Match": old_raw.headers["ETag"]})
        self.assertEqual(new_meta["sourceSize"], old_meta["sourceSize"])
        self.assertEqual(new_meta["sourceMtimeNs"], old_meta["sourceMtimeNs"])
        self.assertNotEqual(new_meta["sourceId"], old_meta["sourceId"])
        self.assertEqual(new_raw.status_code, 200)
        self.assertNotEqual(new_raw.data, old_raw.data)

    def test_analysis_uses_direct_folder_and_rejects_job_after_folder_changes(self):
        from agh_api.segmentation_service import execute_segmentation

        app = create_app(self.cfg)
        client, _ = self.login(app)
        self.save()
        # Analysis writes use the session's CSRF token too.
        token = client.get("/agh/api/session").get_json()["csrfToken"]
        response = client.post("/agh/api/cases/case-a/files/image.tif/analysis-runs", headers={"X-AGH-CSRF": token}, json={"zIndex": 0, "channelIndex": 0})
        self.assertEqual(response.status_code, 202, response.get_json())
        store = app.extensions["agh_analysis"]["store"]
        job = store.claim_next_run("test-worker")
        second = self.base / "second"
        second_image = self.make_image(second, value=99)
        stat = (self.root / "case-a/image.tif").stat()
        os.utime(second_image, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        self.save(folder=second)
        with self.assertRaisesRegex(RuntimeError, "folder changed"):
            execute_segmentation(self.cfg, job)


class WindowsFolderTests(unittest.TestCase):
    def test_drive_and_unc_paths_use_existing_mounts_including_custom_locations(self):
        with patch("agh_api.data_source._mounted_windows_paths", return_value=[
            ("R:\\", Path("/mnt/remote drive")),
            (r"\\server\share", Path("/srv/microscopy")),
        ]):
            self.assertEqual(resolve_folder(r"r:\AGH data"), Path("/mnt/remote drive/AGH data"))
            self.assertEqual(resolve_folder(r"\\SERVER\share\AGH_APP"), Path("/srv/microscopy/AGH_APP"))

    def test_wslpath_fallback_uses_literal_argument(self):
        with patch("agh_api.data_source._mounted_windows_paths", return_value=[]), patch("agh_api.data_source.subprocess.run") as run:
            run.return_value.stdout = "/mnt/r/AGH data\n"
            value = r"R:\AGH data"
            self.assertEqual(resolve_folder(value), Path("/mnt/r/AGH data"))
            self.assertEqual(run.call_args.args[0], ["wslpath", "-u", value])

    def test_unmounted_windows_share_has_actionable_error(self):
        with patch("agh_api.data_source._mounted_windows_paths", return_value=[]), patch("agh_api.data_source.subprocess.run", side_effect=subprocess.CalledProcessError(1, "wslpath")):
            with self.assertRaisesRegex(SourceConfigurationError, "Mount it in WSL"):
                resolve_folder(r"\\server\share\AGH_APP")

    def test_mount_table_decodes_spaces_backslashes_and_drvfs_aliases(self):
        table = (
            r"R:\134 /mnt/remote\040drive 9p rw,aname=drvfs;path=R:\134;uid=1000 0 0" + "\n"
            r"//server/share /srv/data cifs rw 0 0" + "\n"
        )
        with patch("pathlib.Path.read_text", return_value=table):
            mounts = _mounted_windows_paths()
        self.assertIn(("R:\\", Path("/mnt/remote drive")), mounts)
        self.assertIn(("//server/share", Path("/srv/data")), mounts)


if __name__ == "__main__":
    unittest.main()
