import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
from PIL import Image

import agent
import tools
from runtime import BudgetExceeded, RunContext
from tool_library import network, vision, webpage_store
from tool_library.errors import ToolError
from test_agent import response


class ToolLibraryTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        replacement = patch.object(webpage_store, 'SNAPSHOT_DIR', Path(directory.name))
        replacement.start()
        self.addCleanup(replacement.stop)

    def call(self, name, arguments, **kwargs):
        return json.loads(tools.execute_tool(name, json.dumps(arguments), **kwargs))

    def test_calculator_results_and_parameter_errors(self):
        self.assertEqual(self.call("calculate", {"operation": "multiply", "a": 123, "b": 456})["result"], 56088)
        self.assertEqual(self.call("calculate", {"operation": "divide", "a": 1, "b": 0})["error"]["code"], "division_by_zero")
        for parameters in [
            {"operation": "multiply", "a": "123", "b": 456},
            {"operation": "multiply", "a": True, "b": 456},
            {"operation": "eval", "a": 1, "b": 2},
            {"operation": "add", "a": 1, "b": 2, "extra": 3},
            {"operation": "add", "a": float("nan"), "b": 2},
        ]:
            with self.subTest(parameters=parameters):
                self.assertEqual(self.call("calculate", parameters)["error"]["code"], "invalid_arguments")

    def test_bad_json_and_unregistered_tool(self):
        for arguments in ["{", "[]", "{}"]:
            self.assertIn("error", json.loads(tools.execute_tool("web_search", arguments)))
        self.assertEqual(self.call("not_registered", {})["error"]["code"], "unknown_tool")
        self.assertEqual(self.call("web_search", {"query": "   "})["error"]["code"], "invalid_arguments")
        self.assertEqual(self.call("web_search", {"query": "python", "max_results": 6})["error"]["code"], "invalid_arguments")

    @patch.object(network, "SEARCH_PROVIDERS", ("duckduckgo", "yahoo"))
    def test_search_backend_mapping_and_safe_failure(self):
        search = Mock()
        search.text.return_value = [{"title": "Title", "href": "https://example.com/", "body": "Snippet"}]
        with patch("tool_library.network.DDGS", return_value=search):
            result = self.call("web_search", {"query": "python"})
        search.text.assert_called_once_with("python", backend="duckduckgo", max_results=3)
        self.assertEqual(result["results"][0], {"title": "Title", "url": "https://example.com/", "snippet": "Snippet"})
        with patch("tool_library.network.DDGS", side_effect=RuntimeError("secret-token-and-headers")):
            result = self.call("web_search", {"query": "python"})
        self.assertNotIn("secret-token", json.dumps(result))
        self.assertIn("error", result)

    def test_webpage_extraction_and_truncation(self):
        page = b"<html><head><title>Demo &amp; Test</title></head><body><article><h1>Learning agents</h1><p>" + b"Agent tools can fetch a webpage and return its text. " * 400 + b"</p></article></body></html>"
        with patch("tool_library.network.fetch_bytes", return_value=(page, "https://example.com/final", "text/html")):
            result = self.call("read_webpage", {"url": "https://example.com/start"})
        self.assertEqual(result["title"], "Demo & Test")
        self.assertEqual(result["url"], "https://example.com/final")
        self.assertEqual(len(result["content"]), network.MAX_WEB_CHARS)
        self.assertTrue(result["truncated"])

    def test_fetch_rechecks_redirect_and_download_limit(self):
        visited = []

        def handle(request):
            visited.append(str(request.url))
            return httpx.Response(302, headers={"location": "http://127.0.0.1/private"})

        client = httpx.Client(transport=httpx.MockTransport(handle))
        def addresses(host, port):
            ip = "127.0.0.1" if host == "127.0.0.1" else "93.184.216.34"
            return [(2, 1, 6, "", (ip, port))]

        with patch("tool_library.network.httpx.Client", return_value=client), patch("tool_library.network.socket.getaddrinfo", side_effect=addresses):
            with self.assertRaisesRegex(ToolError, "公开互联网"):
                network.fetch_bytes("https://example.com", 1024, "text/html")
        self.assertEqual(len(visited), 1)
        client = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * 100)))
        with patch("tool_library.network.httpx.Client", return_value=client), patch("tool_library.network.socket.getaddrinfo", side_effect=addresses):
            with self.assertRaisesRegex(ToolError, "大小上限"):
                network.fetch_bytes("https://example.com", 10, "text/html")

    def test_image_validation_and_vision_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            Image.new("RGB", (20, 20), "red").save(root / "sample.png")
            (root / "not-image.png").write_text("not an image")
            client = Mock()
            client.responses.create.return_value = SimpleNamespace(status="completed", output_text="红色方块", usage=None)
            context = RunContext(client=client, max_model_requests=1)
            with patch("tool_library.vision.IMAGE_DIR", root):
                self.assertEqual(self.call("analyze_image", {"image_source": "images/sample.png", "question": "颜色？"}, context=context)["analysis"], "红色方块")
                for source in ["images/missing.png", "images/not-image.png", "../outside.png"]:
                    self.assertIn("error", self.call("analyze_image", {"image_source": source, "question": "内容？"}, context=RunContext(client=client)))
                with self.assertRaises(BudgetExceeded):
                    self.call("analyze_image", {"image_source": "images/sample.png", "question": "颜色？"}, context=context)
            self.assertEqual(context.model_requests, 1)
            request = client.responses.create.call_args.kwargs
            self.assertEqual(request["reasoning"], {"effort": "none"})
            self.assertTrue(request["input"][0]["content"][1]["image_url"].startswith("data:image/png;base64,"))
            self.assertNotIn("base64", json.dumps(context.events))

    def test_incomplete_vision_is_returned_as_error_not_partial_analysis(self):
        client = Mock()
        client.responses.create.return_value = SimpleNamespace(status="incomplete", output_text="半截内容", usage=None)
        context = RunContext(client=client)
        with patch("tool_library.vision.load_image", return_value="data:image/png;base64,fixture"):
            result = self.call("analyze_image", {"image_source": "images/fixture.png", "question": "读取内容"}, context=context)
        self.assertEqual(result["error"]["code"], "vision_incomplete")
        self.assertNotIn("半截内容", json.dumps(result))

    def test_model_and_time_budget_stop_before_request(self):
        client = Mock()
        context = RunContext(client=client, max_model_requests=0)
        with self.assertRaises(BudgetExceeded):
            context.call_model("agent", client.chat.completions.create)
        client.chat.completions.create.assert_not_called()
        context = RunContext(max_seconds=0)
        with self.assertRaises(BudgetExceeded):
            self.call("calculate", {"operation": "add", "a": 1, "b": 2}, context=context)

    def test_http_error_is_safe_and_keeps_status(self):
        request = httpx.Request("GET", "https://example.com/")
        error = httpx.HTTPStatusError("raw-secret-response", request=request, response=httpx.Response(403, request=request))
        with patch("tool_library.network.fetch_bytes", side_effect=error):
            result = self.call("read_webpage", {"url": "https://example.com/"})
        self.assertEqual(result["error"]["message"], "外部服务返回 HTTP 403")
        self.assertNotIn("raw-secret", json.dumps(result))

    def test_tool_call_budget_and_failure_trace(self):
        context = RunContext(max_tool_calls=1)
        self.call("calculate", {"operation": "divide", "a": 1, "b": 0}, context=context)
        self.assertEqual(context.events[0]["result"]["error"]["code"], "division_by_zero")
        with self.assertRaises(BudgetExceeded):
            self.call("calculate", {"operation": "add", "a": 1, "b": 2}, context=context)

    def test_loop_handles_image_then_calculation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "images"
            root.mkdir()
            Image.new("RGB", (20, 20), "red").save(root / "sample.png")
            client = Mock()
            client.responses.create.return_value = SimpleNamespace(status="completed", output_text="图片中两个数是 12 和 3。", usage=None)
            def call(identifier, name, arguments):
                return {"id": identifier, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}
            client.chat.completions.create.side_effect = [
                response(calls=[call("image", "analyze_image", {"image_source": "images/sample.png", "question": "读取两个数"})], finish_reason="tool_calls"),
                response(calls=[call("math", "calculate", {"operation": "multiply", "a": 12, "b": 3})], finish_reason="tool_calls"),
                response("结果是 36。"),
            ]
            context = RunContext(client=client)
            messages = [{"role": "user", "content": "读图计算"}]
            with patch("tool_library.vision.IMAGE_DIR", root), contextlib.redirect_stdout(io.StringIO()):
                answer = agent.run_agent(client, messages, context=context)
            self.assertEqual(answer, "结果是 36。")
            self.assertEqual(context.model_requests, 4)  # 三次外层请求，加一次视觉请求。
            self.assertEqual(context.tool_calls, 2)
            self.assertEqual([item["tool_call_id"] for item in messages if item["role"] == "tool"], ["image", "math"])
            self.assertEqual(json.loads(messages[-2]["content"])["result"], 36)


if __name__ == "__main__":
    unittest.main()
