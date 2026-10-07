"""一次 Agent 运行共享的预算和执行记录，包括工具内部的模型请求。"""
import time
from dataclasses import dataclass, field


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class RunContext:
    client: object = None
    max_model_requests: int = 8
    max_tool_calls: int = 8
    max_seconds: float = 90
    model_requests: int = 0
    tool_calls: int = 0
    events: list = field(default_factory=list)
    started_at: float = field(default_factory=time.monotonic)

    def remaining_seconds(self):
        remaining = self.max_seconds - (time.monotonic() - self.started_at)
        if remaining <= 0:
            raise BudgetExceeded("已达到本轮总耗时预算，停止本轮")
        return remaining

    def call_model(self, kind, request):
        self.remaining_seconds()
        if self.model_requests >= self.max_model_requests:
            raise BudgetExceeded(f"已达到每轮 {self.max_model_requests} 次模型请求上限（含视觉工具）")
        self.model_requests += 1
        event = {"type": "model", "kind": kind, "request": self.model_requests}
        self.events.append(event)
        started = time.monotonic()
        try:
            response = request()
            usage = getattr(response, "usage", None)
            event["usage"] = usage.model_dump() if usage else None
            if getattr(response, "choices", None):
                event["finish_reason"] = response.choices[0].finish_reason
            else:
                event["status"] = response.status
            return response
        except Exception as error:
            event["error_type"] = type(error).__name__
            raise
        finally:
            event["elapsed_seconds"] = round(time.monotonic() - started, 3)
