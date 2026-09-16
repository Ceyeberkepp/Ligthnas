#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY_URL="${LIGHTNAS_REPOSITORY_URL:-https://github.com/Ceyeberkepp/Ligthnas.git}"
INSTALL_DIRECTORY="${LIGHTNAS_INSTALL_DIRECTORY:-/opt/lightnas}"
DATA_DIRECTORY="${LIGHTNAS_DATA_DIRECTORY:-/var/lib/lightnas}"
SERVICE_NAME="lightnas"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root: curl ... | sudo bash" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer currently supports Debian and Ubuntu systems." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/6] Installing system requirements..."
apt-get update
apt-get install -y ca-certificates curl git gnupg python3 ffmpeg

if ! command -v node >/dev/null 2>&1 || \
   [[ "$(node --version | sed -E 's/^v([0-9]+).*/\1/')" -lt 22 ]]; then
  echo "[2/6] Installing Node.js 22..."
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  cat >/etc/apt/sources.list.d/nodesource.list <<'EOF'
deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main
EOF
  apt-get update
  apt-get install -y nodejs
else
  echo "[2/6] Node.js $(node --version) is already installed."
fi

echo "[3/6] Installing LightNAS..."
if [[ -d "${INSTALL_DIRECTORY}/.git" ]]; then
  git -C "${INSTALL_DIRECTORY}" pull --ff-only
elif [[ -e "${INSTALL_DIRECTORY}" ]]; then
  echo "Refusing to overwrite existing non-Git path: ${INSTALL_DIRECTORY}" >&2
  exit 1
else
  git clone --depth 1 "${REPOSITORY_URL}" "${INSTALL_DIRECTORY}"
fi

echo "[4/6] Creating the service account and persistent storage..."
if ! id lightnas >/dev/null 2>&1; then
  useradd --system --home-dir "${DATA_DIRECTORY}" --shell /usr/sbin/nologin lightnas
fi
install -d -o lightnas -g lightnas -m 0700 "${DATA_DIRECTORY}"
install -d -o lightnas -g lightnas -m 0700 "${DATA_DIRECTORY}/files"

# Explicit opt-in: access to the Docker socket grants effective root on this machine.
if [[ "${LIGHTNAS_ENABLE_DOCKER:-0}" == "1" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    apt-get install -y docker.io || echo "Docker package installation failed; LightNAS will continue without Docker." >&2
  fi
  if command -v docker >/dev/null 2>&1; then systemctl enable --now docker || true; fi
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    usermod -aG docker lightnas
    install -d -m 0755 /etc/lightnas
    touch /etc/lightnas/runtime.env
    chmod 0600 /etc/lightnas/runtime.env
    sed -i '/^LIGHTNAS_DOCKER_ENABLED=/d' /etc/lightnas/runtime.env
    printf '\nLIGHTNAS_DOCKER_ENABLED=1\n' >>/etc/lightnas/runtime.env
    echo "Docker is ready for LightNAS. The service account has Docker host privileges."
  else
    echo "Docker could not start here. For an LXC, configure nesting on the Proxmox host, then rerun the installer." >&2
  fi
fi
chown -R root:root "${INSTALL_DIRECTORY}"

echo "[5/6] Installing the systemd service..."
cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=LightNAS Management Control Plane
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=lightnas
Group=lightnas
WorkingDirectory=${INSTALL_DIRECTORY}
EnvironmentFile=-/etc/lightnas/runtime.env
Environment=NODE_ENV=production
Environment=NAS_HOST=0.0.0.0
Environment=NAS_PORT=3080
Environment=NAS_DATA_FILE=${DATA_DIRECTORY}/state.json
ExecStart=/usr/bin/node ${INSTALL_DIRECTORY}/src/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIRECTORY}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow 3080/tcp >/dev/null
fi

echo "[6/6] Verifying LightNAS..."
for attempt in {1..15}; do
  if curl -fsS http://127.0.0.1:3080/api/status >/dev/null 2>&1; then
    address="$(hostname -I 2>/dev/null | awk '{print $1}')"
    echo
    echo "LightNAS installation completed successfully."
    echo "Open: http://${address:-SERVER-IP}:3080"
    exit 0
  fi
  sleep 1
done

echo "LightNAS did not pass its health check." >&2
systemctl status "${SERVICE_NAME}" --no-pager --full >&2 || true
journalctl -u "${SERVICE_NAME}" -n 50 --no-pager >&2 || true
exit 1
