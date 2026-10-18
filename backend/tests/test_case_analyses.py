"""Batch run endpoints and saved, resumable, merged case analyses."""
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import numpy as np
import tifffile

from agh_api import create_app, gbm_thickness
from agh_api.analysis_artifacts import write_thickness_geometry_atomic
from agh_api.auth import UserStore
from agh_api.config import Config
from agh_api.segmentation_service import OPERATION

from test_case_analysis import sample_geometry


CALIBRATION = {"pixelSizeXUm": 0.5, "pixelSizeYUm": 0.5, "expansionEnabled": True, "expansionFactor": 2}


class CaseAnalysisBatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        data = base / "data"
        for case in ("case1", "case2"):
            (data / case).mkdir(parents=True)
            tifffile.imwrite(data / case / "60x.tif", np.zeros((2, 6, 12, 12), dtype=np.uint16), metadata={"axes": "CZYX"})
        checkpoint = base / "model.pt"
        checkpoint.write_bytes(b"synthetic test checkpoint")
        self.config = Config(
            data_root=data, ann_root=base / "annotations", users_file=base / "users.json",
            session_root=base / "sessions", login_state_file=base / "logins.json",
            audit_log_file=base / "audit.jsonl", collaboration_state_file=base / "collaboration.json",
            analysis_root=base / "analysis", analysis_db=base / "analysis" / "jobs.sqlite3",
            model_checkpoint=checkpoint, auth_required=False,
        )
        self.app = create_app(self.config)
        self.app.testing = True
        self.client = self.app.test_client()
        self.store = self.app.extensions["agh_analysis"]["store"]

    def tearDown(self):
        self.tmp.cleanup()

    def submit(self, *items):
        response = self.client.post("/agh/api/analysis-runs/batch", json={"runs": [
            {"case": case, "filename": "60x.tif", "zIndex": z, "channelIndex": channel}
            for case, z, channel in items
        ]})
        self.assertEqual(response.status_code, 202, response.get_json())
        return response.get_json()["runs"]

    def finish(self, run_id, *, empty=False):
        with self.store._connect() as conn:
            conn.execute("UPDATE analysis_runs SET status = 'RUNNING', worker_id = 'test' WHERE run_id = ?", (run_id,))
        write_thickness_geometry_atomic(self.config.analysis_root, run_id,
            gbm_thickness.thickness_geometry_to_arrays(sample_geometry(empty)), attempt=1)
        self.store.mark_succeeded(run_id, "test", {"artifactAttempt": 1, "thicknessGeometryAvailable": True})

    def analysis_body(self, cases=("case1",), gap=1, slices=(0, 2, 4)):
        return {
            "gap": gap,
            "images": [{"caseId": case, "filename": "60x.tif", "channelIndex": 1, "zCount": 6,
                        "gap": None, "calibration": CALIBRATION} for case in cases],
            "jobs": [{"caseId": case, "filename": "60x.tif", "zIndex": z} for case in cases for z in slices],
        }

    def test_batch_submission_reuses_runs_and_reports_item_errors(self):
        first = self.submit(("case1", 0, 1), ("case1", 1, 1))
        self.assertEqual([run["status"] for run in first], ["QUEUED", "QUEUED"])
        self.assertFalse(any(run["reused"] for run in first))
        again = self.submit(("case1", 0, 1), ("case1", 9, 1), ("missing", 0, 1))
        self.assertTrue(again[0]["reused"])
        self.assertEqual(again[0]["runId"], first[0]["runId"])
        self.assertEqual(again[1]["status"], "SUBMIT_ERROR")
        self.assertIn("zIndex", again[1]["error"]["message"])
        self.assertEqual(again[2]["status"], "SUBMIT_ERROR")

    def test_batch_validates_shape(self):
        for body in ({}, {"runs": []}, {"runs": [{"case": "case1", "filename": "60x.tif", "zIndex": -1, "channelIndex": 0}]},
                     {"runs": [{"case": "case1", "filename": "60x.tif", "zIndex": True, "channelIndex": 0}]}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post("/agh/api/analysis-runs/batch", json=body).status_code, 400)

    def test_lookup_returns_known_runs_only(self):
        run = self.submit(("case1", 0, 1))[0]
        missing = "00000000-0000-4000-8000-000000000000"
        result = self.client.post("/agh/api/analysis-runs/lookup", json={"runIds": [run["runId"], missing]}).get_json()
        self.assertEqual(list(result["runs"]), [run["runId"]])
        self.assertEqual(result["runs"][run["runId"]]["status"], "QUEUED")

    def test_cancel_only_affects_queued_runs_and_cancelled_runs_are_not_reused(self):
        queued, done = self.submit(("case1", 0, 1), ("case1", 1, 1))
        self.finish(done["runId"])
        result = self.client.post("/agh/api/analysis-runs/cancel", json={"runIds": [queued["runId"], done["runId"]]}).get_json()
        self.assertEqual(result["canceled"], [queued["runId"]])
        self.assertEqual(self.store.get_run(queued["runId"])["status"], "CANCELED")
        self.assertEqual(self.store.get_run(done["runId"])["status"], "SUCCEEDED")
        resubmitted = self.submit(("case1", 0, 1))[0]
        self.assertNotEqual(resubmitted["runId"], queued["runId"])
        self.assertEqual(resubmitted["status"], "QUEUED")
        latest = self.client.get("/agh/api/cases/case1/files/60x.tif/analysis-runs?latestPerZ=1").get_json()["runs"]
        self.assertNotIn("CANCELED", {run["status"] for run in latest})

    def test_coverage_reports_runs_per_slice_and_channel(self):
        queued, done = self.submit(("case1", 0, 1), ("case1", 3, 1))
        self.finish(done["runId"])
        coverage = self.client.post("/agh/api/analysis-coverage", json={"images": [
            {"case": "case1", "filename": "60x.tif", "channelIndex": 1},
            {"case": "case1", "filename": "60x.tif", "channelIndex": 0},
            {"case": "case1", "filename": "60x.tif", "channelIndex": 5},
            {"case": "nope", "filename": "60x.tif", "channelIndex": 0},
        ]}).get_json()["images"]
        self.assertEqual(coverage[0]["zCount"], 6)
        self.assertEqual({z: run["status"] for z, run in coverage[0]["runs"].items()}, {"0": "QUEUED", "3": "SUCCEEDED"})
        self.assertEqual(coverage[1]["runs"], {})
        self.assertIn("error", coverage[2])
        self.assertIn("error", coverage[3])

    def test_batch_distributions_measure_finished_runs(self):
        queued, done = self.submit(("case1", 0, 1), ("case1", 1, 1))
        self.finish(done["runId"])
        results = self.client.post("/agh/api/analysis-runs/distributions", json={"items": [
            {"runId": done["runId"], "calibration": CALIBRATION},
            {"runId": queued["runId"], "calibration": CALIBRATION},
            {"runId": done["runId"], "calibration": {"pixelSizeXUm": -1}},
        ]}).get_json()["results"]
        self.assertEqual(results[0]["distribution"]["counts"], [3, 1, 1])
        self.assertEqual(results[1]["status"], 409)
        self.assertEqual(results[2]["status"], 400)

    def test_saved_analysis_lifecycle_merge_interrupt_resume(self):
        created = self.client.post("/agh/api/case-analyses", json=self.analysis_body())
        self.assertEqual(created.status_code, 201, created.get_json())
        analysis = created.get_json()
        self.assertFalse(analysis["merged"])
        self.assertEqual(analysis["status"], "running")
        self.assertEqual(analysis["counts"]["queued"], 3)
        self.assertEqual([job["zIndex"] for job in analysis["jobs"]], [0, 2, 4])
        self.assertEqual(analysis["jobs"][0]["id"], '["case1","60x.tif"]:0')

        merged = self.client.post("/agh/api/case-analyses", json={**self.analysis_body(), "start": False})
        self.assertEqual(merged.status_code, 200)
        self.assertEqual(merged.get_json()["id"], analysis["id"])
        self.assertTrue(merged.get_json()["merged"])
        other_gap = self.client.post("/agh/api/case-analyses", json=self.analysis_body(gap=2, slices=(0, 3))).get_json()
        self.assertNotEqual(other_gap["id"], analysis["id"])
        listed = self.client.get("/agh/api/case-analyses").get_json()["analyses"]
        self.assertEqual(len(listed), 2)
        self.assertNotIn("jobs", listed[0])

        interrupted = self.client.post(f"/agh/api/case-analyses/{analysis['id']}/interrupt").get_json()
        self.assertEqual(interrupted["status"], "interrupted")
        # Z1 (index 0) is shared with the still-active gap-2 analysis, so it stays queued.
        self.assertEqual(interrupted["canceled"], 2)
        self.assertEqual(interrupted["kept"], 1)
        statuses = {job["zIndex"]: job["run"]["status"] for job in interrupted["jobs"]}
        self.assertEqual(statuses, {0: "QUEUED", 2: "CANCELED", 4: "CANCELED"})

        resumed = self.client.post(f"/agh/api/case-analyses/{analysis['id']}/resume").get_json()
        self.assertEqual(resumed["status"], "running")
        self.assertEqual(resumed["counts"]["queued"], 3)
        self.assertEqual(resumed["submitErrors"], {})

    def test_interrupted_analysis_becomes_complete_when_other_work_finishes_its_slices(self):
        analysis = self.client.post("/agh/api/case-analyses", json=self.analysis_body()).get_json()
        self.client.post(f"/agh/api/case-analyses/{analysis['id']}/interrupt")
        for run in self.submit(("case1", 0, 1), ("case1", 2, 1), ("case1", 4, 1)):
            self.finish(run["runId"])
        reopened = self.client.get(f"/agh/api/case-analyses/{analysis['id']}").get_json()
        self.assertEqual(reopened["status"], "complete")
        self.assertEqual(reopened["counts"]["succeeded"], 3)
        self.assertEqual(self.client.get("/agh/api/case-analyses").get_json()["analyses"][0]["status"], "complete")

    def test_cancel_selected_jobs_and_delete(self):
        analysis = self.client.post("/agh/api/case-analyses", json=self.analysis_body(cases=("case1", "case2"))).get_json()
        case2_jobs = [job["id"] for job in analysis["jobs"] if job["caseId"] == "case2"]
        result = self.client.post(f"/agh/api/case-analyses/{analysis['id']}/cancel", json={"jobIds": case2_jobs}).get_json()
        self.assertEqual(result["canceled"], 3)
        self.assertEqual(result["status"], "running")
        self.assertEqual(result["counts"]["canceled"], 3)
        deleted = self.client.delete(f"/agh/api/case-analyses/{analysis['id']}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.get_json()["canceled"], 3)
        self.assertEqual(self.client.get(f"/agh/api/case-analyses/{analysis['id']}").status_code, 404)
        self.assertEqual(self.client.get("/agh/api/case-analyses/not-a-uuid").status_code, 400)

    def test_analysis_definition_validation(self):
        body = self.analysis_body()
        bad = [
            {**body, "gap": 9},
            {**body, "images": []},
            {**body, "jobs": [{"caseId": "case1", "filename": "60x.tif", "zIndex": 6}]},
            {**body, "jobs": [{"caseId": "other", "filename": "60x.tif", "zIndex": 0}]},
            {**body, "images": body["images"] * 2},
            {**body, "images": [{**body["images"][0], "calibration": {**CALIBRATION, "expansionFactor": 0}}]},
            {**body, "images": [{**body["images"][0], "caseId": "missing"}],
             "jobs": [{"caseId": "missing", "filename": "60x.tif", "zIndex": 0}]},
        ]
        for payload in bad:
            with self.subTest(payload=payload):
                self.assertEqual(self.client.post("/agh/api/case-analyses", json=payload).status_code, 400)

    def test_saved_analyses_are_private_to_their_owner(self):
        app = create_app(replace(self.config, auth_required=True))
        users = UserStore(self.config.users_file)
        clients = {}
        for name in ("alice", "bob"):
            users.add(name, "test password")
            client = app.test_client()
            login = client.post("/agh/api/login", json={"username": name, "password": "test password"})
            clients[name] = (client, {"X-AGH-CSRF": login.get_json()["csrfToken"]})
        alice, alice_headers = clients["alice"]
        bob, bob_headers = clients["bob"]
        self.assertEqual(alice.post("/agh/api/case-analyses", json=self.analysis_body()).status_code, 403)
        created = alice.post("/agh/api/case-analyses", headers=alice_headers, json=self.analysis_body()).get_json()
        self.assertEqual(bob.get("/agh/api/case-analyses").get_json()["analyses"], [])
        self.assertEqual(bob.get(f"/agh/api/case-analyses/{created['id']}").status_code, 404)
        self.assertEqual(bob.post(f"/agh/api/case-analyses/{created['id']}/interrupt", headers=bob_headers).status_code, 404)
        self.assertEqual(len(alice.get("/agh/api/case-analyses").get_json()["analyses"]), 1)


if __name__ == "__main__":
    unittest.main()
