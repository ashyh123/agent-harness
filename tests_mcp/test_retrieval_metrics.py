import unittest
from scripts.evaluate_obsidian_retrieval import score
class MetricsTests(unittest.TestCase):
    def test_note_level_recall_reciprocal_rank_and_graded_dcg(self):
        result=score(['irrelevant.md','support.md','primary.md'],{'primary.md':2,'support.md':1,'other.md':1})
        self.assertAlmostEqual(result['recall_at_3'],2/3)
        self.assertEqual(result['mrr_at_3'],.5)
        self.assertEqual(result['primary_hit_at_3'],1)
        self.assertGreater(result['ndcg_at_3'],0);self.assertLess(result['ndcg_at_3'],1)
        result=score(['other.md','primary.md','support.md'],{'other.md':2,'primary.md':2,'support.md':1})
        self.assertEqual(result['ndcg_at_3'],1)
    def test_no_hit_and_later_hit_do_not_count_in_top3(self):
        result=score(['a','b','c','correct'],{'correct':2})
        self.assertTrue(all(v==0 for v in result.values()))
