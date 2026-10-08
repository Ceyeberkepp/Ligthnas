#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIRECTORY="${LIGHTNAS_INSTALL_DIRECTORY:-/opt/lightnas}"
CONFIG_FILE="${LIGHTNAS_SMS_GATEWAY_CONFIG:-/etc/lightnas/sms-gateway.env}"
SERVICE_NAME="lightnas-sms-gateway"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

if [[ ! -f "${INSTALL_DIRECTORY}/services/sms-gateway/server.mjs" ]]; then
  echo "LightNAS SMS gateway source was not found at ${INSTALL_DIRECTORY}/services/sms-gateway/server.mjs" >&2
  exit 1
fi

if ! id lightnas-sms >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/lightnas-sms --create-home --shell /usr/sbin/nologin lightnas-sms
fi

install -d -o root -g lightnas-sms -m 0750 /etc/lightnas

if [[ ! -e "${CONFIG_FILE}" ]]; then
  cat >"${CONFIG_FILE}" <<'EOF'
# LightNAS centralized SMS gateway
LIGHTNAS_SMS_BIND=0.0.0.0
LIGHTNAS_SMS_PORT=3091

# Comma-separated high-entropy appliance tokens.
LIGHTNAS_SMS_APPLIANCE_TOKENS=

# Delivery backend: modemmanager or webhook
LIGHTNAS_SMS_PROVIDER=

# For a self-hosted central GSM/LTE modem:
LIGHTNAS_SMS_MODEM=

# For a carrier/private delivery gateway:
LIGHTNAS_SMS_PROVIDER_URL=
LIGHTNAS_SMS_PROVIDER_TOKEN=

# Abuse controls
LIGHTNAS_SMS_RATE_WINDOW_MS=60000
LIGHTNAS_SMS_RATE_PER_TOKEN=20
LIGHTNAS_SMS_RATE_PER_DESTINATION=5
EOF
fi

chown root:lightnas-sms "${CONFIG_FILE}"
chmod 0640 "${CONFIG_FILE}"

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=LightNAS Central SMS Gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=lightnas-sms
Group=lightnas-sms
WorkingDirectory=${INSTALL_DIRECTORY}
EnvironmentFile=${CONFIG_FILE}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ${INSTALL_DIRECTORY}/services/sms-gateway/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

provider="$(awk -F= '/^LIGHTNAS_SMS_PROVIDER=/{print $2}' "${CONFIG_FILE}" | tail -1 | tr -d '[:space:]')"
if [[ "${provider}" == "modemmanager" ]]; then
  if ! command -v mmcli >/dev/null 2>&1; then
    apt-get update
    apt-get install -y --no-install-recommends modemmanager
  fi
  systemctl enable --now ModemManager
fi

systemctl restart "${SERVICE_NAME}"

echo
echo "LightNAS SMS gateway installed."
echo "Configure: ${CONFIG_FILE}"
echo "Health: curl http://127.0.0.1:3091/health"
