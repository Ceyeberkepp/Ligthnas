# KB-004 — LXC container troubleshooting

LightVisor system containers use native LXC/liblxc.

## Inventory

```bash
lxc-ls --fancy
```

## Container does not appear in the UI

```bash
systemctl status lightnas-host-agent --no-pager
journalctl -u lightnas-host-agent -n 100 --no-pager
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

## Container has no IP

Check:

```bash
lxc-info -n CONTAINER_NAME
ip -br addr
ip route
bridge link
```

If LightVisor is itself nested, confirm the parent platform permits the required networking and namespaces.

## Important distinction

LXC system containers are different from Docker/OCI App Store containers. Do not troubleshoot the LXC inventory with Docker commands.
