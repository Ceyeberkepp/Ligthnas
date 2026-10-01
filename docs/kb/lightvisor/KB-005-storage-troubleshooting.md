# KB-005 — Storage troubleshooting

## Storage pool missing

Start with host visibility:

```bash
lsblk -f
findmnt
df -h
```

For ZFS:

```bash
zpool list
zfs list
```

If the host operating system cannot see the disk, mount or pool, LightVisor cannot display or manage it.

## Storage visible on host but not UI

```bash
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

Then hard-refresh.

## Nested deployments

When LightVisor runs in a VM or container, storage must be exposed by the outer platform first. The management UI cannot bypass the isolation of the parent hypervisor.

## Before destructive storage work

Verify the selected device carefully:

```bash
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL,SERIAL
```

Do not wipe the device containing the LightVisor OS.
