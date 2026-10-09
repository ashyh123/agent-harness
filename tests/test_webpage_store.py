import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime import BudgetExceeded, RunContext
from tool_library import network, webpage_store as store
from tool_library.errors import ToolError
from tools import execute_tool


class WebpageStoreTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        replacement = patch.object(store, 'SNAPSHOT_DIR', self.root)
        replacement.start()
        self.addCleanup(replacement.stop)

    def save(self, content):
        return store.save_webpage(url='https://example.com/post', title='Post', content=content,
                                  footnotes_found=0, coverage_note=network.COVERAGE_NOTE)

    def call(self, arguments, **kwargs):
        return json.loads(execute_tool('read_saved_webpage', json.dumps(arguments), **kwargs))

    def test_truncated_webpage_keeps_original_tail_and_can_be_read_without_network(self):
        body = 'A' * 11000 + '\nThe estimated duration is simulated, not measured.'
        with patch.object(network, 'fetch_bytes', return_value=(body.encode(), 'https://example.com/post', 'text/plain')):
            result = network.read_webpage('https://example.com/post')
        self.assertTrue(result['truncated'])
        self.assertNotIn('simulated', result['content'])
        with patch.object(network, 'fetch_bytes', side_effect=AssertionError('must not download again')):
            restored = self.call({'document_id': result['document_id'], 'offset': 11000})
        self.assertEqual(restored['content'], body[11000:])
        self.assertEqual(restored['url'], result['url'])
        self.assertEqual(restored['total_chars'], len(body))
        self.assertFalse(restored['has_more'])
        self.assertIsNone(restored['next_offset'])
        self.assertFalse(restored['range_complete'])
        self.assertEqual(restored['completeness'], 'not_verified')

    def test_paged_unicode_text_reassembles_exactly_and_id_is_stable(self):
        content = '第一段🙂\n第二段：保留条件。'
        identifier = self.save(content)
        self.assertEqual(identifier, self.save(content))
        offset, segments = 0, []
        while True:
            part = self.call({'document_id': identifier, 'offset': offset, 'limit': 3})
            segments.append(part['content'])
            self.assertEqual(part['offset'], offset)
            if not part['has_more']:
                break
            self.assertGreater(part['next_offset'], offset)
            offset = part['next_offset']
        self.assertEqual(''.join(segments), content)

    def test_short_snapshot_complete_range_does_not_claim_complete_webpage(self):
        result = self.call({'document_id': self.save('A short source.')})
        self.assertTrue(result['range_complete'])
        self.assertEqual(result['completeness'], 'not_verified')

    def test_footnote_larger_than_preview_budget_is_saved_in_full(self):
        note = 'N' * 4000 + ' Required limitation.'
        page = '<li id="fn1">' + note + '</li>'
        with patch.object(network, 'fetch_bytes', return_value=(page.encode(), 'https://example.com/post', 'text/html')), \
             patch.object(network, 'extract_article', return_value=('Body.', 'Body.')):
            result = network.read_webpage('https://example.com/post')
        self.assertNotIn('Required limitation.', result['content'])
        restored = self.call({'document_id': result['document_id'], 'limit': 10000})
        self.assertIn(note, restored['content'])
        self.assertEqual(restored['footnotes_found'], 1)

    def test_invalid_id_ranges_and_missing_snapshot_are_structured_errors(self):
        identifier = self.save('Source.')
        for parameters in [{'document_id': '../.env'}, {'document_id': identifier, 'offset': -1},
                           {'document_id': identifier, 'offset': True}, {'document_id': identifier, 'limit': 10001}]:
            with self.subTest(parameters=parameters):
                self.assertEqual(self.call(parameters)['error']['code'], 'invalid_arguments')
        self.assertEqual(self.call({'document_id': '0' * 64})['error']['code'], 'snapshot_not_found')
        self.assertEqual(self.call({'document_id': identifier, 'offset': 100})['error']['code'], 'invalid_range')

    def test_corrupted_snapshot_and_symlink_are_rejected(self):
        identifier = self.save('Original text.')
        path = self.root / f'{identifier}.json'
        document = json.loads(path.read_text())
        document['content'] = 'Changed text.'
        path.write_text(json.dumps(document))
        self.assertEqual(self.call({'document_id': identifier})['error']['code'], 'invalid_snapshot')
        path.unlink()
        outside = self.root / 'outside.json'
        outside.write_text('sensitive test data')
        path.symlink_to(outside)
        result = self.call({'document_id': identifier})
        self.assertEqual(result['error']['code'], 'invalid_snapshot')
        self.assertNotIn('sensitive test data', json.dumps(result))

    def test_cache_read_counts_against_tool_budget_and_not_model_budget(self):
        identifier = self.save('Evidence.')
        context = RunContext(max_tool_calls=1, max_model_requests=0)
        self.assertEqual(self.call({'document_id': identifier}, context=context)['content'], 'Evidence.')
        self.assertEqual(context.model_requests, 0)
        self.assertEqual(context.tool_calls, 1)
        self.assertEqual(context.events[0]['result']['document_id'], identifier)
        with self.assertRaises(BudgetExceeded):
            self.call({'document_id': identifier}, context=context)

    def test_dual_format_ranges_are_independent_and_old_snapshots_still_work(self):
        identifier = store.save_webpage(url='https://example.com/post', title='Post',
            content='The **outcome** is final.', text_content='The outcome is final.',
            footnotes_found=0, coverage_note=network.COVERAGE_NOTE)
        default = self.call({'document_id': identifier, 'limit': 5})
        self.assertEqual(default['content_format'], 'markdown')
        self.assertEqual(default['available_formats'], {'markdown': 25, 'text': 21})
        self.assertEqual(default['next_offset'], 5)
        plain = self.call({'document_id': identifier, 'content_format': 'text', 'offset': 4, 'limit': 7})
        self.assertEqual(plain['content'], 'outcome')
        self.assertEqual(plain['total_chars'], 21)
        self.assertNotIn('text_content', default)
        legacy_id = self.save('Legacy source.')
        self.assertEqual(self.call({'document_id': legacy_id})['content_format'], 'text')
        self.assertEqual(self.call({'document_id': legacy_id, 'content_format': 'markdown'})['error']['code'], 'unsupported_format')
        self.assertEqual(self.call({'document_id': identifier, 'content_format': 'html'})['error']['code'], 'invalid_arguments')


if __name__ == '__main__':
    unittest.main()
