import json
import os
import unittest
from unittest.mock import Mock, patch

from ddgs.exceptions import DDGSException
from tavily.errors import TavilyKeylessLimitError

import tools
from runtime import BudgetExceeded, RunContext
from tool_library.network import web_search
from tool_library import network


RESULT = {"title": "Official article", "href": "https://www.anthropic.com/engineering/building-effective-agents", "body": "Article summary"}


class SearchReliabilityTests(unittest.TestCase):
    def setUp(self):
        providers = patch.object(network, "SEARCH_PROVIDERS", ("duckduckgo", "yahoo"))
        providers.start()
        self.addCleanup(providers.stop)

    def test_duckduckgo_failure_falls_back_to_yahoo_with_actual_provider(self):
        search = Mock()
        search.text.side_effect = [DDGSException("No results found."), [RESULT]]
        with patch("tool_library.network.DDGS", return_value=search):
            result = web_search("Anthropic agents")
        self.assertEqual(result["provider"], "yahoo")
        self.assertEqual(result["results"][0]["url"], RESULT["href"])
        self.assertEqual([c.kwargs["backend"] for c in search.text.call_args_list], ["duckduckgo", "yahoo"])
        self.assertEqual([a["status"] for a in result["attempts"]], ["unavailable", "ok"])

    def test_failed_provider_is_not_requested_again_in_same_run(self):
        search = Mock()
        search.text.side_effect = [DDGSException("No results found."), [RESULT], [RESULT]]
        context = RunContext()
        with patch("tool_library.network.DDGS", return_value=search):
            web_search("first query", context=context)
            result = web_search("second query", context=context)
        self.assertEqual([c.kwargs["backend"] for c in search.text.call_args_list], ["duckduckgo", "yahoo", "yahoo"])
        self.assertEqual(result["attempts"][0]["status"], "skipped")

    def test_all_failed_is_safe_and_followup_makes_no_network_requests(self):
        search = Mock()
        search.text.side_effect = DDGSException("secret-token-and-headers")
        context = RunContext()
        with patch("tool_library.network.DDGS", return_value=search):
            first = json.loads(tools.execute_tool("web_search", '{"query":"agents"}', context=context))
            second = json.loads(tools.execute_tool("web_search", '{"query":"new keywords"}', context=context))
        self.assertEqual(search.text.call_count, 2)
        self.assertEqual(first["error"]["code"], "search_unavailable")
        self.assertFalse(first["error"]["retryable"])
        self.assertEqual(second["error"]["code"], "search_unavailable")
        self.assertNotIn("secret-token", json.dumps(context.events))
        self.assertEqual(context.tool_calls, 2)
        self.assertEqual(context.model_requests, 0)

    def test_new_run_retries_primary_provider(self):
        search = Mock()
        search.text.side_effect = [DDGSException("blocked"), [RESULT], [RESULT]]
        with patch("tool_library.network.DDGS", return_value=search):
            web_search("agents", context=RunContext())
            result = web_search("agents", context=RunContext())
        self.assertEqual(result["provider"], "duckduckgo")

    def test_explicit_empty_results_are_distinct_from_service_failure(self):
        search = Mock()
        search.text.return_value = []
        with patch("tool_library.network.DDGS", return_value=search):
            result = web_search("unlikely keywords")
        self.assertNotIn("error", result)
        self.assertEqual(result["results"], [])
        self.assertEqual([a["status"] for a in result["attempts"]], ["no_results", "no_results"])

    def test_fallback_cannot_bypass_total_time_budget(self):
        search = Mock()
        search.text.side_effect = DDGSException("blocked")
        context = RunContext()
        with patch.object(context, "remaining_seconds", side_effect=[2.5, BudgetExceeded("time exhausted")]), patch("tool_library.network.DDGS", return_value=search) as constructor:
            with self.assertRaises(BudgetExceeded):
                web_search("agents", context=context)
        self.assertEqual(search.text.call_count, 1)
        self.assertLessEqual(constructor.call_args.kwargs["timeout"], 2.5)

    def test_missing_or_unsafe_result_urls_do_not_count_as_success(self):
        search = Mock()
        search.text.side_effect = [[{"title": "bad", "href": "javascript:alert(1)"},
                                    {"title": "ad", "href": "https://www.bing.com/aclick?ad=1"}], [RESULT]]
        with patch("tool_library.network.DDGS", return_value=search):
            result = web_search("agents")
        self.assertEqual(result["provider"], "yahoo")
        self.assertEqual(len(result["results"]), 1)


class TavilySearchTests(unittest.TestCase):
    def test_sdk_keyless_primary_no_key_or_generated_answer_and_bounded_output(self):
        response = Mock(status_code=200)
        response.json.return_value = {"query": "agents", "results": [{"title": "Title", "url": RESULT["href"], "content": "x" * 1500}], "answer": "untrusted generated answer"}

        def post(session, url, **kwargs):
            self.assertEqual(url, "https://api.tavily.com/search")
            self.assertEqual(session.headers["X-Tavily-Access-Mode"], "keyless")
            self.assertNotIn("Authorization", session.headers)
            payload = json.loads(kwargs["data"])
            self.assertEqual(payload["search_depth"], "basic")
            self.assertFalse(payload["include_answer"])
            self.assertFalse(payload["include_raw_content"])
            self.assertNotIn("api_key", payload)
            self.assertLessEqual(kwargs["timeout"], 5)
            return response

        with patch.dict(os.environ, {"TAVILY_API_KEY": "must-not-be-sent"}), patch("requests.Session.post", autospec=True, side_effect=post) as request, patch("tool_library.network.DDGS") as ddgs:
            result = web_search("agents", max_results=2)
        self.assertEqual(result["provider"], "tavily")
        self.assertEqual(result["access_mode"], "keyless")
        self.assertEqual(len(result["results"][0]["snippet"]), 1000)
        self.assertNotIn("untrusted generated answer", json.dumps(result))
        request.assert_called_once()
        ddgs.assert_not_called()

    def test_keyless_limit_uses_fallback_and_is_not_retried_in_same_run(self):
        context = RunContext()
        search = Mock()
        search.text.return_value = [RESULT]
        failure = TavilyKeylessLimitError("secret-raw-server-response", code="rate_limit", window="minute", retry_after_seconds=30)
        with patch("requests.Session.post", side_effect=failure) as request, patch("tool_library.network.DDGS", return_value=search):
            first = web_search("agents", context=context)
            second = web_search("other query", context=context)
        self.assertEqual(first["provider"], "duckduckgo")
        self.assertEqual(first["attempts"][0]["retry_after_seconds"], 30)
        self.assertEqual(second["attempts"][0]["status"], "skipped")
        request.assert_called_once()
        self.assertNotIn("secret-raw", json.dumps(first))

    def test_malformed_sdk_response_falls_back_instead_of_claiming_zero_results(self):
        response = Mock(status_code=200)
        response.json.return_value = {"answer": "not a search result"}
        search = Mock()
        search.text.return_value = [RESULT]
        with patch("requests.Session.post", return_value=response), patch("tool_library.network.DDGS", return_value=search):
            result = web_search("agents")
        self.assertEqual(result["provider"], "duckduckgo")
        self.assertEqual(result["attempts"][0]["status"], "unavailable")

    def test_all_three_providers_fail_without_raw_exception_leak(self):
        response = Mock(status_code=429)
        response.json.return_value = {"error": {"code": "rate_limit", "message": "secret-server-message", "retry_after_seconds": 30}}
        search = Mock()
        search.text.side_effect = DDGSException("secret-ddgs-message")
        context = RunContext()
        with patch("requests.Session.post", return_value=response) as request, patch("tool_library.network.DDGS", return_value=search):
            first = web_search("agents", context=context)
            second = web_search("agents again", context=context)
        self.assertEqual(first["error"]["code"], "search_unavailable")
        self.assertEqual(len(first["attempts"]), 3)
        self.assertEqual([a["status"] for a in second["attempts"]], ["skipped"] * 3)
        request.assert_called_once()
        self.assertEqual(search.text.call_count, 2)
        self.assertNotIn("secret-", json.dumps(first))
