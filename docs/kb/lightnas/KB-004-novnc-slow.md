# KB-004 — noVNC console is slow or does not open

## Symptom

The noVNC window takes too long to connect, stays on reconnecting, or opens to a blank screen.

## Verify the VM is running

```bash
virsh list --all
```

## Verify the VNC target

```bash
virsh vncdisplay <vm-name>
```

A normal result looks like `:0` or another display number.

## Check listening VNC sockets

```bash
ss -ltnp | grep 59
```

## Check the host agent

```bash
systemctl status lightnas-host-agent --no-pager
journalctl -u lightnas-host-agent -n 150 --no-pager
```

## How LightNAS reduces console delay

Current LightNAS keeps running VM VNC targets warm in memory, uses cached VNC target information, enables `TCP_NODELAY`, and retries quickly after QEMU recreates a VNC listener.

After a VM restart, the cache is invalidated automatically if the old port no longer answers.

## Important

If the guest itself is extremely slow because the appliance has no KVM acceleration, noVNC can connect quickly while the VM screen still updates slowly. Check `/dev/kvm` separately.
