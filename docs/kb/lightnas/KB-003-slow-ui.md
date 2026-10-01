# KB-003 — Pages take several seconds to open

## Symptom

A page or settings window takes roughly 5–15 seconds before it appears or becomes usable.

## Expected behavior

Navigation should feel immediate. Cached state should render first and live data should update afterward.

## Check the browser console

Open Developer Tools and look for:

```text
[LightNAS slow API]
```

The message includes the request path and elapsed time for requests slower than 1.2 seconds.

Record the full line.

## Check services

```bash
systemctl status lightnas lightnas-host-agent --no-pager
journalctl -u lightnas -n 100 --no-pager
journalctl -u lightnas-host-agent -n 100 --no-pager
```

## Check runtime commands

```bash
time virsh list --all
time docker ps -a
time lxc-ls --fancy
time lsblk
```

A slow host command can still make a background refresh slow even though the page should already be visible.

## Browser cache

After updating LightNAS, use:

```text
Ctrl+F5
```

## Report

Include the page name, delay, screenshot and the `[LightNAS slow API]` line.
