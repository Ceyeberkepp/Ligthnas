#!/usr/bin/env bash
# Run on the Proxmox host: prepares one EXISTING LXC for Docker and installs LightNAS in it.
set -Eeuo pipefail
ctid="${1:-}"
if [[ ! -d /etc/pve ]] || ! command -v pct >/dev/null 2>&1; then
  echo 'This shell is inside an LXC or another non-Proxmox machine.' >&2
  echo 'Open the Proxmox node shell (root@YOUR-PVE-NODE), then run this script there with CTID 170.' >&2
  echo 'To update the LightNAS web service only from this LXC, run:' >&2
  echo '  curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/install.sh -o /root/lightnas-install.sh' >&2
  echo '  bash /root/lightnas-install.sh' >&2
  exit 1
fi
if [[ $EUID -ne 0 || ! $ctid =~ ^[1-9][0-9]{1,5}$ ]]; then
  echo 'Run on the Proxmox node as root: bash /root/lightnas-lxc-install.sh 170' >&2
  exit 1
fi
config="$(pct config "$ctid")" || exit 1
if [[ "$(pct status "$ctid")" != *'status: running'* ]]; then
  echo "Container $ctid must be running to install LightNAS. Start it and rerun." >&2
  exit 1
fi
features="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
for option in nesting keyctl; do
  if [[ $features =~ (^|,)${option}=[01](,|$) ]]; then
    features="$(sed -E "s/(^|,)${option}=[01]/\\1${option}=1/" <<<"$features")"
  else
    features="${features:+$features,}${option}=1"
  fi
done
current="$(sed -n 's/^features: //p' <<<"$config" | head -1)"
if [[ "$features" != "$current" ]]; then
  echo "Preparing LXC $ctid: features=$features"
  pct set "$ctid" -features "$features"
  echo "Shutting down LXC $ctid to apply feature changes..."
  pct shutdown "$ctid" --timeout 60
  pct start "$ctid"
fi
# The public cluster CA is safe to copy; HTTPS will still check the host name.
if [[ -r /etc/pve/pve-root-ca.pem ]]; then
  pct exec "$ctid" -- install -d -m 0755 /usr/local/share/ca-certificates
  pct push "$ctid" /etc/pve/pve-root-ca.pem /usr/local/share/ca-certificates/lightnas-pve.crt
  pct exec "$ctid" -- update-ca-certificates
fi
# pct exec runs the installer as root INSIDE the existing container.
pct exec "$ctid" -- bash -lc 'set -Eeuo pipefail; curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/install.sh -o /root/lightnas-install.sh; bash /root/lightnas-install.sh'
echo 'LightNAS installation finished. Review /var/lib/lightnas/runtime-status.txt inside the LXC.'
echo 'VM creation still needs KVM on a separate host; an LXC does not expose a local KVM runtime.'
