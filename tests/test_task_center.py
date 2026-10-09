import json
import os
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from runtime import BudgetExceeded, RunContext
from tools import CENTER_TOOL_REGISTRY, execute_tool


class TaskCenterToolTests(unittest.TestCase):
    def serve(self, response):
        temporary = tempfile.TemporaryDirectory(prefix='center-ipc-', dir='/tmp')
        self.addCleanup(temporary.cleanup)
        endpoint = str(Path(temporary.name) / 'ipc.sock')
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(endpoint)
        server.listen(1)
        self.addCleanup(server.close)
        captured = []

        def worker():
            client, _ = server.accept()
            with client:
                data = bytearray()
                while b'\n' not in data:
                    data.extend(client.recv(8192))
                captured.append(json.loads(data.split(b'\n')[0]))
                client.sendall(response)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        self.addCleanup(lambda: thread.join(timeout=1))
        return endpoint, captured

    def execute(self, name, arguments, context=None):
        return json.loads(execute_tool(name, json.dumps(arguments), context=context or RunContext(), registry=CENTER_TOOL_REGISTRY))

    def test_submit_passes_through_schema_and_ipc_without_launching_a_process(self):
        endpoint, captured = self.serve(b'{"data":{"tasks":[{"task_id":"fixture","status":"queued"}]}}\n')
        context = RunContext()
        with patch.dict(os.environ, {'MINIMAL_AGENT_TASK_CENTER_SOCKET': endpoint, 'MINIMAL_AGENT_TASK_CENTER_TOKEN': 'test-token'}):
            result = self.execute('submit_tasks', {'tasks': [{'key': 'one', 'task': '返回42', 'capability': 'math', 'complexity': 'simple'}]}, context)
        self.assertEqual(result['tasks'][0]['status'], 'queued')
        self.assertEqual(captured[0]['op'], 'submit_tasks')
        self.assertEqual(captured[0]['arguments']['tasks'][0]['acceptance']['expected_files'], ['result.md'])
        self.assertEqual(context.tool_calls, 1)
        self.assertNotIn('test-token', json.dumps(context.events))

    def test_backend_rejection_is_explicit_tool_error(self):
        endpoint, _ = self.serve('{"error":"先回读产物"}\n'.encode())
        with patch.dict(os.environ, {'MINIMAL_AGENT_TASK_CENTER_SOCKET': endpoint, 'MINIMAL_AGENT_TASK_CENTER_TOKEN': 'test-token'}):
            result = self.execute('review_task', {'task_id': 'a' * 36, 'attempt_id': 'b' * 36, 'passed': True, 'reason': '没有实际读取'})
        self.assertEqual(result['error']['code'], 'center_rejected')
        self.assertIn('回读', result['error']['message'])

    def test_invalid_parameters_and_business_tool_cannot_bypass_master_registry(self):
        cases = [('submit_tasks', {'tasks': []}),
                 ('submit_tasks', {'tasks': [{'key': 'x', 'task': 'x', 'capability': 'shell', 'complexity': 'simple'}]}),
                 ('read_task_artifact', {'task_id': 'not-id', 'attempt_id': 'b' * 36, 'path': 'result.md'}),
                 ('get_task_updates', {'cursor': -1}),
                 ('review_task', {'task_id': 'a' * 36, 'attempt_id': 'b' * 36, 'passed': 'yes', 'reason': 'wrong type'})]
        for name, arguments in cases:
            with self.subTest(name=name, arguments=arguments):
                self.assertEqual(self.execute(name, arguments)['error']['code'], 'invalid_arguments')
        self.assertEqual(self.execute('calculate', {'operation': 'add', 'a': 1, 'b': 2})['error']['code'], 'unknown_tool')

    def test_unavailable_or_malformed_ipc_cannot_be_treated_as_success(self):
        with patch.dict(os.environ, {'MINIMAL_AGENT_TASK_CENTER_SOCKET': '/tmp/nonexistent-center-socket', 'MINIMAL_AGENT_TASK_CENTER_TOKEN': 'token'}):
            self.assertEqual(self.execute('get_task_updates', {})['error']['code'], 'center_unavailable')
        endpoint, _ = self.serve(b'not-json\n')
        with patch.dict(os.environ, {'MINIMAL_AGENT_TASK_CENTER_SOCKET': endpoint, 'MINIMAL_AGENT_TASK_CENTER_TOKEN': 'token'}):
            self.assertEqual(self.execute('get_task_updates', {})['error']['code'], 'center_unavailable')

    def test_parent_budget_fatal_is_not_converted_to_tool_error(self):
        context = RunContext(max_tool_calls=1)
        context.tool_calls = 1
        with self.assertRaises(BudgetExceeded):
            self.execute('get_task_updates', {}, context)


if __name__ == '__main__':
    unittest.main()
