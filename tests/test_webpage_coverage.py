import unittest
from unittest.mock import patch

from tool_library import network
from tool_library.errors import ToolError


class WebpageCoverageTests(unittest.TestCase):
    def read(self, markup, body='Research body with no footnotes.'):
        with patch.object(network, 'fetch_bytes', return_value=(markup.encode(), 'https://example.com/', 'text/html')), \
             patch.object(network.trafilatura, 'extract', return_value=body):
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


if __name__ == '__main__':
    unittest.main()
