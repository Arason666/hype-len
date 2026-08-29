#!/usr/bin/env python3
"""Always-on HYPE price alerts with a small authenticated JSON API.

The service intentionally uses only the Python standard library.  It polls the
Hyperliquid public API, persists rules/events to a JSON file, sends an urgent
ntfy notification immediately, and can escalate an unacknowledged event to a
Tencent Cloud Monitor phone policy after a configurable delay.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import signal
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable


HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info"
TENCENT_MONITOR_HOST = "monitor.tencentcloudapi.com"
TENCENT_MONITOR_VERSION = "2018-07-24"
MAX_RULES = 30
MAX_EVENTS = 300
ALERT_SESSION_COOKIE = "__Host-hype_alert_session"


def utc_now_iso(timestamp: float | None = None) -> str:
    return datetime.fromtimestamp(timestamp or time.time(), timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value: str | None) -> float:
    if not value:
        return 0.0
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def post_json(url: str, payload: object, headers: dict[str, str] | None = None, timeout: int = 15) -> object:
    request_headers = {"Content-Type": "application/json", "User-Agent": "hype-lens-price-alert/1.0"}
    request_headers.update(headers or {})
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers=request_headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_hype_mark_price() -> float:
    payload = post_json(HYPERLIQUID_API_URL, {"type": "metaAndAssetCtxs"})
    if not isinstance(payload, list) or len(payload) < 2:
        raise RuntimeError("Hyperliquid returned an unexpected market payload")
    universe = payload[0].get("universe", [])
    contexts = payload[1]
    for index, asset in enumerate(universe):
        if asset.get("name") == "HYPE" and index < len(contexts):
            price = float(contexts[index]["markPx"])
            if price > 0:
                return price
    raise RuntimeError("HYPE mark price is missing from Hyperliquid")


class JsonStateStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict:
        if not self.path.exists():
            return {"rules": [], "events": [], "latest_price": None, "latest_price_at": None}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Unable to read alert state: {exc}") from exc
        payload.setdefault("rules", [])
        payload.setdefault("events", [])
        return payload

    def save(self, payload: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix="price-alert-", suffix=".json", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temporary_name, self.path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)


class AlertEngine:
    """State machine for confirmed crossings, cooldowns and re-arming."""

    def __init__(self, store: JsonStateStore):
        self.store = store
        self.state = store.load()
        self.lock = threading.RLock()

    @staticmethod
    def validate_rule(payload: dict, existing: dict | None = None) -> dict:
        merged = {**(existing or {}), **payload}
        direction = str(merged.get("direction", "")).strip()
        if direction not in {"above", "below"}:
            raise ValueError("direction must be above or below")
        threshold = float(merged.get("threshold", 0))
        if not 0 < threshold < 1_000_000:
            raise ValueError("threshold must be a positive price")
        channels = merged.get("channels", ["ntfy"])
        if not isinstance(channels, list):
            raise ValueError("channels must be a list")
        channels = sorted(set(str(item) for item in channels) & {"ntfy", "phone"})
        if not channels:
            raise ValueError("select at least one notification channel")
        confirm_ticks = int(merged.get("confirm_ticks", 3))
        cooldown_minutes = int(merged.get("cooldown_minutes", 15))
        rearm_percent = float(merged.get("rearm_percent", 0.25))
        phone_delay_seconds = int(merged.get("phone_delay_seconds", 45))
        if not 1 <= confirm_ticks <= 20:
            raise ValueError("confirm_ticks must be between 1 and 20")
        if not 1 <= cooldown_minutes <= 1_440:
            raise ValueError("cooldown_minutes must be between 1 and 1440")
        if not 0.01 <= rearm_percent <= 10:
            raise ValueError("rearm_percent must be between 0.01 and 10")
        if not 0 <= phone_delay_seconds <= 3_600:
            raise ValueError("phone_delay_seconds must be between 0 and 3600")
        return {
            "name": str(merged.get("name") or f"HYPE {direction} {threshold:g}")[:80],
            "direction": direction,
            "threshold": threshold,
            "channels": channels,
            "enabled": bool(merged.get("enabled", True)),
            "confirm_ticks": confirm_ticks,
            "cooldown_minutes": cooldown_minutes,
            "rearm_percent": rearm_percent,
            "phone_delay_seconds": phone_delay_seconds,
        }

    def snapshot(self) -> dict:
        with self.lock:
            return json.loads(json.dumps(self.state))

    def add_rule(self, payload: dict) -> dict:
        with self.lock:
            if len(self.state["rules"]) >= MAX_RULES:
                raise ValueError(f"at most {MAX_RULES} rules are allowed")
            validated = self.validate_rule(payload)
            now = utc_now_iso()
            rule = {
                "id": uuid.uuid4().hex,
                **validated,
                "state": "armed",
                "confirm_streak": 0,
                "created_at": now,
                "updated_at": now,
                "last_triggered_at": None,
                "cooldown_until": None,
                "rearmed_at": now,
            }
            self.state["rules"].append(rule)
            self.store.save(self.state)
            return json.loads(json.dumps(rule))

    def update_rule(self, rule_id: str, payload: dict) -> dict:
        with self.lock:
            rule = self._rule(rule_id)
            rule.update(self.validate_rule(payload, rule))
            rule["updated_at"] = utc_now_iso()
            if payload.get("reset_state"):
                rule.update({"state": "armed", "confirm_streak": 0, "cooldown_until": None, "rearmed_at": utc_now_iso()})
            self.store.save(self.state)
            return json.loads(json.dumps(rule))

    def delete_rule(self, rule_id: str) -> None:
        with self.lock:
            before = len(self.state["rules"])
            self.state["rules"] = [rule for rule in self.state["rules"] if rule["id"] != rule_id]
            if len(self.state["rules"]) == before:
                raise KeyError(rule_id)
            self.store.save(self.state)

    def acknowledge(self, event_id: str) -> dict:
        with self.lock:
            event = self._event(event_id)
            if not event.get("acknowledged_at"):
                event["acknowledged_at"] = utc_now_iso()
                event["status"] = "acknowledged"
                self.store.save(self.state)
            return json.loads(json.dumps(event))

    def process_price(self, price: float, now: float | None = None) -> list[dict]:
        now = now or time.time()
        now_iso = utc_now_iso(now)
        triggered: list[dict] = []
        with self.lock:
            self.state["latest_price"] = price
            self.state["latest_price_at"] = now_iso
            for rule in self.state["rules"]:
                if not rule.get("enabled", True):
                    rule["confirm_streak"] = 0
                    continue
                if rule.get("state") != "armed":
                    if now >= parse_iso(rule.get("cooldown_until")) and self._cleared(rule, price):
                        rule.update({"state": "armed", "confirm_streak": 0, "rearmed_at": now_iso})
                        for event in self.state["events"]:
                            if event.get("rule_id") == rule["id"] and not event.get("rearmed_at"):
                                event["rearmed_at"] = now_iso
                                break
                    continue
                if self._matches(rule, price):
                    rule["confirm_streak"] = int(rule.get("confirm_streak", 0)) + 1
                else:
                    rule["confirm_streak"] = 0
                if rule["confirm_streak"] >= rule["confirm_ticks"]:
                    event = self._trigger(rule, price, now)
                    triggered.append(json.loads(json.dumps(event)))
            self.store.save(self.state)
        return triggered

    def phone_events_due(self, now: float | None = None) -> list[dict]:
        now = now or time.time()
        with self.lock:
            return [
                json.loads(json.dumps(event))
                for event in self.state["events"]
                if "phone" in event.get("channels", [])
                and event.get("phone_status") == "pending"
                and not event.get("acknowledged_at")
                and now >= parse_iso(event.get("phone_due_at"))
            ]

    def mark_delivery(self, event_id: str, channel: str, status: str, detail: str = "") -> None:
        with self.lock:
            event = self._event(event_id)
            event[f"{channel}_status"] = status
            event[f"{channel}_detail"] = detail[:300]
            event[f"{channel}_updated_at"] = utc_now_iso()
            if channel == "phone" and status == "sent" and not event.get("acknowledged_at"):
                event["status"] = "phone_escalated"
            self.store.save(self.state)

    def _trigger(self, rule: dict, price: float, now: float) -> dict:
        now_iso = utc_now_iso(now)
        event = {
            "id": uuid.uuid4().hex,
            "rule_id": rule["id"],
            "rule_name": rule["name"],
            "direction": rule["direction"],
            "threshold": rule["threshold"],
            "trigger_price": price,
            "triggered_at": now_iso,
            "channels": rule["channels"],
            "status": "triggered",
            "acknowledged_at": None,
            "ntfy_status": "pending" if "ntfy" in rule["channels"] else "skipped",
            "phone_status": "pending" if "phone" in rule["channels"] else "skipped",
            "phone_due_at": utc_now_iso(now + rule["phone_delay_seconds"]),
        }
        self.state["events"].insert(0, event)
        del self.state["events"][MAX_EVENTS:]
        rule.update({
            "state": "cooldown",
            "confirm_streak": 0,
            "last_triggered_at": now_iso,
            "cooldown_until": utc_now_iso(now + rule["cooldown_minutes"] * 60),
        })
        return event

    @staticmethod
    def _matches(rule: dict, price: float) -> bool:
        return price >= rule["threshold"] if rule["direction"] == "above" else price <= rule["threshold"]

    @staticmethod
    def _cleared(rule: dict, price: float) -> bool:
        buffer_ratio = rule["rearm_percent"] / 100
        if rule["direction"] == "above":
            return price <= rule["threshold"] * (1 - buffer_ratio)
        return price >= rule["threshold"] * (1 + buffer_ratio)

    def _rule(self, rule_id: str) -> dict:
        for rule in self.state["rules"]:
            if rule["id"] == rule_id:
                return rule
        raise KeyError(rule_id)

    def _event(self, event_id: str) -> dict:
        for event in self.state["events"]:
            if event["id"] == event_id:
                return event
        raise KeyError(event_id)


@dataclass(frozen=True)
class ServiceConfig:
    api_token: str
    allowed_origin: str
    state_path: Path
    bind_host: str
    port: int
    poll_seconds: float
    session_seconds: int
    ntfy_url: str
    ntfy_topic: str
    ntfy_token: str
    dashboard_url: str
    tencent_secret_id: str
    tencent_secret_key: str
    tencent_policy_id: str
    tencent_region: str

    @classmethod
    def from_env(cls) -> "ServiceConfig":
        api_token = os.environ.get("ALERT_API_TOKEN", "").strip()
        if len(api_token) < 16:
            raise RuntimeError("ALERT_API_TOKEN must contain at least 16 characters")
        return cls(
            api_token=api_token,
            allowed_origin=os.environ.get("ALERT_ALLOWED_ORIGIN", "http://localhost:8080").strip(),
            state_path=Path(os.environ.get("ALERT_STATE_PATH", "data/price-alert-state.json")),
            bind_host=os.environ.get("ALERT_BIND_HOST", "127.0.0.1").strip(),
            port=int(os.environ.get("ALERT_PORT", "8787")),
            poll_seconds=max(1.0, float(os.environ.get("ALERT_POLL_SECONDS", "3"))),
            session_seconds=max(3_600, int(os.environ.get("ALERT_SESSION_SECONDS", str(30 * 24 * 60 * 60)))),
            ntfy_url=os.environ.get("NTFY_URL", "https://ntfy.sh").rstrip("/"),
            ntfy_topic=os.environ.get("NTFY_TOPIC", "").strip(),
            ntfy_token=os.environ.get("NTFY_ACCESS_TOKEN", "").strip(),
            dashboard_url=os.environ.get("DASHBOARD_URL", "").strip(),
            tencent_secret_id=os.environ.get("TENCENTCLOUD_SECRET_ID", "").strip(),
            tencent_secret_key=os.environ.get("TENCENTCLOUD_SECRET_KEY", "").strip(),
            tencent_policy_id=os.environ.get("TENCENT_MONITOR_POLICY_ID", "").strip(),
            tencent_region=os.environ.get("TENCENTCLOUD_REGION", "ap-guangzhou").strip(),
        )


class NotificationSender:
    def __init__(self, config: ServiceConfig):
        self.config = config

    def send_ntfy(self, event: dict) -> None:
        if not self.config.ntfy_topic:
            raise RuntimeError("NTFY_TOPIC is not configured")
        direction = "上涨至" if event["direction"] == "above" else "下跌至"
        headers = {}
        if self.config.ntfy_token:
            headers["Authorization"] = f"Bearer {self.config.ntfy_token}"
        message = (
            f"{event['rule_name']}：HYPE 已{direction} ${event['threshold']:g}，"
            f"触发价 ${event['trigger_price']:g}。请检查仓位和交易所止损。"
        )
        payload = {
            "topic": self.config.ntfy_topic,
            "title": "HYPE 到价预警",
            "message": message,
            "priority": 5,
            "tags": ["rotating_light", "chart_with_upwards_trend"],
        }
        if self.config.dashboard_url:
            payload["click"] = self.config.dashboard_url.rstrip("/") + "/#alert"
        post_json(self.config.ntfy_url, payload, headers=headers)

    def send_phone(self, event: dict) -> None:
        if not all((self.config.tencent_secret_id, self.config.tencent_secret_key, self.config.tencent_policy_id)):
            raise RuntimeError("Tencent Cloud phone policy credentials are not configured")
        direction = "上涨" if event["direction"] == "above" else "下跌"
        message = (
            f"HYPE价格预警：当前价格{event['trigger_price']:g}美元，"
            f"已{direction}触发价{event['threshold']:g}美元。请检查仓位。"
        )
        self._tencent_request({"Module": "monitor", "PolicyId": self.config.tencent_policy_id, "Msg": message})

    def _tencent_request(self, payload: dict) -> object:
        timestamp = int(time.time())
        date = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d")
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        canonical_headers = f"content-type:application/json; charset=utf-8\nhost:{TENCENT_MONITOR_HOST}\n"
        signed_headers = "content-type;host"
        canonical_request = "\n".join(("POST", "/", "", canonical_headers, signed_headers, hashlib.sha256(body.encode()).hexdigest()))
        credential_scope = f"{date}/monitor/tc3_request"
        string_to_sign = "\n".join(("TC3-HMAC-SHA256", str(timestamp), credential_scope, hashlib.sha256(canonical_request.encode()).hexdigest()))

        def sign(key: bytes, message: str) -> bytes:
            return hmac.new(key, message.encode(), hashlib.sha256).digest()

        secret_date = sign(("TC3" + self.config.tencent_secret_key).encode(), date)
        secret_service = sign(secret_date, "monitor")
        secret_signing = sign(secret_service, "tc3_request")
        signature = hmac.new(secret_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
        authorization = (
            "TC3-HMAC-SHA256 "
            f"Credential={self.config.tencent_secret_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        headers = {
            "Authorization": authorization,
            "Content-Type": "application/json; charset=utf-8",
            "Host": TENCENT_MONITOR_HOST,
            "X-TC-Action": "SendCustomAlarmMsg",
            "X-TC-Version": TENCENT_MONITOR_VERSION,
            "X-TC-Timestamp": str(timestamp),
            "X-TC-Region": self.config.tencent_region,
        }
        response = post_json(f"https://{TENCENT_MONITOR_HOST}", payload, headers=headers)
        error = response.get("Response", {}).get("Error") if isinstance(response, dict) else None
        if error:
            raise RuntimeError(f"Tencent Cloud rejected the alert: {error.get('Code')} {error.get('Message')}")
        return response


class PriceAlertApplication:
    def __init__(self, config: ServiceConfig, fetch_price: Callable[[], float] = fetch_hype_mark_price):
        self.config = config
        self.engine = AlertEngine(JsonStateStore(config.state_path))
        self.sender = NotificationSender(config)
        self.fetch_price = fetch_price
        self.stop_event = threading.Event()
        self.last_error = ""
        self.last_delivery: dict[str, dict] = {}
        self.started_at = utc_now_iso()

    def issue_session(self, now: float | None = None) -> tuple[str, int]:
        issued_at = int(now or time.time())
        expires_at = issued_at + self.config.session_seconds
        unsigned = f"v1.{expires_at}.{secrets.token_urlsafe(18)}"
        signature = hmac.new(self.config.api_token.encode(), unsigned.encode(), hashlib.sha256).hexdigest()
        return f"{unsigned}.{signature}", expires_at

    def verify_session(self, token: str, now: float | None = None) -> bool:
        try:
            version, expires_at, nonce, supplied_signature = token.split(".", 3)
            expiry = int(expires_at)
        except (AttributeError, TypeError, ValueError):
            return False
        if version != "v1" or not nonce or expiry <= int(now or time.time()):
            return False
        unsigned = f"{version}.{expires_at}.{nonce}"
        expected_signature = hmac.new(self.config.api_token.encode(), unsigned.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(supplied_signature, expected_signature)

    def monitor_forever(self) -> None:
        while not self.stop_event.is_set():
            try:
                price = self.fetch_price()
                events = self.engine.process_price(price)
                self.last_error = ""
                for event in events:
                    if "ntfy" in event["channels"]:
                        self._deliver(event, "ntfy", self.sender.send_ntfy)
                for event in self.engine.phone_events_due():
                    self._deliver(event, "phone", self.sender.send_phone)
            except Exception as exc:  # The next poll must still run after a transient network error.
                self.last_error = str(exc)
            self.stop_event.wait(self.config.poll_seconds)

    def health(self) -> dict:
        snapshot = self.engine.snapshot()
        return {
            "ok": not self.last_error,
            "service": "hype-price-alert",
            "started_at": self.started_at,
            "latest_price": snapshot.get("latest_price"),
            "latest_price_at": snapshot.get("latest_price_at"),
            "last_error": self.last_error,
            "last_delivery": json.loads(json.dumps(self.last_delivery)),
            "channels": {
                "ntfy": bool(self.config.ntfy_topic),
                "phone": bool(self.config.tencent_policy_id and self.config.tencent_secret_id),
            },
        }

    def _deliver(self, event: dict, channel: str, callback: Callable[[dict], None]) -> None:
        try:
            callback(event)
        except Exception as exc:
            self.engine.mark_delivery(event["id"], channel, "failed", str(exc))
            self.last_delivery[channel] = {"status": "failed", "detail": str(exc)[:300], "updated_at": utc_now_iso()}
        else:
            self.engine.mark_delivery(event["id"], channel, "sent")
            self.last_delivery[channel] = {"status": "sent", "detail": "", "updated_at": utc_now_iso()}

    def test_delivery(self, channel: str, event: dict) -> dict:
        callback = self.sender.send_ntfy if channel == "ntfy" else self.sender.send_phone if channel == "phone" else None
        if not callback:
            raise ValueError("channel must be ntfy or phone")
        try:
            callback(event)
        except Exception as exc:
            result = {"status": "failed", "detail": str(exc)[:300], "updated_at": utc_now_iso()}
            self.last_delivery[channel] = result
            raise
        result = {"status": "sent", "detail": "", "updated_at": utc_now_iso()}
        self.last_delivery[channel] = result
        return json.loads(json.dumps(result))


def make_handler(application: PriceAlertApplication) -> type[BaseHTTPRequestHandler]:
    class AlertApiHandler(BaseHTTPRequestHandler):
        server_version = "HypeLensAlert/1.0"

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors_headers()
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            if path == "/health":
                self._json(HTTPStatus.OK, application.health(), authenticated=False)
                return
            if not self._authorized():
                return
            if path == "/api/alerts":
                self._json(HTTPStatus.OK, {**application.health(), **application.engine.snapshot()})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/pair":
                if not self._pairing_authorized():
                    return
                session_token, expires_at = application.issue_session()
                cookie = (
                    f"{ALERT_SESSION_COOKIE}={session_token}; Path=/; Max-Age={application.config.session_seconds}; "
                    "HttpOnly; Secure; SameSite=Strict"
                )
                self._json(
                    HTTPStatus.OK,
                    {"ok": True, "paired_until": utc_now_iso(expires_at)},
                    authenticated=False,
                    extra_headers={"Set-Cookie": cookie},
                )
                return
            if path == "/api/logout":
                if not self._origin_authorized():
                    self._json(HTTPStatus.FORBIDDEN, {"error": "request origin is not allowed"}, authenticated=False)
                    return
                expired_cookie = f"{ALERT_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"
                self._json(
                    HTTPStatus.OK,
                    {"ok": True},
                    authenticated=False,
                    extra_headers={"Set-Cookie": expired_cookie},
                )
                return
            if not self._authorized():
                return
            try:
                payload = self._read_json()
                if path == "/api/rules":
                    self._json(HTTPStatus.CREATED, application.engine.add_rule(payload))
                    return
                if path == "/api/test":
                    channel = payload.get("channel")
                    event = {
                        "id": "test",
                        "rule_name": "手动测试",
                        "direction": "above",
                        "threshold": float(application.engine.snapshot().get("latest_price") or 0),
                        "trigger_price": float(application.engine.snapshot().get("latest_price") or 0),
                    }
                    delivery = application.test_delivery(channel, event)
                    self._json(HTTPStatus.OK, {"ok": True, "channel": channel, "delivery": delivery})
                    return
                parts = path.strip("/").split("/")
                if len(parts) == 4 and parts[:2] == ["api", "events"] and parts[3] == "ack":
                    self._json(HTTPStatus.OK, application.engine.acknowledge(parts[2]))
                    return
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            except KeyError:
                self._json(HTTPStatus.NOT_FOUND, {"error": "record not found"})
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            except Exception as exc:
                self._json(HTTPStatus.BAD_GATEWAY, {"error": str(exc)})

        def do_PATCH(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            parts = urllib.parse.urlparse(self.path).path.strip("/").split("/")
            if len(parts) != 3 or parts[:2] != ["api", "rules"]:
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            try:
                self._json(HTTPStatus.OK, application.engine.update_rule(parts[2], self._read_json()))
            except KeyError:
                self._json(HTTPStatus.NOT_FOUND, {"error": "rule not found"})
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})

        def do_DELETE(self) -> None:  # noqa: N802
            if not self._authorized():
                return
            parts = urllib.parse.urlparse(self.path).path.strip("/").split("/")
            if len(parts) != 3 or parts[:2] != ["api", "rules"]:
                self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            try:
                application.engine.delete_rule(parts[2])
            except KeyError:
                self._json(HTTPStatus.NOT_FOUND, {"error": "rule not found"})
            else:
                self._json(HTTPStatus.OK, {"ok": True})

        def _authorized(self) -> bool:
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {application.config.api_token}"
            if hmac.compare_digest(supplied, expected):
                return True
            cookie_header = self.headers.get("Cookie", "")
            if cookie_header:
                try:
                    cookies = SimpleCookie(cookie_header)
                    session_cookie = cookies.get(ALERT_SESSION_COOKIE)
                except Exception:
                    session_cookie = None
                if session_cookie and application.verify_session(session_cookie.value):
                    if self._origin_authorized():
                        return True
                    self._json(HTTPStatus.FORBIDDEN, {"error": "request origin is not allowed"}, authenticated=False)
                    return False
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "invalid alert API token"}, authenticated=False)
            return False

        def _pairing_authorized(self) -> bool:
            if not self._origin_authorized():
                self._json(HTTPStatus.FORBIDDEN, {"error": "request origin is not allowed"}, authenticated=False)
                return False
            supplied = self.headers.get("Authorization", "")
            expected = f"Bearer {application.config.api_token}"
            if hmac.compare_digest(supplied, expected):
                return True
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "invalid alert API token"}, authenticated=False)
            return False

        def _origin_authorized(self) -> bool:
            allowed = application.config.allowed_origin.rstrip("/")
            origin = self.headers.get("Origin", "").rstrip("/")
            return bool(origin and allowed != "*" and hmac.compare_digest(origin, allowed))

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 32_768:
                raise ValueError("request is too large")
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if not isinstance(payload, dict):
                raise ValueError("JSON object required")
            return payload

        def _cors_headers(self) -> None:
            origin = self.headers.get("Origin", "")
            allowed = application.config.allowed_origin
            if origin == allowed:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Credentials", "true")
            elif allowed == "*":
                self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")

        def _json(
            self,
            status: HTTPStatus,
            payload: object,
            authenticated: bool = True,
            extra_headers: dict[str, str] | None = None,
        ) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._cors_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            for name, value in (extra_headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, pattern: str, *args: object) -> None:
            print(f"{self.address_string()} - {pattern % args}")

    return AlertApiHandler


def main() -> int:
    config = ServiceConfig.from_env()
    application = PriceAlertApplication(config)
    monitor = threading.Thread(target=application.monitor_forever, name="price-monitor", daemon=True)
    monitor.start()
    server = ThreadingHTTPServer((config.bind_host, config.port), make_handler(application))

    def shutdown(_signum: int, _frame: object) -> None:
        application.stop_event.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    print(f"HYPE price alert service listening on {config.bind_host}:{config.port}")
    try:
        server.serve_forever()
    finally:
        application.stop_event.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
