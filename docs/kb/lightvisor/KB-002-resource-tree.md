# KB-002 — Understand the LightVisor resource tree

The LightVisor left sidebar is an inventory tree, not a flat menu.

## Structure

```text
Local Datacenter
├─ LXC Containers
├─ Nodes
├─ Virtual Machines
├─ SDN / Networks
└─ Storage
```

Each category is expandable. Individual VMs, containers, networks and storage pools are generated from live runtime inventory.

**Operations** are intentionally separate:

- Backups
- Monitoring
- Users & RBAC
- Settings

## Why a resource might not appear

A resource only appears when the backend inventory reports it.

Check VMs:

```bash
virsh list --all
```

Check libvirt networks:

```bash
virsh net-list --all
```

Check LXC:

```bash
lxc-ls --fancy
```

Check storage:

```bash
lsblk -f
findmnt
df -h
```

If the CLI sees the resource but the UI does not, restart the services and hard-refresh the browser. If the problem remains, collect the data in KB-008.
