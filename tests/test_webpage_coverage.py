import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from tool_library import network
from tool_library.errors import ToolError
from tool_library import webpage_store


class WebpageCoverageTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        replacement = patch.object(webpage_store, 'SNAPSHOT_DIR', Path(directory.name))
        replacement.start()
        self.addCleanup(replacement.stop)

    def read(self, markup, body='Research body with no footnotes.'):
        with patch.object(network, 'fetch_bytes', return_value=(markup.encode(), 'https://example.com/', 'text/html')), \
             patch.object(network, 'extract_article', return_value=(body, body)):
            return network.read_webpage('https://example.com/')

    def test_recovers_footnote_outside_extracted_article(self):
        # 与真实失败相同：正文算法只返回 article，脚注位于旁边的列表。
        page = '<article>Research body</article><section><h2>Footnotes</h2><ol><li id="citation-bottom-1">Times are simulated estimates, not measured savings.</li></ol></section>'
        result = self.read(page)
        self.assertIn('Times are simulated estimates, not measured savings.', result['content'])
        self.assertEqual(result['footnotes_found'], 1)
        self.assertFalse(result['truncated'])
        self.assertEqual(result['completeness'], 'not_verified')

    def test_semantic_footnotes_and_common_anchors_exclude_scripts(self):
        result = self.read('<div role="doc-endnotes"><ol><li>First limitation.</li></ol></div>'
                           '<div role="doc-footnote">Second limitation.<script>BAD_DATA</script></div>'
                           '<li id="fn1">Third limitation.</li><div id="navigation">NOT_A_NOTE</div>')
        self.assertEqual(result['footnotes_found'], 3)
        for text in ['First limitation.', 'Second limitation.', 'Third limitation.']:
            self.assertIn(text, result['content'])
        self.assertNotIn('BAD_DATA', result['content'])
        self.assertNotIn('NOT_A_NOTE', result['content'])

    def test_long_body_reserves_space_for_notes_and_stays_bounded(self):
        result = self.read('<li id="footnote-1">Important limitation.</li>', 'A' * (network.MAX_WEB_CHARS + 10))
        self.assertEqual(len(result['content']), network.MAX_WEB_CHARS)
        self.assertIn('Important limitation.', result['content'])
        self.assertTrue(result['truncated'])

    def test_large_notes_are_bounded_and_marked_truncated(self):
        result = self.read('<li id="fn1">' + 'N' * (network.MAX_FOOTNOTE_CHARS + 1) + '</li>')
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['content']), network.MAX_WEB_CHARS)

    def test_notes_already_in_body_are_not_duplicated(self):
        result = self.read('<li id="fn1">Exact limitation.</li>', 'Body. Exact limitation.')
        self.assertEqual(result['content'].count('Exact limitation.'), 1)

    def test_note_in_body_beyond_cutoff_is_still_returned(self):
        result = self.read('<li id="fn1">Tail limitation.</li>',
                           'A' * network.MAX_WEB_CHARS + ' Tail limitation.')
        self.assertIn('Tail limitation.', result['content'])
        self.assertEqual(len(result['content']), network.MAX_WEB_CHARS)
        self.assertTrue(result['truncated'])

    def test_no_notes_does_not_prove_complete_page(self):
        result = self.read('<article>No notes discovered.</article>')
        self.assertEqual(result['footnotes_found'], 0)
        self.assertFalse(result['truncated'])
        self.assertEqual(result['completeness'], 'not_verified')

    def test_empty_page_still_returns_extraction_error(self):
        with self.assertRaises(ToolError) as error:
            self.read('', body=None)
        self.assertEqual(error.exception.code, 'extraction_failed')

    def test_real_extractor_keeps_article_and_external_footnote(self):
        body = ('The example team evaluated an assistant in a hosted testing environment. '
                'The report compares task scores and estimated processing times. ' * 12)
        page = ('<html><head><title>Example research report</title></head><body>'
                '<article><h1>Research report</h1><p>' + body + '</p></article>'
                '<footer><ol><li id="citation-bottom-1">'
                'Times are simulated, not observed customer savings.'
                '</li></ol></footer></body></html>')
        with patch.object(network, 'fetch_bytes', return_value=(page.encode(), 'https://example.com/', 'text/html')):
            result = network.read_webpage('https://example.com/')
        self.assertIn('hosted testing environment', result['content'])
        self.assertIn('Times are simulated, not observed customer savings.', result['content'])
        self.assertEqual(result['footnotes_found'], 1)
        self.assertEqual(result['completeness'], 'not_verified')

    def test_same_extraction_preserves_headings_nested_lists_table_and_plain_wording(self):
        page = ('<html><head><title>结构样本</title></head><body><nav>导航噪声</nav><article>'
                '<h1>本地评估样本</h1><h2>定义</h2>'
                '<ul><li>任务是具有验收条件的输入。</li><li>结果是环境中的最终状态。</li></ul>'
                '<p>The <strong>outcome</strong> is the final state.</p>'
                '<p>阅读<a href="https://example.com/reference">参考资料</a>再核对。</p>'
                '<table><tr><th>方式</th><th>局限</th></tr><tr><td>模型评审</td>'
                '<td><ul><li>需要人工校准。</li><li>可能出现不一致。</li></ul></td></tr></table>'
                '<p>' + '这个本地样本用于验证提取后的关键结构和条件是否保留。' * 20 + '</p>'
                '</article></body></html>')
        with patch.object(network, 'fetch_bytes', return_value=(page.encode(), 'https://example.com/', 'text/html')):
            result = network.read_webpage('https://example.com/')
        self.assertEqual(result['content_format'], 'markdown')
        self.assertIn('# 本地评估样本', result['content'])
        self.assertIn('- 任务是具有验收条件的输入。', result['content'])
        self.assertIn('**outcome**', result['content'])
        self.assertIn('[参考资料](https://example.com/reference)', result['content'])
        for term in ['方式', '局限', '模型评审', '需要人工校准。', '可能出现不一致。']:
            self.assertIn(term, result['content'])
        text = webpage_store.read_saved_webpage(result['document_id'], content_format='text', limit=10000)
        self.assertIn('The outcome is the final state.', text['content'])
        self.assertNotIn('**outcome**', text['content'])
        self.assertIn('阅读参考资料再核对。', text['content'])
        self.assertEqual(text['document_id'], result['document_id'])
        self.assertNotIn('text_content', text)  # 不把另一份全文泄漏到有界回读结果中。


if __name__ == '__main__':
    unittest.main()
