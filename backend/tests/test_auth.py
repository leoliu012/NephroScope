import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import tifffile

from agh_api import create_app
from agh_api.auth import (
    LoginRateLimiter,
    SessionStore,
    UserError,
    UserStore,
)
from agh_api.config import Config


def make_config(base: Path, **overrides) -> Config:
    data_root = base / "data"
    ann_root = base / "annotations"
    state = base / "state"
    case_dir = data_root / "case1"
    case_dir.mkdir(parents=True, exist_ok=True)
    tifffile.imwrite(
        case_dir / "image.tif",
        np.arange(12, dtype=np.uint16).reshape(3, 4),
        metadata={"axes": "YX"},
    )
    params = dict(
        data_root=data_root,
        ann_root=ann_root,
        users_file=state / "users.json",
        session_root=state / "sessions",
        login_state_file=state / "login_attempts.json",
        audit_log_file=state / "audit_events.jsonl",
        collaboration_state_file=state / "collaboration_state.json",
        auth_required=True,
        login_max_attempts=4,
        login_window_seconds=900,
        login_lockout_seconds=900,
    )
    params.update(overrides)
    return Config(**params)


def basic_header(username, password):
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


# --- Unit: UserStore ---------------------------------------------------------

class UserStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = UserStore(Path(self.tmp.name) / "users.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_and_verify(self):
        self.store.add("alice", "correct horse battery", first_name="Alice", last_name="Ng")
        self.assertEqual(self.store.verify("alice", "correct horse battery"), "alice")
        self.assertIsNone(self.store.verify("alice", "wrong password!!"))
        self.assertIsNone(self.store.verify("nobody", "correct horse battery"))
        user = self.store.list_users()[0]
        self.assertEqual(user["firstName"], "Alice")
        self.assertEqual(user["lastName"], "Ng")
        self.assertEqual(user["displayName"], "Alice Ng")

    def test_password_is_hashed_not_stored_plaintext(self):
        self.store.add("alice", "correct horse battery")
        raw = (Path(self.tmp.name) / "users.json").read_text(encoding="utf-8")
        self.assertNotIn("correct horse battery", raw)
        self.assertIn("pbkdf2:sha256", raw)

    def test_username_and_password_validation(self):
        with self.assertRaises(UserError):
            self.store.add("bad user", "correct horse battery")  # whitespace
        with self.assertRaises(UserError):
            self.store.add("bad:user", "correct horse battery")  # colon
        self.assertEqual(self.store.add("bob", "1234"), "bob")
        with self.assertRaises(UserError):
            self.store.add("alice", "123")  # < 4 chars

    def test_duplicate_requires_force(self):
        self.store.add("alice", "correct horse battery")
        with self.assertRaises(UserError):
            self.store.add("alice", "another good password")
        # force overwrites and preserves createdAt
        created = self.store.list_users()[0]["createdAt"]
        self.store.add("alice", "another good password", allow_update=True)
        self.assertEqual(self.store.verify("alice", "another good password"), "alice")
        self.assertEqual(self.store.list_users()[0]["createdAt"], created)

    def test_roles_default_and_can_be_changed(self):
        self.store.add("alice", "correct horse battery")
        self.assertEqual(self.store.role("alice"), "annotator")
        self.store.set_role("alice", "viewer")
        self.assertEqual(self.store.role("alice"), "viewer")
        self.assertEqual(self.store.list_users()[0]["role"], "viewer")
        with self.assertRaises(UserError):
            self.store.set_role("alice", "wizard")

    def test_disable_blocks_login_then_enable_restores(self):
        self.store.add("alice", "correct horse battery")
        self.store.set_disabled("alice", True)
        self.assertIsNone(self.store.verify("alice", "correct horse battery"))
        self.store.set_disabled("alice", False)
        self.assertEqual(self.store.verify("alice", "correct horse battery"), "alice")

    def test_set_password_and_remove(self):
        self.store.add("alice", "correct horse battery")
        self.store.set_password("alice", "brand new password")
        self.assertIsNone(self.store.verify("alice", "correct horse battery"))
        self.assertEqual(self.store.verify("alice", "brand new password"), "alice")
        self.store.remove("alice")
        self.assertFalse(self.store.exists("alice"))
        with self.assertRaises(UserError):
            self.store.set_password("alice", "no such user now")

    def test_set_profile_requires_first_and_last_name(self):
        self.store.add("alice", "correct horse battery")
        with self.assertRaises(UserError):
            self.store.set_profile("alice", "Alice", "")
        self.store.set_profile("alice", "Alice", "Ng")
        self.assertEqual(self.store.profile("alice")["displayName"], "Alice Ng")


# --- Unit: SessionStore ------------------------------------------------------

class SessionStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = SessionStore(Path(self.tmp.name) / "sessions", ttl_seconds=3600, idle_seconds=1800)

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_load_destroy(self):
        token, csrf = self.store.create("alice")
        record = self.store.load(token)
        self.assertIsNotNone(record)
        self.assertEqual(record["username"], "alice")
        self.assertEqual(record["csrf"], csrf)
        self.store.destroy(token)
        self.assertIsNone(self.store.load(token))

    def test_destroy_user_removes_all_sessions_for_account(self):
        alice_one, _ = self.store.create("alice")
        alice_two, _ = self.store.create("alice")
        bob, _ = self.store.create("bob")
        self.assertEqual(self.store.destroy_user("alice"), 2)
        self.assertIsNone(self.store.load(alice_one))
        self.assertIsNone(self.store.load(alice_two))
        self.assertIsNotNone(self.store.load(bob))

    def test_only_hash_of_token_on_disk(self):
        token, _ = self.store.create("alice")
        files = list((Path(self.tmp.name) / "sessions").glob("*.json"))
        self.assertEqual(len(files), 1)
        # The raw token must not appear anywhere on disk.
        self.assertNotIn(token, files[0].name)
        self.assertNotIn(token, files[0].read_text(encoding="utf-8"))

    def test_unknown_or_tampered_token_is_rejected(self):
        self.assertIsNone(self.store.load("not-a-real-token"))
        token, _ = self.store.create("alice")
        self.assertIsNone(self.store.load(token + "x"))

    def test_absolute_expiry(self):
        base = 1_000_000.0
        with mock.patch("agh_api.auth._now", return_value=base):
            token, _ = self.store.create("alice")
        with mock.patch("agh_api.auth._now", return_value=base + 3601):
            self.assertIsNone(self.store.load(token))

    def test_idle_timeout(self):
        base = 1_000_000.0
        with mock.patch("agh_api.auth._now", return_value=base):
            token, _ = self.store.create("alice")
        with mock.patch("agh_api.auth._now", return_value=base + 1801):
            self.assertIsNone(self.store.load(token))


# --- Unit: LoginRateLimiter --------------------------------------------------

class RateLimiterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.limiter = LoginRateLimiter(
            Path(self.tmp.name) / "attempts.json",
            max_attempts=3,
            window_seconds=900,
            lockout_seconds=600,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_lockout_after_threshold(self):
        keys = ["ip:1.2.3.4", "user:alice"]
        self.assertEqual(self.limiter.retry_after(keys), 0)
        self.limiter.record_failure(keys)
        self.limiter.record_failure(keys)
        self.assertEqual(self.limiter.retry_after(keys), 0)
        self.limiter.record_failure(keys)  # third failure trips the lock
        self.assertGreater(self.limiter.retry_after(keys), 0)

    def test_success_clears_counters(self):
        keys = ["ip:1.2.3.4", "user:alice"]
        self.limiter.record_failure(keys)
        self.limiter.record_failure(keys)
        self.limiter.record_success(keys)
        self.limiter.record_failure(keys)
        self.assertEqual(self.limiter.retry_after(keys), 0)

    def test_lock_expires(self):
        keys = ["ip:1.2.3.4"]
        base = 2_000_000.0
        with mock.patch("agh_api.auth._now", return_value=base):
            for _ in range(3):
                self.limiter.record_failure(keys)
            self.assertGreater(self.limiter.retry_after(keys), 0)
        with mock.patch("agh_api.auth._now", return_value=base + 601):
            self.assertEqual(self.limiter.retry_after(keys), 0)


# --- Unit: Configuration -----------------------------------------------------

class ConfigTests(unittest.TestCase):
    def test_auth_is_required_by_default(self):
        self.assertTrue(Config(data_root=Path("/tmp/data"), ann_root=Path("/tmp/ann")).auth_required)

    @mock.patch.dict("os.environ", {"AGH_AUTH_REQUIRED": "0"}, clear=True)
    def test_env_auth_bypass_requires_explicit_acknowledgement(self):
        self.assertTrue(Config.from_env().auth_required)

    @mock.patch.dict("os.environ", {
        "AGH_AUTH_REQUIRED": "0",
        "AGH_ALLOW_INSECURE_AUTH_BYPASS": "I_UNDERSTAND_THIS_EXPOSES_DATA",
    }, clear=True)
    def test_env_auth_bypass_can_be_explicitly_acknowledged(self):
        self.assertFalse(Config.from_env().auth_required)


# --- Integration: API auth flow ----------------------------------------------

class AuthApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.cfg = make_config(self.base)
        self.app = create_app(self.cfg)
        self.app.testing = True
        self.client = self.app.test_client()
        # Seed one account.
        UserStore(self.cfg.users_file).add("leo", "correct horse battery")

    def tearDown(self):
        self.tmp.cleanup()

    def login(self, username="leo", password="correct horse battery"):
        return self.client.post("/agh/api/login", json={"username": username, "password": password})

    def test_health_is_public(self):
        res = self.client.get("/agh/api/health")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.get_json()["ok"])

    def test_protected_endpoint_requires_session(self):
        res = self.client.get("/agh/api/cases")
        self.assertEqual(res.status_code, 401)
        # No browser challenge: the SPA must render its own login screen.
        self.assertNotIn("WWW-Authenticate", res.headers)

    def test_session_reports_unauthenticated_without_cookie(self):
        res = self.client.get("/agh/api/session")
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.get_json()["authenticated"])

    def test_login_bad_credentials_rejected(self):
        res = self.login(password="the wrong password")
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.get_json()["error"], "Invalid username or password")
        # Failed login must not set a session cookie.
        issued = [h for h in res.headers.get_all("Set-Cookie") if h.startswith("agh_session=") and not h.startswith("agh_session=;")]
        self.assertEqual(issued, [])

    def test_login_success_then_access_and_session(self):
        res = self.login()
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertTrue(body["authenticated"])
        self.assertEqual(body["user"], "leo")
        self.assertTrue(body["csrfToken"])

        # Cookie now carried by the test client -> protected endpoint works.
        cases = self.client.get("/agh/api/cases")
        self.assertEqual(cases.status_code, 200)

        session = self.client.get("/agh/api/session")
        self.assertTrue(session.get_json()["authenticated"])
        self.assertEqual(session.get_json()["user"], "leo")
        self.assertEqual(session.get_json()["role"], "annotator")
        self.assertIn("firstName", session.get_json())

    def test_disabled_account_cannot_log_in(self):
        UserStore(self.cfg.users_file).set_disabled("leo", True)
        res = self.login()
        self.assertEqual(res.status_code, 401)

    def test_csrf_required_for_mutations(self):
        self.login()
        payload = {
            "revision": 0,
            "annotations": [{"id": "a1", "type": "rect", "coords": [1, 2, 3, 4], "color": "#ffee55"}],
        }
        # Without the CSRF header the write is refused.
        no_csrf = self.client.put("/agh/api/cases/case1/files/image.tif/annotations", json=payload)
        self.assertEqual(no_csrf.status_code, 403)

        # With the token returned by /session the write succeeds.
        token = self.client.get("/agh/api/session").get_json()["csrfToken"]
        ok = self.client.put(
            "/agh/api/cases/case1/files/image.tif/annotations",
            json=payload,
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(ok.status_code, 200)

    def test_updated_by_is_session_identity_not_client_supplied(self):
        self.login()
        token = self.client.get("/agh/api/session").get_json()["csrfToken"]
        payload = {
            "revision": 0,
            "updatedBy": "attacker",  # forged in the body
            "annotations": [{"id": "a1", "type": "point", "coords": [1, 2], "color": "#ffee55"}],
        }
        res = self.client.put(
            "/agh/api/cases/case1/files/image.tif/annotations",
            json=payload,
            headers={"X-AGH-CSRF": token, "X-AGH-User": "attacker", "X-Remote-User": "attacker"},
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json()["updatedBy"], "leo")

    def test_logout_invalidates_session(self):
        self.login()
        self.assertEqual(self.client.get("/agh/api/cases").status_code, 200)
        out = self.client.post("/agh/api/logout")
        self.assertEqual(out.status_code, 200)
        self.assertFalse(out.get_json()["authenticated"])
        self.assertEqual(self.client.get("/agh/api/cases").status_code, 401)

    def test_user_can_change_own_password_after_current_password_check(self):
        login = self.login()
        token = login.get_json()["csrfToken"]

        mismatch = self.client.post(
            "/agh/api/account/password",
            json={
                "currentPassword": "correct horse battery",
                "newPassword": "1234",
                "confirmPassword": "1235",
            },
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(mismatch.status_code, 400)

        wrong_current = self.client.post(
            "/agh/api/account/password",
            json={
                "currentPassword": "wrong password",
                "newPassword": "1234",
                "confirmPassword": "1234",
            },
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(wrong_current.status_code, 403)

        changed = self.client.post(
            "/agh/api/account/password",
            json={
                "currentPassword": "correct horse battery",
                "newPassword": "1234",
                "confirmPassword": "1234",
            },
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(self.client.get("/agh/api/cases").status_code, 401)

        self.client.post("/agh/api/logout")
        self.assertEqual(self.login(password="correct horse battery").status_code, 401)
        self.assertEqual(self.login(password="1234").status_code, 200)

    def test_user_can_change_own_profile(self):
        token = self.login().get_json()["csrfToken"]
        missing = self.client.post(
            "/agh/api/account/profile",
            json={"firstName": "Leo", "lastName": ""},
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(missing.status_code, 400)

        changed = self.client.post(
            "/agh/api/account/profile",
            json={"firstName": "Leo", "lastName": "Zhao"},
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.get_json()["displayName"], "Leo Zhao")
        self.assertEqual(UserStore(self.cfg.users_file).profile("leo")["displayName"], "Leo Zhao")

    def test_rate_limit_locks_out_repeated_failures(self):
        for _ in range(self.cfg.login_max_attempts):
            self.login(password="still wrong here")
        blocked = self.login(password="still wrong here")
        self.assertEqual(blocked.status_code, 429)
        self.assertIn("Retry-After", blocked.headers)
        # Even correct credentials are refused while locked.
        self.assertEqual(self.login().status_code, 429)

    def test_basic_auth_disabled_by_default(self):
        res = self.client.get("/agh/api/cases", headers=basic_header("leo", "correct horse battery"))
        self.assertEqual(res.status_code, 401)

    def test_basic_auth_when_explicitly_enabled(self):
        with tempfile.TemporaryDirectory() as other:
            base = Path(other)
            cfg = make_config(base, allow_basic_auth=True)
            app = create_app(cfg)
            app.testing = True
            client = app.test_client()
            UserStore(cfg.users_file).add("leo", "correct horse battery")
            ok = client.get("/agh/api/cases", headers=basic_header("leo", "correct horse battery"))
            self.assertEqual(ok.status_code, 200)
            bad = client.get("/agh/api/cases", headers=basic_header("leo", "nope nope nope"))
            self.assertEqual(bad.status_code, 401)

    def test_viewer_role_is_read_only(self):
        UserStore(self.cfg.users_file).set_role("leo", "viewer")
        self.login()
        self.assertEqual(self.client.get("/agh/api/cases").status_code, 200)
        token = self.client.get("/agh/api/session").get_json()["csrfToken"]
        denied = self.client.put(
            "/agh/api/cases/case1/files/image.tif/annotations",
            json={"revision": 0, "annotations": []},
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(denied.status_code, 403)

    def test_only_admin_annotator_and_viewer_roles_are_exposed(self):
        UserStore(self.cfg.users_file).set_role("leo", "admin")
        users = UserStore(self.cfg.users_file)
        self.assertEqual(users.list_users()[0]["role"], "admin")
        with self.assertRaises(UserError):
            users.set_role("leo", "upload_agent")

    def test_audit_log_records_login_and_annotation_save(self):
        res = self.login()
        token = res.get_json()["csrfToken"]
        saved = self.client.put(
            "/agh/api/cases/case1/files/image.tif/annotations",
            json={"revision": 0, "annotations": [{"id": "a1", "type": "point", "coords": [1, 2]}]},
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(saved.status_code, 200)

        events = [
            json.loads(line)
            for line in self.cfg.audit_log_file.read_text(encoding="utf-8").splitlines()
        ]
        actions = [event["action"] for event in events]
        self.assertIn("LOGIN", actions)
        self.assertIn("SAVE_ANNOTATION", actions)
        save_event = next(event for event in events if event["action"] == "SAVE_ANNOTATION")
        self.assertEqual(save_event["actor"], "leo")
        self.assertEqual(save_event["case_id"], "case1")
        self.assertEqual(save_event["filename"], "image.tif")
        self.assertEqual(save_event["annotation_revision_before"], 0)
        self.assertEqual(save_event["annotation_revision_after"], 1)
        self.assertTrue(save_event["ip_hash"])
        self.assertIn("user_agent_hash", save_event)

    def test_export_audit_records_supported_formats_and_options(self):
        token = self.login().get_json()["csrfToken"]
        headers = {"X-AGH-CSRF": token}
        for export_format in ("pdf", "png", "jpeg"):
            response = self.client.post(
                "/agh/api/audit/export",
                json={
                    "caseId": "case1",
                    "filename": "image.tif",
                    "format": export_format,
                    "includeAnnotations": True,
                    "includeAnnotationNames": False,
                    "includeSegmentationPredictions": True,
                },
                headers=headers,
            )
            self.assertEqual(response.status_code, 200)

        invalid = self.client.post(
            "/agh/api/audit/export",
            json={"format": "bmp"},
            headers=headers,
        )
        self.assertEqual(invalid.status_code, 400)

        events = [
            json.loads(line)
            for line in self.cfg.audit_log_file.read_text(encoding="utf-8").splitlines()
        ]
        exports = [event for event in events if event["action"].startswith("EXPORT_")]
        self.assertEqual([event["action"] for event in exports], ["EXPORT_PDF", "EXPORT_PNG", "EXPORT_JPEG"])
        self.assertEqual(exports[-1]["case_id"], "case1")
        self.assertEqual(exports[-1]["filename"], "image.tif")
        self.assertEqual(
            exports[-1]["details"],
            {
                "includeAnnotations": True,
                "includeAnnotationNames": False,
                "includeSegmentationPredictions": True,
            },
        )

    def test_admin_user_management_requires_admin_role(self):
        self.login()
        denied = self.client.get("/agh/api/admin/users")
        self.assertEqual(denied.status_code, 403)

    def test_image_sync_controls_require_admin_role(self):
        token = self.login().get_json()["csrfToken"]
        self.assertEqual(self.client.get("/agh/api/admin/image-sync").status_code, 403)
        self.assertEqual(
            self.client.post("/agh/api/admin/image-sync", headers={"X-AGH-CSRF": token}).status_code,
            403,
        )

        UserStore(self.cfg.users_file).set_role("leo", "admin")
        admin_client = self.app.test_client()
        admin_login = admin_client.post("/agh/api/login", json={"username": "leo", "password": "correct horse battery"})
        self.assertEqual(admin_login.status_code, 200)
        status = admin_client.get("/agh/api/admin/image-sync")
        self.assertEqual(status.status_code, 200)
        self.assertFalse(status.get_json()["configured"])

    def test_admin_image_sync_is_a_pending_queue_request(self):
        with tempfile.TemporaryDirectory() as other:
            base = Path(other)
            remote = base / "remote"
            remote.mkdir()
            cfg = make_config(base, remote_data_root=remote, sync_state_dir=base / "sync-state")
            app = create_app(cfg)
            app.testing = True
            client = app.test_client()
            users = UserStore(cfg.users_file)
            users.add("leo", "correct horse battery")
            users.set_role("leo", "admin")
            login = client.post("/agh/api/login", json={"username": "leo", "password": "correct horse battery"})

            queued = client.post("/agh/api/admin/image-sync", headers={"X-AGH-CSRF": login.get_json()["csrfToken"]})

            self.assertEqual(queued.status_code, 202)
            self.assertTrue(queued.get_json()["manualRequestPending"])
            events = client.get("/agh/api/admin/audit-events").get_json()["events"]
            event = next(item for item in events if item["action"] == "IMAGE_SYNC_QUEUED")
            self.assertEqual(event["result"], "pending")

    def test_admin_can_manage_users_and_view_audit_events(self):
        UserStore(self.cfg.users_file).set_role("leo", "admin")
        login = self.login()
        token = login.get_json()["csrfToken"]

        users = self.client.get("/agh/api/admin/users")
        self.assertEqual(users.status_code, 200)
        self.assertEqual(users.get_json()["roles"], ["admin", "annotator", "viewer"])

        created = self.client.post(
            "/agh/api/admin/users",
            json={"username": "mira", "password": "1234", "firstName": "Mira", "lastName": "Patel", "role": "viewer"},
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(created.status_code, 200)
        self.assertTrue(UserStore(self.cfg.users_file).exists("mira"))
        self.assertEqual(UserStore(self.cfg.users_file).role("mira"), "viewer")
        self.assertEqual(UserStore(self.cfg.users_file).profile("mira")["displayName"], "Mira Patel")

        mira_client = self.app.test_client()
        mira_login = mira_client.post("/agh/api/login", json={"username": "mira", "password": "1234"})
        self.assertEqual(mira_login.status_code, 200)
        self.assertEqual(mira_client.get("/agh/api/cases").status_code, 200)

        reset = self.client.post(
            "/agh/api/admin/users/mira/password",
            json={"password": "5678", "confirmPassword": "5678"},
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(UserStore(self.cfg.users_file).verify("mira", "5678"), "mira")
        self.assertEqual(mira_client.get("/agh/api/cases").status_code, 401)

        mira_client = self.app.test_client()
        mira_login = mira_client.post("/agh/api/login", json={"username": "mira", "password": "5678"})
        self.assertEqual(mira_login.status_code, 200)
        self.assertEqual(mira_client.get("/agh/api/cases").status_code, 200)

        changed = self.client.patch(
            "/agh/api/admin/users/mira",
            json={"role": "annotator", "firstName": "Mira", "lastName": "Chen", "disabled": True},
            headers={"X-AGH-CSRF": token},
        )
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(UserStore(self.cfg.users_file).role("mira"), "annotator")
        self.assertEqual(UserStore(self.cfg.users_file).profile("mira")["displayName"], "Mira Chen")
        self.assertEqual(mira_client.get("/agh/api/cases").status_code, 401)

        events = self.client.get("/agh/api/admin/audit-events?limit=20")
        self.assertEqual(events.status_code, 200)
        actions = [event["action"] for event in events.get_json()["events"]]
        self.assertIn("CREATE_ACCOUNT", actions)
        self.assertIn("CHANGE_ROLE", actions)

        deleted = self.client.delete("/agh/api/admin/users/mira", headers={"X-AGH-CSRF": token})
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(UserStore(self.cfg.users_file).exists("mira"))

    def test_admin_cannot_delete_self(self):
        UserStore(self.cfg.users_file).set_role("leo", "admin")
        token = self.login().get_json()["csrfToken"]
        deleted = self.client.delete("/agh/api/admin/users/leo", headers={"X-AGH-CSRF": token})
        self.assertEqual(deleted.status_code, 400)
        self.assertTrue(UserStore(self.cfg.users_file).exists("leo"))


if __name__ == "__main__":
    unittest.main()
