# KB-011 — File uploads or Files & Media are slow

## Check storage

```bash
df -h /var/lib/lightnas
findmnt /var/lib/lightnas
```

Slow underlying storage will directly affect uploads and thumbnail generation.

## Check network

From another system, verify latency and link speed to the LightNAS host.

On LightNAS:

```bash
ip -br link
ip -s link
```

## Check CPU and memory

```bash
uptime
free -h
top
```

Media conversion and thumbnail generation can consume CPU.

## Browser

Use a modern browser and hard-refresh after upgrades.

If the page itself is slow before an upload starts, check Developer Tools for:

```text
[LightNAS slow API]
```

## Large media

Uploading a file and transcoding a file are separate operations. FFmpeg conversion can take substantially longer than the upload.
