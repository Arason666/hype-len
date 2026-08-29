import tempfile
import unittest
from pathlib import Path

from scripts.price_alert_service import AlertEngine, JsonStateStore


class PriceAlertEngineTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.engine = AlertEngine(JsonStateStore(Path(self.temporary_directory.name) / "alerts.json"))

    def tearDown(self):
        self.temporary_directory.cleanup()

    def add_rule(self, **overrides):
        payload = {
            "name": "跌破防守位",
            "direction": "below",
            "threshold": 50,
            "channels": ["ntfy", "phone"],
            "confirm_ticks": 3,
            "cooldown_minutes": 1,
            "rearm_percent": 0.25,
            "phone_delay_seconds": 45,
        }
        payload.update(overrides)
        return self.engine.add_rule(payload)

    def test_requires_consecutive_confirmations(self):
        self.add_rule()
        self.assertEqual(self.engine.process_price(49.9, 1_000), [])
        self.assertEqual(self.engine.process_price(50.1, 1_003), [])
        self.assertEqual(self.engine.process_price(49.8, 1_006), [])
        self.assertEqual(self.engine.process_price(49.7, 1_009), [])
        events = self.engine.process_price(49.6, 1_012)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["trigger_price"], 49.6)

    def test_does_not_repeat_until_cooldown_and_hysteresis_clear(self):
        self.add_rule(confirm_ticks=1)
        first = self.engine.process_price(49.9, 1_000)
        self.assertEqual(len(first), 1)
        self.assertEqual(self.engine.process_price(49.0, 1_100), [])
        self.assertEqual(self.engine.snapshot()["rules"][0]["state"], "cooldown")

        self.engine.process_price(50.2, 1_101)
        snapshot = self.engine.snapshot()
        self.assertEqual(snapshot["rules"][0]["state"], "armed")
        self.assertEqual(snapshot["events"][0]["rearmed_at"], "1970-01-01T00:18:21Z")
        self.assertEqual(len(self.engine.process_price(49.9, 1_104)), 1)

    def test_acknowledgement_cancels_phone_escalation(self):
        self.add_rule(confirm_ticks=1, phone_delay_seconds=45)
        event = self.engine.process_price(49.9, 2_000)[0]
        self.assertEqual(self.engine.phone_events_due(2_044), [])
        self.assertEqual(len(self.engine.phone_events_due(2_045)), 1)
        self.engine.acknowledge(event["id"])
        self.assertEqual(self.engine.phone_events_due(2_100), [])

    def test_state_persists_across_engine_restart(self):
        rule = self.add_rule(confirm_ticks=1)
        self.engine.process_price(49.5, 3_000)
        restarted = AlertEngine(self.engine.store)
        snapshot = restarted.snapshot()
        self.assertEqual(snapshot["rules"][0]["id"], rule["id"])
        self.assertEqual(len(snapshot["events"]), 1)

    def test_invalid_rule_is_rejected(self):
        with self.assertRaises(ValueError):
            self.add_rule(direction="sideways")
        with self.assertRaises(ValueError):
            self.add_rule(threshold=-1)
        with self.assertRaises(ValueError):
            self.add_rule(channels=[])


if __name__ == "__main__":
    unittest.main()
