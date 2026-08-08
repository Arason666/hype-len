import unittest

from scripts.monitor import align_ratios, ema, latest_cross, percent_change, trend_for


class MonitorMathTests(unittest.TestCase):
    def test_align_ratios_uses_matching_timestamps(self):
        eth = [{"t": 1, "close": 2000}, {"t": 2, "close": 2100}]
        btc = [{"t": 1, "close": 60000}, {"t": 3, "close": 61000}]
        hype = [{"t": 1, "close": 40}, {"t": 2, "close": 42}]
        self.assertEqual(align_ratios(eth, btc, hype), [{"t": 1, "eth": 50, "btc": 1500}])

    def test_ema_tracks_constant_series(self):
        self.assertEqual(ema([5.0] * 30, 8), [5.0] * 30)

    def test_trend_direction_matches_hype_strength_semantics(self):
        falling_ratio = [100 - index for index in range(30)]
        rising_ratio = [100 + index for index in range(30)]
        self.assertEqual(trend_for(falling_ratio).kind, "strong")
        self.assertEqual(trend_for(rising_ratio).kind, "weak")

    def test_percent_change(self):
        self.assertAlmostEqual(percent_change([100, 110, 121], 2), 21.0)
        self.assertIsNone(percent_change([100], 2))

    def test_cross_requires_enough_history(self):
        self.assertIsNone(latest_cross([1.0] * 10))


if __name__ == "__main__":
    unittest.main()
