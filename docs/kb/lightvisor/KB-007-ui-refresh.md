# KB-007 — LightVisor UI or dashboard is stale

Use this when the server was updated but the browser still shows the old sidebar or dashboard.

## Confirm the server has the new commit

```bash
cd /opt/lightnas
git log -3 --oneline
git status --short
```

## Restart the control plane

```bash
systemctl restart lightnas
systemctl status lightnas --no-pager
```

If runtime inventory is also stale:

```bash
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

## Browser refresh

Use a hard refresh:

```text
Ctrl + Shift + R
```

If needed, open a private/incognito window to eliminate browser cache as the cause.

## Check server response

Replace the port if your deployment differs:

```bash
curl -I http://127.0.0.1:3080/
```

## Check logs

```bash
journalctl -u lightnas -n 100 --no-pager
```
