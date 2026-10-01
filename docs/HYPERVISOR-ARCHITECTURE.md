# LightNAS Hypervisor Architecture

This document describes the dedicated **LightNAS Hypervisor edition**. It is separate from the LightNAS NAS product and must not change NAS-only navigation, workflows, or storage/file-management UX.

## Product goals

LightNAS Hypervisor combines a simple web-first operating model with enterprise virtualization capabilities:

- KVM/QEMU virtual machines
- LXC/system containers
- Datacenter, cluster, host, VM, container, storage, and network inventory
- Live migration and high availability
- Resource scheduling and placement
- Snapshots, cloning, backup, restore, and replication
- ZFS, Ceph, directory, NFS, SMB/CIFS, iSCSI, LVM/LVM-thin and shared storage
- Linux bridge and Open vSwitch networking
- VLAN/VXLAN-ready software-defined networking
- Firewall and security groups
- Local users plus LDAP/Active Directory/OIDC/SAML integration
- RBAC and audit logging
- REST/API automation and future Terraform/Ansible integrations
- Monitoring, alerting, capacity, and event history

## Layered architecture

### 1. Clients and interfaces

- Web console
- REST/API
- CLI
- Mobile-responsive web UI
- Plugin/integration framework

### 2. Management layer

Provides the datacenter object model and administrative control plane:

- Datacenters
- Clusters
- Hosts
- Resource inventory
- VM/container lifecycle
- Templates
- Tasks/events
- Scheduling
- Policy
- RBAC
- Audit

The web UI talks to the management API rather than directly manipulating hypervisor processes.

### 3. Compute layer

Primary virtualization runtime:

- KVM/QEMU
- libvirt
- LXC/system containers
- CPU and NUMA topology
- Memory ballooning/limits
- PCI/GPU passthrough
- VirtIO devices
- Cloud-init
- Guest agent integration
- VM console using SPICE/VNC/noVNC

Planned cluster services:

- Live migration
- HA restart/failover
- DRS-style placement
- Maintenance mode evacuation
- Affinity/anti-affinity policies

### 4. Storage layer

Storage is exposed to workloads through a common datastore abstraction.

Supported/target providers:

- Directory
- LVM
- LVM-thin
- ZFS
- Ceph RBD/CephFS
- NFS
- SMB/CIFS
- iSCSI
- ZFS over iSCSI

Services:

- Thin provisioning
- Snapshots
- Linked/full clones
- Replication
- Backup/restore
- Deduplication/compression when supported by the backend
- Storage policies and workload placement

### 5. Networking layer

- Linux bridge
- Open vSwitch
- Bonds/LACP
- VLAN
- VXLAN
- MTU configuration
- IPv4/IPv6
- Routing
- Network ACL/firewall
- Security groups
- NAT where explicitly configured
- Future EVPN/BGP support

Every workload network should be represented as a first-class object that can be assigned to VMs and containers.

### 6. Security and identity

- Local accounts
- LDAP / Active Directory
- OIDC
- SAML
- RBAC
- MFA
- API tokens
- Audit events
- Encryption in transit
- Secret separation
- Least-privilege service accounts

### 7. Automation and operations

- Task/event bus
- Background jobs
- Policy engine
- Scheduled jobs
- Backup schedules
- Lifecycle automation
- REST API
- Webhooks
- Future Terraform and Ansible providers
- Monitoring/exporters
- Alert rules

### 8. Host operating system

Debian-based hardened Linux host with:

- KVM
- QEMU
- libvirt
- LXC
- ZFS/Ceph client tooling as required
- Open vSwitch and Linux networking
- systemd
- nftables/firewall services
- hardware discovery
- storage discovery

The hypervisor installer owns these dependencies. The NAS edition must not be required for a hypervisor deployment.

## UI information architecture

The dedicated Hypervisor edition uses:

1. Dashboard
2. Datacenter
3. Clusters
4. Hosts
5. Virtual Machines
6. Containers
7. Storage
8. Networking
9. Backups
10. Templates
11. Monitoring
12. Automation
13. Users & RBAC
14. Settings

The dashboard only displays real runtime inventory. Empty systems show zero/empty states instead of demo objects.

## Compatibility strategy

Compatibility features may import or integrate with external platforms, but they are not the identity of LightNAS Hypervisor.

Planned integration boundaries:

- VMware/vSphere import workflows
- Proxmox migration/import and backup interoperability where technically appropriate
- oVirt/RHV import workflows
- Kubernetes/KubeVirt integration
- Backup platforms through supported APIs

External product names should appear only where an actual compatibility workflow exists.

## Product-mode isolation

The repository currently supports a dedicated hypervisor product mode through:

```bash
LIGHTNAS_PRODUCT_MODE=hypervisor
```

`install-hypervisor.sh` installs the dedicated appliance mode.

Hypervisor-only UI belongs in:

- `public/hypervisor.css`
- Hypervisor-specific render functions in `public/app.js`
- Hypervisor-specific backend modules/routes as the control plane evolves

Changes to the hypervisor edition must not alter NAS-only behavior unless a change is deliberately shared and tested for both products.
