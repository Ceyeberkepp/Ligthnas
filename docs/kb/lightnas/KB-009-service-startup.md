# KB-009 — LightNAS service will not start

## Check status

```bash
systemctl --no-pager --full status lightnas lightnas-host-agent
```

## Read logs

```bash
journalctl -u lightnas -n 200 --no-pager
journalctl -u lightnas-host-agent -n 200 --no-pager
```

## Confirm code and dependencies

```bash
cd /opt/lightnas
git status
git log -3 --oneline
node --version
npm --version
```

## Reinstall application dependencies

```bash
cd /opt/lightnas
npm install --omit=dev --no-audit --no-fund
systemctl restart lightnas-host-agent lightnas
```

## Confirm the local API

```bash
curl -v http://127.0.0.1:3080/api/status
```

If the TCP connection is refused, focus on `lightnas.service`. If the web service runs but privileged actions fail, focus on `lightnas-host-agent.service`.
