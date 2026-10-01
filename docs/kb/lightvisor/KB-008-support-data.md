# KB-008 — Collect LightVisor support data manually

Run the following as root and attach the output to a support issue. Review output before sharing it outside your organization.

```bash
echo "===== VERSION ====="
cd /opt/lightnas && git log -3 --oneline

echo "===== SERVICES ====="
systemctl --no-pager --full status lightnas lightnas-host-agent

echo "===== LIGHTNAS LOG ====="
journalctl -u lightnas -n 150 --no-pager

echo "===== HOST AGENT LOG ====="
journalctl -u lightnas-host-agent -n 150 --no-pager

echo "===== NETWORK ====="
ip -br addr
ip route

echo "===== STORAGE ====="
lsblk -f
df -h
findmnt

echo "===== VIRTUAL MACHINES ====="
virsh list --all 2>/dev/null || true

echo "===== VIRTUAL NETWORKS ====="
virsh net-list --all 2>/dev/null || true

echo "===== LXC ====="
lxc-ls --fancy 2>/dev/null || true
```

Do not include passwords, private keys, API tokens, or unrelated application secrets.

For a UI issue also include:

- screenshot
- browser/version
- selected sidebar item
- exact time of the problem
- whether a hard refresh changes the result
