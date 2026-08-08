import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "x_monitor.py"
SPEC = importlib.util.spec_from_file_location("x_monitor", MODULE_PATH)
x_monitor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(x_monitor)


class XMonitorTests(unittest.TestCase):
    def test_analysis_detects_bullish_fundamental_view(self):
        result = x_monitor.analyze_text(
            "HYPE revenue reached a new high and buyback growth remains bullish.",
            influence=78,
        )
        self.assertEqual(result["direction"], "bullish")
        self.assertEqual(result["event_type"], "基本面 / 生态事件")
        self.assertGreater(result["direction_score"], 0)

    def test_config_cannot_exceed_user_caps(self):
        with mock.patch.dict(os.environ, {"X_DAILY_POST_LIMIT": "21"}, clear=False):
            with self.assertRaises(RuntimeError):
                x_monitor.post_limit()
        with mock.patch.dict(os.environ, {"X_DAILY_COST_LIMIT_USD": "0.151"}, clear=False):
            with self.assertRaises(RuntimeError):
                x_monitor.cost_limit_micros()

    def test_collection_stops_at_twenty_posts_and_fifteen_cents(self):
        day = "2026-08-08"
        state = x_monitor.default_state(day)
        state["usage"]["user_reads"] = 5
        state["usage"]["estimated_cost_micros"] = 50_000
        state["user_ids"] = {source["handle"].lower(): str(index + 1) for index, source in enumerate(x_monitor.SOURCES)}
        public_data = {"posts": []}

        def five_posts(_state, source, _token):
            source_index = next(index for index, item in enumerate(x_monitor.SOURCES) if item["handle"] == source["handle"])
            return [
                {
                    "id": f"{source_index + 1}{number:02d}",
                    "author_id": str(source_index + 1),
                    "created_at": f"2026-08-08T0{source_index}:0{number}:00Z",
                    "text": "HYPE market update",
                    "public_metrics": {},
                }
                for number in range(5)
            ]

        with mock.patch.object(x_monitor, "timeline_posts", side_effect=five_posts) as timeline:
            new_count, changed = x_monitor.collect_posts(
                state,
                public_data,
                "token",
                daily_post_limit=20,
                cost_limit=150_000,
            )

        self.assertTrue(changed)
        self.assertEqual(new_count, 20)
        self.assertEqual(state["usage"]["analyses"], 20)
        self.assertEqual(state["usage"]["estimated_cost_micros"], 150_000)
        self.assertEqual(timeline.call_count, 4)


if __name__ == "__main__":
    unittest.main()
