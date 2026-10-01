# LightVisor Support Guide

This guide covers the dedicated **LightNAS Hypervisor edition**, presented in the UI as **LightVisor**. The Hypervisor edition is installed with `install-hypervisor.sh` and runs the same LightNAS control plane in dedicated hypervisor product mode.

> Scope note: this document describes current repository behavior. Features listed as planned in `HYPERVISOR-ARCHITECTURE.md` are not presented here as already implemented.

## 1. Product layout

LightVisor is a dedicated virtualization interface for the local host. It uses:

- KVM/QEMU + libvirt for virtual machines
- native LXC/liblxc for system containers
- local storage/datastore inventory
- virtual network inventory
- backups, monitoring, users/RBAC, settings, logs, shell and host controls

The installed product mode is set by:

```bash
LIGHTNAS_PRODUCT_MODE=hypervisor
```

The installer writes:

```text
/etc/lightnas/product-mode.env
/etc/systemd/system/lightnas.service.d/product-mode.conf
```

and restarts `lightnas.service`.

## 2. Resource tree

The left navigation is intentionally split into **inventory** and **operations**.

```text
Dashboard

RESOURCE TREE
└─ Local Datacenter
   ├─ LXC Containers
   │  └─ individual containers
   ├─ Nodes
   │  └─ local LightVisor host
   ├─ Virtual Machines
   │  └─ individual VMs
   ├─ SDN / Networks
   │  └─ virtual networks / bridges
   └─ Storage
      └─ configured storage pools

OPERATIONS
├─ Backups
├─ Monitoring
├─ Users & RBAC
└─ Settings
```

Groups use expandable `<details>` elements. Clicking an individual resource opens the matching management workspace. The inventory is populated from live runtime data; it is not mock inventory.

## 3. Dashboard

The dashboard summarizes:

- host health
- host count
- VM count and running state
- container count and running state
- storage usage
- active runtime errors
- CPU, memory, storage and guest utilization
- host inventory
- recent tasks/events
- virtual machines
- storage pools
- virtual networks
- quick actions

The dashboard uses live values from the LightNAS overview/runtime APIs. A new system should show zero-resource states instead of sample machines.

## 4. Virtual machines

Virtual machines are backed by QEMU/KVM and libvirt. Current UI functions include creation, lifecycle controls, edit, reset, delete, noVNC console, and VirtIO guest-driver handling.

Hardware virtualization requires `/dev/kvm`. If KVM is unavailable, the UI should report virtualization as unavailable rather than pretending VM creation succeeded.

Useful host checks:

```bash
ls -l /dev/kvm
systemctl status libvirtd --no-pager
virsh list --all
```

## 5. System containers

System Containers are native LXC containers, not Docker containers.

Useful host checks:

```bash
lxc-ls --fancy
systemctl status lightnas-host-agent --no-pager
```

Docker/OCI remains a separate application runtime used by the App Store in the NAS product. It is not the backend for LightVisor LXC inventory.

## 6. Storage

LightVisor displays configured storage pools and storage visible to the host. Storage capabilities depend on what the operating system can actually access.

The architecture supports or targets multiple providers, but availability is backend-dependent. Current UI includes local storage management and provider-specific workflows already implemented in the repository.

Useful checks:

```bash
lsblk -f
findmnt
df -h
zpool list 2>/dev/null || true
zfs list 2>/dev/null || true
```

## 7. Networking

LightVisor uses the host networking layer and virtualization network inventory. The repository includes bridge, bond, VLAN and route management as well as firewall controls.

Useful checks:

```bash
ip -br addr
ip route
bridge link
virsh net-list --all
nft list ruleset
```

## 8. Users, RBAC and access

LightNAS local users and permissions protect administrative operations. Users & RBAC remains under **Operations** because it controls access to resources rather than representing a resource itself.

Use a TLS reverse proxy for environments where credentials or sensitive management data cross untrusted networks. The project should not be exposed directly to the public Internet over plain HTTP.

## 9. Services

Primary services:

```bash
systemctl status lightnas --no-pager
systemctl status lightnas-host-agent --no-pager
```

Restart after updating:

```bash
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

View logs:

```bash
journalctl -u lightnas -n 200 --no-pager
journalctl -u lightnas-host-agent -n 200 --no-pager
```

## 10. Updating

For a Git checkout at the standard path:

```bash
cd /opt/lightnas
git pull
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

Then hard-refresh the browser.

## 11. Standard support triage

When a LightVisor problem is reported, collect these first:

```bash
cd /opt/lightnas
git log -3 --oneline

systemctl --no-pager --full status lightnas lightnas-host-agent

journalctl -u lightnas -n 100 --no-pager
journalctl -u lightnas-host-agent -n 100 --no-pager

ip -br addr
ip route
df -h

virsh list --all 2>/dev/null || true
virsh net-list --all 2>/dev/null || true
lxc-ls --fancy 2>/dev/null || true
```

For UI issues, also record:

- page name
- browser and version
- whether a hard refresh was performed
- exact resource selected in the tree
- screenshot
- browser console error if present

## 12. Support boundaries

Do not report planned cluster features as currently available unless the code and UI implement them. The architecture document includes future items such as live migration, HA, DRS-style scheduling, and broader identity/integration targets.

The support rule is: **describe the current runtime truth first; planned architecture second.**
