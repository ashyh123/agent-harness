import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime import RunContext
from tool_library import obsidian, webpage_store
from tools import execute_tool


class ObsidianTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name).resolve()
        for target, field, value in [(webpage_store, 'SNAPSHOT_DIR', root / 'snapshots'),
                                      (obsidian, 'VAULT_DIR', root / 'vault')]:
            replacement = patch.object(target, field, value)
            replacement.start()
            self.addCleanup(replacement.stop)
        self.content = 'An agent uses tools in a loop. ' * 120
        self.document_id = webpage_store.save_webpage(url='https://example.com/blog', title='../Title: A/B',
            content=self.content, footnotes_found=0, coverage_note='Not verified.')
        self.context = RunContext()
        execute_tool('read_saved_webpage', json.dumps({'document_id': self.document_id}), context=self.context)
        self.args = {'document_id': self.document_id, 'summary': '这篇文章介绍模型如何在循环中选择工具、观察结果并继续处理问题，重点是调用和反馈。',
                     'takeaway': '我的推论：最小 Agent 应保留每次工具调用结果，便于回查。',
                     'evidence_quote': 'An agent uses tools in a loop.'}

    def call(self, args=None, context=None):
        return json.loads(execute_tool('save_obsidian_blog', json.dumps(args or self.args),
                                       context=context or self.context))

    def test_real_files_readback_hash_source_and_duplicate_without_overwrite(self):
        result = self.call()
        self.assertTrue(result['verified'])
        note = Path(result['note_path'])
        self.assertEqual(note.parent, obsidian.VAULT_DIR / '阅读笔记')
        self.assertEqual(hashlib.sha256(note.read_bytes()).hexdigest(), result['sha256'])
        self.assertIn(self.args['summary'], note.read_text())
        self.assertIn(f'[0, {len(self.content)})', note.read_text())
        self.assertIn(self.content, Path(result['original_path']).read_text())
        self.assertTrue((obsidian.VAULT_DIR / '.obsidian/app.json').is_file())
        before = note.read_bytes()
        self.assertEqual(self.call()['status'], 'already_saved')
        self.assertEqual(note.read_bytes(), before)

    def test_must_actually_read_before_saving_and_quote_must_be_in_read_range(self):
        result = self.call(context=RunContext())
        self.assertEqual(result['error']['code'], 'read_required')
        result = self.call({**self.args, 'evidence_quote': 'This sentence was not read in the article.'})
        self.assertEqual(result['error']['code'], 'quote_not_in_read_content')
        self.assertFalse(obsidian.VAULT_DIR.exists())

    def test_forged_id_and_arbitrary_extra_path_are_rejected(self):
        self.assertEqual(self.call({**self.args, 'document_id': '../outside'})['error']['code'], 'invalid_arguments')
        self.assertEqual(self.call({**self.args, 'filename': '/tmp/other.md'})['error']['code'], 'invalid_arguments')
        self.assertFalse(obsidian.VAULT_DIR.exists())

    def test_user_edited_note_not_overwritten(self):
        result = self.call()
        note = Path(result['note_path'])
        note.write_text('我的手工修改')
        self.assertEqual(self.call()['error']['code'], 'note_conflict')
        self.assertEqual(note.read_text(), '我的手工修改')

    def test_symlink_directory_cannot_escape_vault(self):
        obsidian.VAULT_DIR.mkdir()
        outside = obsidian.VAULT_DIR.parent / 'outside'
        outside.mkdir()
        (obsidian.VAULT_DIR / '阅读笔记').symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.call()['error']['code'], 'invalid_vault')
        self.assertEqual(list(outside.iterdir()), [])
