import tempfile
import unittest
from pathlib import Path

from agh_api.errors import BadRequest, NotFound
from agh_api.path_guard import image_path, list_cases, list_tiff_files


class PathGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.case = self.root / "case A"
        self.case.mkdir()
        (self.case / "image.tif").write_bytes(b"fake")
        (self.case / "notes.txt").write_text("nope", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_lists_only_direct_cases_and_tiffs(self):
        self.assertEqual(list_cases(self.root), ["case A"])
        self.assertEqual(list_tiff_files(self.root, "case A"), ["image.tif"])

    def test_rejects_case_traversal(self):
        with self.assertRaises(BadRequest):
            list_tiff_files(self.root, "../case A")

    def test_rejects_filename_traversal(self):
        with self.assertRaises(BadRequest):
            image_path(self.root, "case A", "../secret.tif")

    def test_rejects_non_tiff_extension(self):
        with self.assertRaises(BadRequest):
            image_path(self.root, "case A", "notes.txt")

    def test_missing_case_is_not_found(self):
        with self.assertRaises(NotFound):
            list_tiff_files(self.root, "missing")


if __name__ == "__main__":
    unittest.main()
