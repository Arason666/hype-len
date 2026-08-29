#!/usr/bin/env bash
set -euo pipefail

ALERT_HOST="${ALERT_HOST:?ALERT_HOST is required}"
STAGED_SERVICE="/tmp/hype-lens-alert.service"
STAGED_APP="/tmp/price_alert_service.py"
STAGED_ENV="/tmp/hype-lens-alert.env"

for staged_file in "$STAGED_SERVICE" "$STAGED_APP" "$STAGED_ENV"; do
  if [[ ! -s "$staged_file" ]]; then
    echo "Missing staged deployment file: $staged_file" >&2
    exit 1
  fi
done

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends caddy ca-certificates python3

if ! id hype-alert >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/hype-lens --shell /usr/sbin/nologin hype-alert
fi

install -d -m 0755 /opt/hype-lens
install -d -m 0750 -o hype-alert -g hype-alert /var/lib/hype-lens
install -d -m 0750 /etc/hype-lens
install -m 0755 "$STAGED_APP" /opt/hype-lens/price_alert_service.py
install -m 0600 "$STAGED_ENV" /etc/hype-lens/alert.env
install -m 0644 "$STAGED_SERVICE" /etc/systemd/system/hype-lens-alert.service

cat >/etc/caddy/Caddyfile <<CADDY
${ALERT_HOST} {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
    }
}
CADDY

caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now hype-lens-alert.service
systemctl enable --now caddy.service
systemctl restart hype-lens-alert.service
systemctl reload caddy.service

for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1:8787/health >/dev/null; then
    break
  fi
  if [[ "$attempt" == "20" ]]; then
    journalctl -u hype-lens-alert.service --no-pager -n 60
    exit 1
  fi
  sleep 1
done

systemctl --no-pager --full status hype-lens-alert.service | sed -n '1,12p'
