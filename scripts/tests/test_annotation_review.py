"""Persistence and binding checks for manual review pages."""

import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
import socket
import threading
from http.server import HTTPServer
from pathlib import Path
from urllib.request import urlopen

spec = importlib.util.spec_from_file_location(
    "annotation_review", Path(__file__).resolve().parents[1] / "annotation_review.py"
)
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class ManualReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.case = {
            "text_id": 1,
            "source": "бер ике",
            "source_sha256": hashlib.sha256("бер ике".encode()).hexdigest(),
            "corrections": [
                {"id": "edit-1", "start": 0, "end": 3, "original": "бер"},
                {"id": "edit-2", "start": 4, "end": 4, "original": ""},
            ],
            "error_types": [{"id": 1}],
        }
        self.request = {
            "case_hash": review.digest(self.case),
            "previous_revision": None,
            "state": "draft",
            "corrections": [
                {"id": "edit-1", "replacement": "өч", "error_type_id": 1, "status": "pending"},
                {"id": "edit-2", "replacement": "- ", "error_type_id": 1, "status": "accepted"},
            ],
            "target": "өч - ике",
            "note": "Needs review",
        }

    def test_draft_round_trip_preserves_pending_corrections_and_history(self):
        body = review.save_decision(self.root, self.case, self.request)
        loaded = json.loads((self.root / "decisions/text-1.json").read_text())
        self.assertEqual(loaded, body)
        self.assertEqual(loaded["corrections"], self.request["corrections"])
        self.request["previous_revision"] = 1
        self.request["note"] = "Updated note"
        review.save_decision(self.root, self.case, self.request)
        versions = sorted((self.root / "history/text-1").glob("*.json"))
        self.assertEqual(len(versions), 2)
        self.assertEqual(json.loads(versions[0].read_text())["note"], "Needs review")

    def test_confirmation_requires_explicit_decisions(self):
        self.request["state"] = "confirmed"
        with self.assertRaisesRegex(ValueError, "every correction"):
            review.save_decision(self.root, self.case, self.request)
        self.assertFalse((self.root / "decisions/text-1.json").exists())
        self.request["corrections"][0]["status"] = "accepted"
        self.assertEqual(review.save_decision(self.root, self.case, self.request)["state"], "confirmed")

    def test_rejection_restores_original_span(self):
        self.request["corrections"][0]["status"] = "rejected"
        self.request["target"] = "бер - ике"
        saved = review.save_decision(self.root, self.case, self.request)
        self.assertEqual(saved["target"], "бер - ике")

    def test_stale_tab_cannot_overwrite_saved_work(self):
        review.save_decision(self.root, self.case, self.request)
        with self.assertRaisesRegex(ValueError, "another tab"):
            review.save_decision(self.root, self.case, self.request)

    def test_stale_case_and_missing_corrections_and_preview_mismatch_are_rejected(self):
        for field, value, message in (
            ("case_hash", "wrong", "Case changed"),
            ("corrections", self.request["corrections"][:1], "every correction"),
            ("target", "incorrect preview", "Preview differs"),
        ):
            request = copy.deepcopy(self.request)
            request[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, message):
                review.save_decision(self.root, self.case, request)

    def test_invalid_label_is_rejected(self):
        self.request["corrections"][0]["error_type_id"] = 99
        with self.assertRaisesRegex(ValueError, "error type"):
            review.save_decision(self.root, self.case, self.request)

    def test_empty_insert_cannot_be_confirmed_but_can_be_saved_as_draft(self):
        self.request["corrections"][1]["replacement"] = ""
        self.request["target"] = "өч ике"
        review.save_decision(self.root, self.case, self.request)
        self.request["previous_revision"] = 1
        self.request["state"] = "confirmed"
        self.request["corrections"][0]["status"] = "accepted"
        with self.assertRaisesRegex(ValueError, "must change the text"):
            review.save_decision(self.root, self.case, self.request)

    def test_source_binding_is_verified_on_load(self):
        folder = self.root / "cases"
        folder.mkdir()
        path = folder / "text-1.json"
        path.write_text(json.dumps(self.case))
        self.assertEqual(review.load_case(self.root, 1), self.case)
        self.case["corrections"][0]["original"] = "wrong"
        path.write_text(json.dumps(self.case))
        with self.assertRaisesRegex(ValueError, "source span"):
            review.load_case(self.root, 1)

    def test_moved_text_is_inserted_and_removed_as_one_decision(self):
        self.case["corrections"] = [{
            "id": "move-1", "start": 0, "end": 0, "original": "",
            "linked_removals": [{"start": 3, "end": 7, "original": " ике"}],
        }]
        decisions = [{"id": "move-1", "status": "accepted", "replacement": "ике "}]
        self.assertEqual(review.render_target(self.case, decisions), "ике бер")
        decisions[0]["status"] = "rejected"
        self.assertEqual(review.render_target(self.case, decisions), "бер ике")

    def test_linked_removal_cannot_overlap_another_correction(self):
        self.case["corrections"][0]["linked_removals"] = [
            {"start": 4, "end": 7, "original": "ике"}
        ]
        self.case["corrections"][1].update(start=4, end=7, original="ике")
        folder = self.root / "cases"
        folder.mkdir()
        (folder / "text-1.json").write_text(json.dumps(self.case))
        with self.assertRaisesRegex(ValueError, "overlapping"):
            review.load_case(self.root, 1)

    def test_idle_browser_connection_does_not_block_review_pages(self):
        accepted = threading.Event()

        class Probe(review.make_handler(self.root)):
            def setup(self):
                super().setup()
                accepted.set()

            def log_message(self, *_):
                pass

        server = HTTPServer(("127.0.0.1", 0), Probe)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        idle = socket.create_connection(server.server_address, timeout=1)
        try:
            self.assertTrue(accepted.wait(1))
            with urlopen(f"http://127.0.0.1:{server.server_port}/", timeout=4) as response:
                self.assertEqual(response.status, 200)
        finally:
            idle.close()
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
