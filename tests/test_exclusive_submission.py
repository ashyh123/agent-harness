import unittest
from pydantic import ValidationError
from tools import CenterSubmissionDraft, CenterSubmission

class ExclusiveSubmissionTests(unittest.TestCase):
    def test_draft_rejects_model_classifications_but_retains_acceptance(self):
        task = {'key': 'task', 'task': 'Calculate and report', 'acceptance': {'expected_files': ['result.md']}}
        draft = CenterSubmissionDraft.model_validate(task)
        self.assertNotIn('capability', draft.model_dump())
        self.assertNotIn('complexity', draft.model_dump())
        with self.assertRaises(ValidationError):
            CenterSubmissionDraft.model_validate({**task, 'capability': 'math', 'complexity': 'simple'})
        original = CenterSubmission.model_validate({**task, 'capability': 'math', 'complexity': 'simple'})
        self.assertEqual(original.capability, 'math')
