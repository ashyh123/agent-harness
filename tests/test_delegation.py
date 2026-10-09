import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from runtime import BudgetExceeded, RunContext
from tools import execute_tool, DELEGATION_TOOL_REGISTRY
from tool_library import delegation


class DelegationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.workspace = self.directory / 'workspace'
        self.workspace.mkdir()
        content = '结果：中文和😀\n第二行'
        (self.workspace / 'report.md').write_text(content)
        data = content.encode()
        self.task_id = '11111111-1111-4111-8111-111111111111'
        self.record = {'id': self.task_id, 'workspace': str(self.workspace), 'status': 'completed',
                       'task_verdict': 'needs_review', 'answer': '已保存report.md', 'error': None,
                       'artifacts': [{'path': 'report.md', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}],
                       'missing_files': [], 'usage': {'input_tokens': 100, 'output_tokens': 20}}
        self.process = Mock(returncode=0)
        self.process.communicate.return_value = (json.dumps({'record': self.record, 'directory': str(self.directory)}), '')
        replacement = patch.object(delegation.subprocess, 'Popen', return_value=self.process)
        self.popen = replacement.start()
        self.addCleanup(replacement.stop)
        environment = patch.dict('os.environ', {'MINIMAL_AGENT_NODE_BIN': '/offline/node'})
        environment.start()
        self.addCleanup(environment.stop)
        self.context = RunContext(max_seconds=360)

    def call(self, name, arguments, context=None):
        return json.loads(execute_tool(name, json.dumps(arguments), context=context or self.context, registry=DELEGATION_TOOL_REGISTRY))

    def launch(self):
        return self.call('delegate_to_codex', {'task': '任务含$(touch fake)和`命令`', 'expected_files': ['report.md']})

    def test_launch_uses_stdin_and_structured_receipt_and_separate_usage(self):
        result = self.launch()
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['usage']['input_tokens'], 100)
        self.assertEqual(self.context.model_requests, 0)
        self.assertEqual(self.context.tool_calls, 1)
        args = self.popen.call_args.args[0]
        self.assertNotIn('任务含$(touch fake)和`命令`', args)
        self.assertIn('--json', args)
        self.assertEqual(self.process.communicate.call_args.kwargs['input'], '任务含$(touch fake)和`命令`')
        self.assertEqual(self.context.events[0]['result']['task_id'], self.task_id)
        self.assertEqual(self.popen.call_args.kwargs['env']['MINIMAL_AGENT_CODEX_SUBTASK'], '1')

    def test_identical_request_is_reused_but_different_request_is_not_restarted(self):
        first = self.launch()
        second = self.launch()
        self.assertEqual(first['task_id'], second['task_id'])
        self.assertTrue(second['reused'])
        self.popen.assert_called_once()
        failed = self.call('delegate_to_codex', {'task': '不同的任务'})
        self.assertEqual(failed['error']['code'], 'delegation_limit')
        self.assertEqual(self.context.tool_calls, 3)

    def test_native_failure_is_returned_and_cannot_restart_the_cli(self):
        self.record['status'] = 'timed_out'
        self.record['task_verdict'] = 'not_completed'
        self.record['error'] = '超时'
        self.process.communicate.return_value = (json.dumps({'record': self.record, 'directory': str(self.directory)}), '')
        first = self.launch()
        second = self.launch()
        self.assertEqual(first['status'], 'timed_out')
        self.assertEqual(first['task_verdict'], 'not_completed')
        self.assertTrue(second['reused'])
        self.popen.assert_called_once()

    def test_read_verified_artifact_and_unicode_pagination(self):
        self.launch()
        arguments = {'task_id': self.task_id, 'path': 'report.md', 'limit': 7}
        first = self.call('read_delegated_file', arguments)
        second = self.call('read_delegated_file', {**arguments, 'offset': first['next_offset'], 'limit': 6000})
        self.assertTrue(first['hash_verified'])
        self.assertEqual(first['content'] + second['content'], (self.workspace / 'report.md').read_text())
        self.assertFalse(second['has_more'])
        fresh = self.call('read_delegated_file', arguments, RunContext())
        self.assertEqual(fresh['error']['code'], 'delegated_task_not_found')

    def test_changed_file_unknown_path_and_symlink_are_rejected(self):
        self.launch()
        arguments = {'task_id': self.task_id, 'path': 'report.md'}
        (self.workspace / 'report.md').write_text('被改动')
        self.assertEqual(self.call('read_delegated_file', arguments)['error']['code'], 'artifact_changed')
        (self.workspace / 'report.md').unlink()
        external = self.directory / 'secret.txt'
        external.write_text('不允许读取的外部内容')
        (self.workspace / 'report.md').symlink_to(external)
        self.assertEqual(self.call('read_delegated_file', arguments)['error']['code'], 'artifact_unavailable')
        for name in ('../secret.txt', '/tmp/secret', 'unknown.md'):
            result = self.call('read_delegated_file', {**arguments, 'path': name})
            self.assertIn(result['error']['code'], ('invalid_artifact_path', 'artifact_not_found'))

    def test_invalid_parameter_or_insufficient_time_does_not_start_codex(self):
        for arguments in ({'task': ' '}, {'task': '任务', 'timeout_seconds': '180'},
                          {'task': '任务', 'expected_files': ['../outside.md']}):
            self.assertIn('error', self.call('delegate_to_codex', arguments))
        with self.assertRaises(BudgetExceeded):
            self.call('delegate_to_codex', {'task': '任务'}, RunContext(max_seconds=20))
        self.popen.assert_not_called()

    def test_non_json_or_start_failure_consumes_attempt_without_leaking_raw_error(self):
        self.process.communicate.return_value = ('private raw error', '')
        first = self.launch()
        self.assertEqual(first['error']['code'], 'dispatch_failed')
        self.assertNotIn('private raw error', json.dumps(first))
        self.assertEqual(self.launch()['error']['code'], 'delegation_limit')
        self.popen.assert_called_once()


if __name__ == '__main__':
    unittest.main()
