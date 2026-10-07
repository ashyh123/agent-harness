import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import tools


class NoteToolsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "notes"
        self.root.mkdir()
        self.patch = patch("tools.NOTES_DIR", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        (self.root / "sample.md").write_text("# 笔记\n项目代号：纸飞机-42。\n", encoding="utf-8")

    def test_search_result_can_be_read(self):
        result = tools.search_notes("项目代号")["results"][0]
        note = tools.read_note(result["file"])
        self.assertIn("# 笔记", note["content"])
        self.assertIn(result["text"], note["content"])
        self.assertEqual(note, tools.read_note("sample.md"))
        self.assertFalse(note["truncated"])

    def test_read_is_bounded_and_marks_truncation(self):
        (self.root / "long.txt").write_text("长" * (tools.MAX_NOTE_CHARS + 20), encoding="utf-8")
        note = tools.read_note("long.txt")
        self.assertEqual(len(note["content"]), tools.MAX_NOTE_CHARS)
        self.assertTrue(note["truncated"])

    def test_empty_note_is_a_valid_empty_result(self):
        (self.root / "empty.md").write_text("", encoding="utf-8")
        self.assertEqual(tools.read_note("empty.md")["content"], "")

    def test_cannot_read_outside_notes_or_symlinks(self):
        outside = self.root.parent / "outside.txt"
        outside.write_text("outside fixture", encoding="utf-8")
        (self.root / "link.txt").symlink_to(outside)
        for filename in ["../outside.txt", str(outside), "notes/../outside.txt", "link.txt", ".env", "notes"]:
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                tools.read_note(filename)

    def test_dispatch_reports_bad_parameters_and_missing_file(self):
        for args in ["{", "[]", "{}", '{"filename": 42}', '{"filename": ""}', '{"filename": "missing.md"}', '{"filename": "sample.md", "extra": 1}']:
            with self.subTest(args=args):
                self.assertIn("error", json.loads(tools.execute_tool("read_note", args, registry=tools.NOTE_TOOL_REGISTRY)))


if __name__ == "__main__":
    unittest.main()
