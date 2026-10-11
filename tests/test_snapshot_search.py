import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tool_library import webpage_store as store
from tools import execute_tool
from runtime import RunContext, BudgetExceeded

class SnapshotSearchTests(unittest.TestCase):
    def setUp(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        p = patch.object(store, 'SNAPSHOT_DIR', Path(d.name))
        p.start()
        self.addCleanup(p.stop)

    def test_full_text_search_finds_tail_then_actual_read_preserves_unicode_offsets(self):
        text = '🙂 padding\n' * 2400 + 'Start with 20-50 tasks drawn from real failures.'
        doc = store.save_webpage(url='https://example.com', title='post', content=text,
                                 footnotes_found=0, coverage_note='not verified')
        context = RunContext()
        result = json.loads(execute_tool('search_saved_webpage', json.dumps({'document_id': doc, 'query': 'tasks failures'}), context=context))
        self.assertGreater(result['matches'][0]['offset'], 20000)
        hit = result['matches'][0]
        actual = store.read_saved_webpage(doc, offset=hit['offset'], limit=hit['end_offset']-hit['offset'], content_format='text')
        self.assertIn('20-50 tasks', actual['content'])
        self.assertEqual(context.tool_calls, 1)
        with self.assertRaises(BudgetExceeded):
            execute_tool('search_saved_webpage', json.dumps({'document_id': doc, 'query': 'tasks'}), context=RunContext(max_tool_calls=0))

    def test_fts_input_is_escaped_and_no_hits_does_not_claim_no_answer(self):
        doc = store.save_webpage(url='https://example.com', title='post', content='one word', footnotes_found=0, coverage_note='unknown')
        result = store.search_saved_webpage(doc, '" OR * nonexistent')
        self.assertEqual(result['matches'], [])
        self.assertIn('不证明', result['note'])
