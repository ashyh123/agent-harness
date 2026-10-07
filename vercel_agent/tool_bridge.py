"""本地 JSON Lines 桥接；复用原工具、参数校验和共享预算，不启动 HTTP 服务。"""
import json
import os
import sys
import time
from dataclasses import replace
from functools import partial
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openai import OpenAI, OpenAIError
from pydantic import ValidationError

from agent import SYSTEM_PROMPT, COMPACT_RETRY_PROMPT, COMPACT_NOTICE, MAX_STEPS, MAX_MODEL_REQUESTS, MAX_OUTPUT_TOKENS
from evaluate_agent import evaluate_case
from runtime import BudgetExceeded, RunContext
from tools import TOOL_REGISTRY, execute_tool


def fixture_registry(fixtures):
    registry = dict(TOOL_REGISTRY)
    for name, result in fixtures.items():
        def replay(*, _result=result, **kwargs):
            return _result
        registry[name] = replace(registry[name], function=replay)
    return registry


class Worker:
    def __init__(self):
        self._client = None
        self.context = None
        self.registry = TOOL_REGISTRY
        self.outer_requests = 0
        self.pending = {}

    @property
    def client(self):
        if self._client is None and os.getenv("DEEPSEEK_API_KEY"):
            self._client = OpenAI(api_key=os.environ["DEEPSEEK_API_KEY"], base_url="https://api.deepseek.com", timeout=30, max_retries=0)
        return self._client

    def dispatch(self, request):
        operation = request["op"]
        if operation == "describe":
            return {"tools": [tool.definition()["function"] for tool in TOOL_REGISTRY.values()],
                    "system_prompt": SYSTEM_PROMPT, "compact_retry_prompt": COMPACT_RETRY_PROMPT,
                    "compact_notice": COMPACT_NOTICE, "model": os.getenv("DEEPSEEK_MODEL", "deepseek-flash"),
                    "max_steps": MAX_STEPS, "max_model_requests": MAX_MODEL_REQUESTS,
                    "max_tool_calls": 8, "max_seconds": 90, "max_output_tokens": MAX_OUTPUT_TOKENS}
        if operation == "start":
            limits = request.get("limits", {})
            self.context = RunContext(client=self.client, max_model_requests=limits.get("max_model_requests", MAX_MODEL_REQUESTS),
                                      max_tool_calls=limits.get("max_tool_calls", 8), max_seconds=limits.get("max_seconds", 90))
            self.registry = fixture_registry(request.get("fixtures", {}))
            self.outer_requests = 0
            self.pending = {}
            return {"started": True}
        if operation == "capture_tool":
            return json.loads(execute_tool(request["name"], json.dumps(request["arguments"], ensure_ascii=False),
                                           context=RunContext(client=self.client)))
        if operation == "run_python":
            if self.client is None:
                raise RuntimeError("需要加载 DEEPSEEK_API_KEY")
            return evaluate_case(self.client, request["name"], request["prompt"],
                                 executor=partial(execute_tool, registry=fixture_registry(request.get("fixtures", {}))))
        if self.context is None:
            raise RuntimeError("请先开始一轮运行")
        context = self.context
        if operation == "validate_tool":
            try:
                value = self.registry[request["name"]].parameters.model_validate(request["arguments"])
                return {"valid": True, "value": value.model_dump()}
            except ValidationError:
                return {"valid": False}
        if operation == "call_tool":
            first_event = len(context.events)
            result = execute_tool(request["name"], json.dumps(request["arguments"], ensure_ascii=False),
                                  context=context, registry=self.registry)
            for event in context.events[first_event:]:
                if event["type"] == "tool":
                    event["tool_call_id"] = request.get("tool_call_id")
                    break
            return json.loads(result)
        if operation == "invalid_tool":
            context.remaining_seconds()
            if context.tool_calls >= context.max_tool_calls:
                raise BudgetExceeded("已达到本轮工具调用上限")
            context.tool_calls += 1
            result = {"error": {"code": "sdk_validation_error", "message": "SDK 拒绝未知工具或无效参数，未执行工具"}}
            context.events.append({"type": "tool", "name": request["name"], "tool_call_id": request["tool_call_id"],
                                   "result": result, "elapsed_seconds": 0})
            return result
        if operation == "begin_model":
            remaining = context.remaining_seconds()
            if self.outer_requests >= MAX_STEPS:
                raise BudgetExceeded("已达到每轮外层模型请求上限")
            if context.model_requests >= context.max_model_requests:
                raise BudgetExceeded("已达到每轮模型请求总数上限（含视觉工具）")
            self.outer_requests += 1
            context.model_requests += 1
            index = len(context.events)
            context.events.append({"type": "model", "kind": request.get("kind", "vercel"), "request": context.model_requests})
            self.pending[index] = time.monotonic()
            return {"event_id": index, "remaining_seconds": remaining}
        if operation == "end_model":
            index = request["event_id"]
            event = context.events[index]
            event["elapsed_seconds"] = round(time.monotonic() - self.pending.pop(index), 3)
            for field in ("usage", "finish_reason", "error_type", "status_code", "discarded_tool_calls"):
                if field in request:
                    event[field] = request[field]
            return {"recorded": True}
        if operation == "trace":
            return {"model_requests": context.model_requests, "tool_calls": context.tool_calls,
                    "outer_requests": self.outer_requests, "events": context.events}
        raise RuntimeError("未知桥接操作")

    def close(self):
        if self._client is not None:
            self._client.close()


def main():
    worker = Worker()
    try:
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                reply = {"id": request["id"], "ok": True, "data": worker.dispatch(request)}
            except BudgetExceeded as error:
                reply = {"id": request.get("id"), "ok": False, "error": {"code": "budget_exceeded", "message": str(error)}}
            except OpenAIError as error:
                reply = {"id": request.get("id"), "ok": False, "error": {"code": "model_error", "message": type(error).__name__}}
            except Exception as error:
                reply = {"id": request.get("id"), "ok": False, "error": {"code": "bridge_error", "message": type(error).__name__}}
            serialized = json.dumps(reply, ensure_ascii=False, allow_nan=False)
            key = os.getenv("DEEPSEEK_API_KEY")
            print(serialized.replace(key, "[REDACTED]") if key else serialized, flush=True)
    finally:
        worker.close()


if __name__ == "__main__":
    main()
