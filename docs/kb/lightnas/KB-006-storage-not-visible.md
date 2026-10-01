# KB-006 — No disks or ZFS pools are visible

## Common cause

LightNAS is running inside an LXC or VM and the outer host has not exposed physical block devices.

This is not automatically a LightNAS storage failure.

## Check what Linux can see

```bash
lsblk -f
findmnt
df -h
```

If Linux cannot see a disk, LightNAS cannot manage it.

## LXC

For an LXC installation, storage is commonly presented as:

- the LXC root filesystem
- a bind mount
- a mounted filesystem
- a passed-through block device

The outer host controls what is visible.

## ZFS

```bash
zpool list
zfs list
```

If those commands are unavailable or permission is denied, LightNAS cannot present live ZFS management.

## Storage spaces

LightNAS storage spaces are file-backed directories. They do not create a new physical RAID or ZFS pool by themselves.
