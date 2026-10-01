# KB-007 — App Store shows zero apps or needs Refresh

## Expected behavior

The built-in App Store catalog should appear without requiring a manual Refresh. The community catalog is warmed in the background.

## Check Docker

```bash
systemctl status docker --no-pager
docker info
```

## Check LightNAS

```bash
systemctl status lightnas --no-pager
journalctl -u lightnas -n 120 --no-pager
```

## Test the built-in catalog API

While authenticated in the UI, the browser requests:

```text
/api/catalog/builtin
```

The server also prewarms the community catalog shortly after startup.

## After an update

```bash
systemctl restart lightnas
```

Then use `Ctrl+F5`.

## Network dependency

Community catalog refreshes can require working DNS and Internet access. Built-in catalog data should not depend on a live community refresh.
