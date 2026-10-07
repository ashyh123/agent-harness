import contextlib
import copy
import io
import os
import unittest
from unittest.mock import Mock, patch

from openai.types.chat import ChatCompletion

import agent
from runtime import BudgetExceeded, RunContext


def response(content=None, calls=None, finish_reason="stop"):
    message = {"role": "assistant", "content": content}
    if calls:
        message["tool_calls"] = calls
    return ChatCompletion.model_validate({
        "id": "mock", "object": "chat.completion", "created": 0, "model": "mock",
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
    })


def tool_call(identifier):
    return {"id": identifier, "type": "function", "function": {"name": "read_note", "arguments": '{"filename":"project.md"}'}}


class AgentLoopTests(unittest.TestCase):
    def test_save_trace_serializes_usage_and_redacts_local_key(self):
        import json
        import tempfile
        from pathlib import Path
        from runtime import RunContext

        context = RunContext(events=[{"type": "model", "usage": {"total_tokens": 10}}])
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"DEEPSEEK_API_KEY": "fixture-secret"}):
            path = Path(directory) / "trace.json"
            agent.save_trace(context, "fixture-secret", None, path=path)
            serialized = path.read_text()
            self.assertNotIn("fixture-secret", serialized)
            self.assertEqual(json.loads(serialized)["answer"], "[REDACTED]")

    def test_truncated_output_is_not_appended_as_a_complete_answer(self):
        client = Mock()
        client.chat.completions.create.return_value = response("未完的回答", finish_reason="length")
        messages = [{"role": "user", "content": "详细解释"}]
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "本轮未完成"):
            agent.run_agent(client, messages)
        self.assertEqual(messages, [{"role": "user", "content": "详细解释"}])
        self.assertEqual(client.chat.completions.create.call_count, 2)

    def test_compact_retry_keeps_question_and_sources_without_partial_answer(self):
        client = Mock()
        client.chat.completions.create.side_effect = [
            response("第一题的半截回答", finish_reason="length"),
            response("第一题：文件持久化。第二题：本节仅引入数据库。"),
        ]
        messages = [
            {"role": "system", "content": agent.SYSTEM_PROMPT},
            {"role": "user", "content": "回答第一题和第二题"},
            response(calls=[tool_call("read-1")], finish_reason="tool_calls").choices[0].message.model_dump(exclude_none=True),
            {"role": "tool", "tool_call_id": "read-1", "content": '{"content":"原文依据"}'},
        ]
        original = copy.deepcopy(messages)
        context = RunContext(client=client)
        with contextlib.redirect_stdout(io.StringIO()):
            answer = agent.run_agent(client, messages, context=context)
        second_request = client.chat.completions.create.call_args_list[1].kwargs
        self.assertEqual(second_request["messages"][:-1], original)
        self.assertEqual(second_request["messages"][-1], {"role": "system", "content": agent.COMPACT_RETRY_PROMPT})
        self.assertEqual(second_request["max_tokens"], agent.MAX_OUTPUT_TOKENS)
        self.assertNotIn("第一题的半截回答", str(second_request["messages"]))
        self.assertEqual(messages[:-1], original)
        self.assertEqual(messages[-1], {"role": "assistant", "content": answer})
        self.assertTrue(answer.startswith(agent.COMPACT_NOTICE))
        self.assertEqual(context.model_requests, 2)
        self.assertEqual([event["kind"] for event in context.events], ["agent", "compact_retry"])

    def test_truncated_tool_arguments_are_not_executed(self):
        client = Mock()
        incomplete_call = tool_call("incomplete")
        incomplete_call["function"]["arguments"] = '{"filename":'
        client.chat.completions.create.side_effect = [
            response(calls=[incomplete_call], finish_reason="length"),
            response("资料不足，无法完成。"),
        ]
        executor = Mock()
        messages = [{"role": "user", "content": "读取笔记"}]
        with contextlib.redirect_stdout(io.StringIO()):
            agent.run_agent(client, messages, executor=executor)
        executor.assert_not_called()
        self.assertNotIn("incomplete", str(messages))

    def test_compact_retry_respects_shared_model_request_budget(self):
        client = Mock()
        client.chat.completions.create.return_value = response("半截回答", finish_reason="length")
        context = RunContext(client=client, max_model_requests=1)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(BudgetExceeded):
            agent.run_agent(client, [{"role": "user", "content": "解释"}], context=context)
        self.assertEqual(context.model_requests, 1)
        self.assertEqual(client.chat.completions.create.call_count, 1)

    def test_compact_retry_respects_outer_loop_request_budget(self):
        client = Mock()
        client.chat.completions.create.return_value = response("半截回答", finish_reason="length")
        with patch("agent.MAX_STEPS", 1), contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "预算已耗尽"):
            agent.run_agent(client, [{"role": "user", "content": "解释"}])
        self.assertEqual(client.chat.completions.create.call_count, 1)

    def test_recovery_instruction_does_not_leak_into_next_turn(self):
        client = Mock()
        client.chat.completions.create.side_effect = [
            response("半截回答", finish_reason="length"),
            response("精简答案"),
            response("下一轮答案"),
        ]
        messages = [{"role": "user", "content": "第一轮"}]
        with contextlib.redirect_stdout(io.StringIO()):
            agent.run_agent(client, messages)
            messages.append({"role": "user", "content": "第二轮"})
            answer = agent.run_agent(client, messages)
        self.assertEqual(answer, "下一轮答案")
        self.assertNotIn(agent.COMPACT_RETRY_PROMPT, str(client.chat.completions.create.call_args.kwargs["messages"]))

    def test_main_rolls_back_truncated_tool_turn_and_preserves_previous_turn(self):
        replies = iter([
            response("你好！"),
            response(calls=[tool_call("read-1")], finish_reason="tool_calls"),
            response("未完的长回答", finish_reason="length"),
            response("精简后仍未完成", finish_reason="length"),
            response("继续对话。"),
        ])
        snapshots = []
        client = Mock()

        def request(**kwargs):
            snapshots.append(copy.deepcopy(kwargs["messages"]))
            return next(replies)

        client.chat.completions.create.side_effect = request
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "offline-test-key"}), patch("agent.OpenAI", return_value=client), patch("agent.execute_tool", return_value='{"content":"fixture"}'), patch("agent.save_trace"), patch("builtins.input", side_effect=["你好", "读取并详细解释", "继续", "/exit"]), contextlib.redirect_stdout(io.StringIO()):
            agent.main()
        self.assertEqual(snapshots[-1][1:], [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "你好！"},
            {"role": "user", "content": "继续"},
        ])
        client.close.assert_called_once()

    def test_repeated_reads_stop_at_request_limit(self):
        client = Mock()
        client.chat.completions.create.side_effect = [
            response(calls=[tool_call(f"read-{number}")], finish_reason="tool_calls")
            for number in range(agent.MAX_STEPS)
        ]
        with patch("agent.execute_tool", return_value='{"content":"fixture"}'), contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, "上限"):
            agent.run_agent(client, [{"role": "user", "content": "一直读取"}])
        self.assertEqual(client.chat.completions.create.call_count, agent.MAX_STEPS)


if __name__ == "__main__":
    unittest.main()
