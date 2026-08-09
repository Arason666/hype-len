import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "market_context.py"
SPEC = importlib.util.spec_from_file_location("market_context", MODULE_PATH)
market_context = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(market_context)


class MarketContextTests(unittest.TestCase):
    def test_hype_context_and_market_summaries(self):
        context = market_context.hype_asset_context([
            {"universe": [{"name": "BTC"}, {"name": "HYPE"}]},
            [{"markPx": "100"}, {"markPx": "50", "openInterest": "200"}],
        ])
        self.assertEqual(context["markPx"], "50")

        book = market_context.order_book_summary({"levels": [
            [{"px": "49", "sz": "2"}],
            [{"px": "51", "sz": "1"}],
        ]})
        self.assertGreater(book["imbalance"], 0)
        self.assertGreater(book["spread_bps"], 0)

        flow = market_context.trade_flow_summary([
            {"px": "50", "sz": "2", "side": "B", "time": 1},
            {"px": "50", "sz": "1", "side": "A", "time": 2},
        ])
        self.assertAlmostEqual(flow["buy_share"], 2 / 3, places=6)

    def test_collection_deduplicates_fifteen_minute_bucket(self):
        responses = [
            [{"universe": [{"name": "HYPE"}]}, [{"markPx": "50", "oraclePx": "50", "openInterest": "10", "funding": "0.0001", "premium": "0", "dayNtlVlm": "100"}]],
            {"levels": [[], []]},
            [],
            [{"time": 1_800_000, "fundingRate": "0.0001", "premium": "0"}],
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.json"
            with mock.patch.object(market_context, "api_post", side_effect=responses * 2):
                first = market_context.collect(path, timestamp_ms=2_000_000)
                second = market_context.collect(path, timestamp_ms=2_100_000)
        self.assertEqual(len(first["snapshots"]), 1)
        self.assertEqual(len(second["snapshots"]), 1)
        self.assertEqual(len(second["funding_history"]), 1)

    def test_funding_history_paginates_full_batches(self):
        first = [{"time": index + 1, "fundingRate": "0.0001"} for index in range(500)]
        second = [{"time": 501, "fundingRate": "0.0002"}]
        with mock.patch.object(market_context, "api_post", side_effect=[first, second]) as api:
            records = market_context.fetch_funding_history(1, 1_000)
        self.assertEqual(len(records), 501)
        self.assertEqual(api.call_count, 2)


if __name__ == "__main__":
    unittest.main()
