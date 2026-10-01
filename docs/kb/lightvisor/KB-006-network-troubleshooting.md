# KB-006 — Network troubleshooting

## Basic host state

```bash
ip -br addr
ip route
ip neigh
```

## Virtual networks

```bash
virsh net-list --all
bridge link
```

## Firewall

```bash
nft list ruleset
```

## Guest has no connectivity

Check, in order:

1. guest NIC is attached to the intended virtual network
2. virtual network/bridge is active
3. host route exists
4. DHCP or static addressing is correct
5. firewall permits the traffic
6. upstream switch/VLAN configuration matches

For Wi-Fi host uplinks, transparent Ethernet bridging may not be supported by station mode. Routed/NAT guest networking is usually the safer design.

## UI network inventory differs from CLI

Restart:

```bash
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

Then hard-refresh.
