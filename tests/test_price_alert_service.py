import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from scripts.price_alert_service import (
    AlertEngine,
    JsonStateStore,
    NotificationSender,
    PriceAlertApplication,
    ServiceConfig,
    make_handler,
)


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


class PriceAlertServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.config = ServiceConfig(
            api_token="test-alert-token-with-32-characters",
            allowed_origin="https://northinterval.com",
            state_path=Path(self.temporary_directory.name) / "alerts.json",
            bind_host="127.0.0.1",
            port=0,
            poll_seconds=3,
            session_seconds=30 * 24 * 60 * 60,
            ntfy_url="https://ntfy.sh",
            ntfy_topic="private_test_topic",
            ntfy_token="",
            dashboard_url="https://northinterval.com/",
            tencent_secret_id="",
            tencent_secret_key="",
            tencent_policy_id="",
            tencent_region="ap-guangzhou",
        )

    def tearDown(self):
        self.temporary_directory.cleanup()

    def test_ntfy_uses_utf8_json_instead_of_non_ascii_headers(self):
        response = mock.MagicMock()
        response.read.return_value = b'{"id":"test"}'
        response.__enter__.return_value = response
        with mock.patch("urllib.request.urlopen", return_value=response) as urlopen:
            NotificationSender(self.config).send_ntfy({
                "rule_name": "下跌至83",
                "direction": "below",
                "threshold": 83,
                "trigger_price": 82.99,
            })

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, "https://ntfy.sh")
        self.assertEqual(payload["topic"], "private_test_topic")
        self.assertEqual(payload["title"], "HYPE 到价预警")
        self.assertIn("下跌至83", payload["message"])
        for _, value in request.header_items():
            value.encode("latin-1")

    def test_pairing_cookie_authenticates_only_the_allowed_origin(self):
        application = PriceAlertApplication(self.config, fetch_price=lambda: 83.0)
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(application))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        try:
            connection.request("POST", "/api/pair", headers={
                "Authorization": f"Bearer {self.config.api_token}",
                "Origin": self.config.allowed_origin,
            })
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Access-Control-Allow-Credentials"), "true")
            cookie = response.getheader("Set-Cookie").split(";", 1)[0]

            connection.request("GET", "/api/alerts", headers={
                "Cookie": cookie,
                "Origin": self.config.allowed_origin,
            })
            response = connection.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 200)
            self.assertIn("rules", payload)

            connection.request("GET", "/api/alerts", headers={
                "Cookie": cookie,
                "Origin": "https://attacker.example",
            })
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 403)
        finally:
            connection.close()
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
