# KB-001 — Install or update LightNAS in an LXC

## Applies to

LightNAS NAS edition running inside an LXC, including Proxmox LXC.

## Update an existing LightNAS checkout

Inside the LightNAS LXC:

```bash
cd /opt/lightnas
git checkout main
git pull origin main
npm install --omit=dev --no-audit --no-fund
systemctl restart lightnas-host-agent lightnas
```

Verify:

```bash
systemctl is-active lightnas-host-agent
systemctl is-active lightnas
curl -fsS http://127.0.0.1:3080/api/status
```

Both services should report `active`.

Hard-refresh the browser with `Ctrl+F5`.

## Test a development branch

```bash
cd /opt/lightnas
git fetch origin
git checkout <branch-name>
git pull origin <branch-name>
npm install --omit=dev --no-audit --no-fund
systemctl restart lightnas-host-agent lightnas
```

## Proxmox host helper

When preparing a new Proxmox LXC, run the repository's Proxmox LXC helper from the **Proxmox host** because the host controls container features and device passthrough.

The helper can prepare nesting and expose KVM/TUN/vhost devices when the host supports them.

## Important

Updating `/opt/lightnas` does not normally delete persistent data under `/var/lib/lightnas`. Always maintain a separate backup before major upgrades.
