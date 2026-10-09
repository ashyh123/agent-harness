import json
import unittest
import httpx
from unittest.mock import patch

from runtime import BudgetExceeded, RunContext
from tools import execute_tool
from tool_library import data


class DataToolsTests(unittest.TestCase):
    def setUp(self):
        self.context = RunContext(max_tool_calls=100)

    def call(self, name="read_data", **arguments):
        return json.loads(execute_tool(name, json.dumps(arguments), context=self.context))

    def test_csv_quotes_bom_multiline_roundtrip(self):
        original = '\ufeffname,value,notes\n"a,b",001,"line 1\n#line 2"\n'
        read = self.call(text=original, data_format="csv")
        self.assertEqual(read["data"], [{"name": "a,b", "value": "001", "notes": "line 1\n#line 2"}])
        converted = self.call("query_data", dataset_id=read["dataset_id"], output_format="csv")
        again = self.call(text=converted["data"], data_format="csv")
        self.assertEqual(again["data"], read["data"])

    def test_json_pointer_and_csv_projection(self):
        read = self.call(text='{"a/b":{"~items":[{"name":"甲,乙","n":2,"extra":null}]}}',
                         json_pointer="/a~1b/~0items", columns=["name", "n"], output_format="csv")
        self.assertEqual(read["data"], 'name,n\n"甲,乙",2\n')
        self.assertEqual(self.call("query_data", dataset_id=read["dataset_id"], json_pointer="/bad")["error"]["code"], "missing_path")
        self.assertEqual(self.call("query_data", dataset_id=read["dataset_id"], json_pointer="/a~2b")["error"]["code"], "invalid_pointer")

    def test_full_dataset_numeric_filter_sort_aggregate_not_preview(self):
        read = self.call(text="id,n\na,2\nb,10\nc,3\nd,20\n", data_format="csv", limit=1)
        selected = self.call("query_data", dataset_id=read["dataset_id"],
                             filters=[{"column": "n", "operator": "ge", "value": 3}],
                             sort_by="n", numeric_sort=True, descending=True, limit=2)
        self.assertEqual([row["id"] for row in selected["data"]], ["d", "b"])
        total = self.call("query_data", dataset_id=read["dataset_id"], aggregate="sum", aggregate_column="n", limit=1)
        self.assertEqual(total["value"], 35)
        self.assertEqual(total["matched_records"], 4)

    def test_decimal_sum_and_large_integers(self):
        read = self.call(text='[{"n":0.1},{"n":0.2}]')
        total = self.call("query_data", dataset_id=read["dataset_id"], aggregate="sum", aggregate_column="n")
        self.assertEqual(total["decimal_value"], "0.3")
        big = self.call(text='[{"n":123456789012345678901234567890},{"n":1}]')
        total = self.call("query_data", dataset_id=big["dataset_id"], aggregate="sum", aggregate_column="n")
        self.assertEqual(total["value"], 123456789012345678901234567891)

    def test_json_numeric_equality_preserves_integer_precision_and_bool_type(self):
        read = self.call(text='[{"n":1},{"n":true},{"n":"1"},{"n":123456789012345678901234567890}]')
        selected = self.call("query_data", dataset_id=read["dataset_id"], filters=[{"column": "n", "operator": "eq", "value": 1.0}])
        self.assertEqual(selected["data"], [{"n": 1}])
        selected = self.call("query_data", dataset_id=read["dataset_id"], filters=[{"column": "n", "operator": "eq", "value": 123456789012345678901234567890}])
        self.assertEqual(selected["data"], [{"n": 123456789012345678901234567890}])

    def test_empty_or_invalid_numeric_values_are_not_zero(self):
        for value in ['""', 'null', 'true', '"NaN"']:
            read = self.call(text='[{"n":' + value + '}]')
            result = self.call("query_data", dataset_id=read["dataset_id"], aggregate="mean", aggregate_column="n")
            self.assertEqual(result["error"]["code"], "non_numeric")
        read = self.call(text='[]')
        self.assertEqual(self.call("query_data", dataset_id=read["dataset_id"], aggregate="count")["value"], 0)
        self.assertEqual(self.call("query_data", dataset_id=read["dataset_id"], aggregate="mean", aggregate_column="n")["error"]["code"], "empty_data")

    def test_invalid_json_and_csv_rejected(self):
        for text in ['{"a":1,}', '{"a":1,"a":2}', '{"a":NaN}', '{"a":1e999}']:
            self.assertEqual(self.call(text=text, data_format="json")["error"]["code"], "invalid_data")
        for text in ['a,a\n1,2\n', 'a,\n1,2\n', 'a,b\n1\n', 'a,b\n"unfinished,2']:
            self.assertEqual(self.call(text=text, data_format="csv")["error"]["code"], "invalid_data")
        self.assertEqual(self.context.data_documents, {})

    def test_null_and_nested_json_csv_conversion_explicitly_fails(self):
        for text in ['[{"n":null}]', '[{"n":{"nested":1}}]']:
            result = self.call(text=text, output_format="csv")
            self.assertEqual(result["error"]["code"], "lossy_conversion")

    def test_leading_comments_do_not_remove_quoted_csv_lines(self):
        result = self.call(text='# NOAA metadata\n\nyear,mean,notes\n2024,424.61,"first\n#keep"\n',
                           data_format="csv", comment_prefix="#")
        self.assertEqual(result["data"][0]["notes"], "first\n#keep")

    def test_pagination_preserves_rows_without_string_truncation(self):
        with patch.object(data, "MAX_RESULT_CHARS", 900):
            read = self.call(text=json.dumps([{"id": i, "v": "x" * 150} for i in range(10)]), limit=10)
            self.assertLess(read["returned_records"], 10)
            self.assertTrue(read["has_more"])
            rows = read["data"]
            while read["has_more"]:
                read = self.call("query_data", dataset_id=read["dataset_id"], offset=read["next_offset"], limit=10)
                rows.extend(read["data"])
            self.assertEqual([row["id"] for row in rows], list(range(10)))
            self.assertTrue(all(row["v"] == "x" * 150 for row in rows))
        with patch.object(data, "MAX_RESULT_CHARS", 500):
            read = self.call(text='[{"v":"' + "x" * 1000 + '"}]')
            self.assertTrue(read["preview_omitted"])
            self.assertEqual(self.call("query_data", dataset_id=read["dataset_id"])["error"]["code"], "result_too_large")

    def test_large_nested_json_keeps_id_and_structure_for_targeted_recall(self):
        with patch.object(data, "MAX_RESULT_CHARS", 900):
            read = self.call(text=json.dumps({"rows": [{"n": i, "note": "x" * 50} for i in range(50)]}))
            self.assertTrue(read["preview_omitted"])
            self.assertEqual(read["structure"]["fields"], ["rows"])
            query = self.call("query_data", dataset_id=read["dataset_id"], json_pointer="/rows", columns=["n"], limit=2)
            self.assertEqual(query["data"], [{"n": 0}, {"n": 1}])
            self.assertEqual(query["total_records"], 50)

    def test_network_uses_bounded_fetch_and_no_snapshots(self):
        with patch.object(data, "fetch_bytes", return_value=(b'[{"n":4}]', "https://example.com/data.json", "application/json")) as fetch, \
             patch("tool_library.network.save_webpage") as save:
            result = self.call(url="https://example.com/data.json")
            self.assertEqual(result["data"], [{"n": 4}])
            self.assertEqual(fetch.call_args.args[1], data.MAX_BYTES)
            save.assert_not_called()
        with patch.object(data, "fetch_bytes", return_value=(b'\xff', "https://example.com/data.csv", "text/csv")):
            self.assertEqual(self.call(url="https://example.com/data.csv")["error"]["code"], "unsupported_encoding")
        with patch.object(data, "fetch_bytes", return_value=(b'<html>blocked</html>', "https://example.com/data.csv", "text/html")):
            self.assertEqual(self.call(url="https://example.com/data.csv")["error"]["code"], "unsupported_content")
        with patch.object(data, "fetch_bytes", side_effect=httpx.ReadTimeout("private error")):
            self.assertEqual(self.call(url="https://example.com/data.csv")["error"]["code"], "network_timeout")
        with patch("tool_library.network.socket.getaddrinfo", return_value=[(2, 1, 6, '', ('127.0.0.1', 80))]):
            self.assertEqual(self.call(url="http://localhost/data.json")["error"]["code"], "invalid_url")

    def test_data_cache_is_per_run_and_budget_still_applies(self):
        read = self.call(text='[{"n":1}]')
        fresh = RunContext()
        result = json.loads(execute_tool("query_data", json.dumps({"dataset_id": read["dataset_id"]}), context=fresh))
        self.assertEqual(result["error"]["code"], "data_not_found")
        fresh.max_tool_calls = 1
        with self.assertRaises(BudgetExceeded):
            execute_tool("read_data", '{"text":"[]"}', context=fresh)
        self.assertEqual(self.call(url="https://example.com", text="[]")["error"]["code"], "invalid_arguments")
        self.assertEqual(self.call(text="n\n1", data_format="csv", limit=101)["error"]["code"], "invalid_arguments")
        with patch.object(data, "MAX_DOCUMENTS", 1):
            self.assertEqual(self.call(text='[{"n":2}]')["error"]["code"], "data_cache_full")
        with patch.object(data, "MAX_BYTES", 2):
            self.assertEqual(self.call(text="[1]")["error"]["code"], "too_large")
        with patch.object(data, "MAX_ROWS", 1):
            self.assertEqual(self.call(text="n\n1\n2\n", data_format="csv")["error"]["code"], "too_large")


if __name__ == "__main__":
    unittest.main()
