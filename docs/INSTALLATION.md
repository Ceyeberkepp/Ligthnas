# LightNAS Installation and Proxmox LXC Guide

This guide documents the supported LightNAS installation flow, including the
nested-Proxmox configuration used for native LXC system containers.

The intended user experience is:

1. Install LightNAS.
2. Create a system container from the LightNAS UI.
3. The container starts automatically.
4. The container receives a normal LAN DHCP address, such as `10.5.5.x`.
5. The container has a default route and Internet access.
6. A web application installed inside that container is reachable directly on
   the container IP and its normal application port.

There should be no per-container manual network repair, no manual rewrite of
`/var/lib/lxc/<name>/config`, and no requirement to place new containers on
the private `10.77.0.0/24` network when direct LAN networking is supported.

---

## 1. Supported installation targets

LightNAS supports these deployment styles:

- Bare metal Debian/Ubuntu.
- Debian/Ubuntu virtual machine.
- Proxmox LXC appliance with nested LightNAS system containers.

The main installer is:

```bash
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/install.sh | bash
```

The installer places the application under:

```text
/opt/lightnas
```

Persistent LightNAS state is kept under:

```text
/var/lib/lightnas
```

The management service listens on port `3080`.

---

## 2. What the main installer installs

The normal LightNAS installer installs all required system-container and
template dependencies automatically. Users should not have to add these
packages manually after installation.

Core packages include:

```text
ca-certificates
curl
git
gnupg
python3
ffmpeg
acl
novnc
iproute2
nftables
ufw
tar
gzip
xz-utils
zstd
lxc
lxc-templates
lxcfs
uidmap
bridge-utils
debootstrap
debian-archive-keyring
ubuntu-keyring
dnsmasq-base
network-manager
```

LightNAS also installs Node.js 22 when required.

On normal hosts, LightNAS installs QEMU/KVM and libvirt for virtual machines.
Inside a nested appliance, VM support depends on what the outer hypervisor
exposes.

---

## 3. Recommended Proxmox LXC deployment

When LightNAS itself runs inside Proxmox LXC, use the Proxmox helper from the
**Proxmox node shell**, not from inside the LightNAS container.

Example for LightNAS CTID `117`:

```bash
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/scripts/proxmox-lxc-install.sh \
  -o /root/lightnas-proxmox-install.sh

chmod +x /root/lightnas-proxmox-install.sh

bash /root/lightnas-proxmox-install.sh 117
```

Replace `117` with the actual LightNAS CTID.

The helper prepares the existing Proxmox LXC, installs LightNAS, and enables
the nested runtime capabilities required by LightNAS.

### Expected Proxmox features

The LightNAS outer LXC should have:

```text
nesting=1
keyctl=1
mknod=1
```

Typical configuration:

```text
features: nesting=1,keyctl=1,mknod=1
unprivileged: 1
```

The helper also passes these devices when they are available:

```text
/dev/kvm
/dev/net/tun
/dev/vhost-net
```

---

## 4. Existing LightNAS eth0 stays unchanged

LightNAS does not need a second management interface for this design.

If the outer Proxmox LXC already has a working interface such as:

```text
net0: name=eth0,bridge=vmbr0,firewall=0,gw=10.5.5.1,ip=10.5.5.206/24,type=veth
```

LightNAS keeps that management interface and IP.

For nested LightNAS system containers, LightNAS uses the existing `eth0` as
the parent for macvlan networking.

The expected LightNAS network state is:

```text
LIGHTNAS_NETWORK_MODE=nested-macvlan
LIGHTNAS_UPLINK=eth0
LIGHTNAS_CONTAINER_PARENT=eth0
```

Check it from the Proxmox host with:

```bash
pct exec 117 -- cat /etc/lightnas/network.env
```

---

## 5. Direct LAN networking for every new system container

When LightNAS is in `nested-macvlan` mode, the backend forces every newly
created LightNAS system container onto the direct LAN parent automatically.

The user does not need to select or repair this manually.

LightNAS automatically uses:

```text
network parent: eth0
IPv4 mode: DHCP
container interface type: macvlan
macvlan mode: bridge
```

A generated container configuration should contain:

```text
lxc.net.0.type = macvlan
lxc.net.0.link = eth0
lxc.net.0.macvlan.mode = bridge
lxc.net.0.flags = up
lxc.net.0.name = eth0
```

The container should then receive an address from the same upstream DHCP
network used by the LAN.

Example:

```text
LightNAS management IP: 10.5.5.206
IT container IP:        10.5.5.212
Gateway:                10.5.5.1
```

The application can then be reached directly, for example:

```text
http://10.5.5.212
https://10.5.5.212
http://10.5.5.212:8080
```

depending on the application.

---

## 6. Container creation validation

In direct-LAN mode, LightNAS does not report a new system container as fully
ready until it has had a chance to obtain:

- A non-`10.77.0.x` IPv4 address.
- An IPv4 default route.

This prevents the UI from claiming success while the container is still
isolated from the LAN.

After creation, LightNAS reports the assigned LAN IP in the UI.

---

## 7. Existing containers created on 10.77.0.x

Older LightNAS builds used a private network:

```text
10.77.0.0/24
```

with bridges such as:

```text
lightnas0
lxcbr0
```

On a supported nested Proxmox install, runtime provisioning migrates
LightNAS-managed containers from the old private network to the direct
`eth0` macvlan mode automatically.

Before migration:

```text
10.77.0.37
```

After migration:

```text
10.5.5.212
```

The private `10.77.0.0/24` network remains only as a compatibility fallback
for environments where direct nested macvlan networking is unavailable.

---

## 8. Imported GitHub/LXC templates

LightNAS supports imported system-container archives such as:

```text
.tar.zst
.tar.xz
.tar.gz
.tgz
```

The main installer installs the archive tools required to unpack these
formats.

### Device-node handling

Many LXC/TurnKey-style templates include entries such as:

```text
/dev/tty
/dev/null
/dev/zero
/dev/random
/dev/urandom
/dev/full
/dev/console
/dev/ptmx
```

An unprivileged outer Proxmox LXC is intentionally not allowed to recreate
those device nodes with `mknod`.

LightNAS handles this automatically.

During imported-template extraction, LightNAS excludes archived `/dev/*`
device entries and creates only the empty rootfs `/dev` directory. LXC
provides the runtime `/dev` mount and device nodes when the inner container
starts.

Therefore this old failure should no longer occur:

```text
tar: ./dev/tty: Cannot mknod: Operation not permitted
tar: ./dev/zero: Cannot mknod: Operation not permitted
tar: Exiting with failure status due to previous errors
```

Users should not need to modify the template or install extra packages to
work around this condition.

---

## 9. Verify a fresh Proxmox LightNAS installation

From the Proxmox node shell:

### Check the outer LightNAS CT

```bash
pct config 117
```

Confirm:

```text
features: nesting=1,keyctl=1,mknod=1
net0: name=eth0,...,bridge=vmbr0,...,firewall=0,...
```

### Check LightNAS network mode

```bash
pct exec 117 -- cat /etc/lightnas/network.env
```

Expected:

```text
LIGHTNAS_NETWORK_MODE=nested-macvlan
LIGHTNAS_UPLINK=eth0
LIGHTNAS_CONTAINER_PARENT=eth0
```

### Check LightNAS services

```bash
pct exec 117 -- systemctl status lightnas --no-pager --full
pct exec 117 -- systemctl status lightnas-host-agent --no-pager --full
```

### Check runtime status

```bash
pct exec 117 -- cat /var/lib/lightnas/runtime-status.txt
```

---

## 10. Verify a newly created LightNAS system container

For a container named `IT`:

### Check its LXC network configuration

```bash
pct exec 117 -- grep -E '^lxc\.net\.0\.(type|link|macvlan|hwaddr|flags|name)' \
  /var/lib/lxc/IT/config
```

Expected:

```text
lxc.net.0.type = macvlan
lxc.net.0.link = eth0
lxc.net.0.macvlan.mode = bridge
lxc.net.0.flags = up
lxc.net.0.name = eth0
```

### Check its assigned address

```bash
pct exec 117 -- lxc-info -n IT -iH
```

Expected:

```text
10.5.5.x
```

The exact address depends on the upstream DHCP server.

### Check the guest route

```bash
pct exec 117 -- lxc-attach -n IT -- ip -4 route
```

Expected pattern:

```text
default via 10.5.5.1 dev eth0
```

### Check Internet/DNS connectivity

```bash
pct exec 117 -- lxc-attach -n IT -- ping -c 3 10.5.5.1
pct exec 117 -- lxc-attach -n IT -- ping -c 3 1.1.1.1
pct exec 117 -- lxc-attach -n IT -- getent hosts github.com
```

---

## 11. Web application access

LightNAS system containers are full Linux environments. Applications use their
normal ports inside the container.

Examples:

```text
HTTP       http://10.5.5.212
HTTPS      https://10.5.5.212
Port 8080  http://10.5.5.212:8080
Port 8443  https://10.5.5.212:8443
```

To inspect listening ports for troubleshooting:

```bash
pct exec 117 -- lxc-attach -n IT -- ss -lntp
```

This should be a troubleshooting step only. Normal LightNAS installation and
container creation should not require terminal configuration.

---

## 12. Update an existing LightNAS installation

Inside the LightNAS appliance:

```bash
cd /opt/lightnas
git pull origin main
bash install.sh
```

For a LightNAS appliance running inside Proxmox LXC, rerunning the Proxmox
helper from the Proxmox host also refreshes the required outer-container
capabilities:

```bash
bash /root/lightnas-proxmox-install.sh 117
```

Use the correct CTID for that installation.

Persistent LightNAS state under `/var/lib/lightnas` is preserved.

---

## 13. Troubleshooting

### Container receives 10.77.0.x

Check:

```bash
pct exec 117 -- cat /etc/lightnas/network.env
```

If the result says:

```text
LIGHTNAS_NETWORK_MODE=lxc-nat
```

LightNAS could not enable direct nested macvlan and fell back to the managed
private network.

For the standard Proxmox LXC design described above, the desired result is:

```text
LIGHTNAS_NETWORK_MODE=nested-macvlan
```

### Container has no IPv4 address

Check:

```bash
pct exec 117 -- lxc-info -n IT -iH
pct exec 117 -- lxc-attach -n IT -- networkctl status eth0 --no-pager
pct exec 117 -- lxc-attach -n IT -- journalctl -u systemd-networkd -n 100 --no-pager
```

Then verify DHCP is available on the Proxmox bridge/LAN.

### Template extraction reports mknod errors

Update to the current `main` branch. Current LightNAS skips archived
`/dev/*` entries when importing LXC templates.

### LightNAS itself is reachable but inner containers are not

Verify the outer CT's existing network remains attached to the expected
Proxmox bridge:

```bash
pct config 117
```

Typical example:

```text
net0: name=eth0,bridge=vmbr0,firewall=0,gw=10.5.5.1,ip=10.5.5.206/24,type=veth
```

The LightNAS management IP should remain unchanged.

---

## 14. Design rule

The supported design principle is:

> Install LightNAS once. Container runtime, networking, template extraction,
> required packages, DHCP configuration, and direct-LAN behavior should be
> prepared by LightNAS itself.

Users should not need to repair each LXC after creation.

For supported Proxmox nested installs, creating a LightNAS system container
should feel like creating a normal Proxmox LXC: create it, start it, receive a
LAN IP, and use the application.
