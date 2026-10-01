# KB-012 — Collect a LightNAS support bundle

Run the following and save the output when opening a support issue.

```bash
echo "=== VERSION ==="
cd /opt/lightnas
git log -5 --oneline
git status --short

echo "=== SERVICES ==="
systemctl --no-pager --full status lightnas lightnas-host-agent

echo "=== LIGHTNAS LOG ==="
journalctl -u lightnas -n 150 --no-pager

echo "=== HOST AGENT LOG ==="
journalctl -u lightnas-host-agent -n 150 --no-pager

echo "=== NETWORK ==="
ip -br addr
ip route

echo "=== STORAGE ==="
df -h
findmnt
lsblk -f

echo "=== VMS ==="
virsh list --all 2>/dev/null || true
virsh net-list --all 2>/dev/null || true

echo "=== CONTAINERS ==="
lxc-ls --fancy 2>/dev/null || true

echo "=== APPS ==="
docker ps -a 2>/dev/null || true
```

For a UI problem also include:

- screenshot
- page name
- exact action clicked
- approximate wait time
- browser/version
- browser-console errors
- any `[LightNAS slow API]` message

Before sharing logs publicly, review them for usernames, internal hostnames, IP addresses, tokens or other sensitive information.
