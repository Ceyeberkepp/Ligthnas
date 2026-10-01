# KB-008 — LXC container has no network or wrong IP

## Check the LightNAS host

```bash
ip -br addr
ip route
cat /etc/resolv.conf
```

## Check the container

```bash
lxc-ls --fancy
lxc-info -n <container> -iH
```

## Nested LXC

When LightNAS itself runs inside another LXC, the outer platform determines whether nested veth, macvlan, ipvlan, bridge and DHCP traffic can work.

Use the Proxmox LXC preparation helper when running under Proxmox.

## DNS test inside a container

```bash
lxc-attach -n <container> -- getent hosts github.com
```

## Routing test

```bash
lxc-attach -n <container> -- ip -br addr
lxc-attach -n <container> -- ip route
lxc-attach -n <container> -- ping -c 3 1.1.1.1
```

If ping by IP works but DNS does not, troubleshoot DNS rather than rebuilding the container.
