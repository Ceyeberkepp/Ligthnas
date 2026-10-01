# KB-002 — How LightNAS works

LightNAS has two main service layers.

## Web/API service

`lightnas.service` runs the Node.js control plane. It serves the browser interface and authenticated API.

## Privileged host agent

`lightnas-host-agent.service` performs controlled host operations through a local Unix socket.

It handles operations that require elevated privileges, including portions of:

- LXC lifecycle
- VM console bridging
- host networking
- firewall changes
- storage preparation

## Runtime separation

LightNAS uses different technologies for different workloads:

- **Apps:** Docker/OCI
- **System Containers:** native LXC/liblxc
- **Virtual Machines:** QEMU/KVM + libvirt

Docker applications are not the same thing as System Containers.

## Performance model

The UI is designed to render cached state first. Live runtime discovery updates the cache asynchronously.

This prevents a normal page click from waiting on every storage, Docker, LXC and libvirt command.

## Persistent data

Default persistent data lives under:

```text
/var/lib/lightnas
```

Application source normally lives under:

```text
/opt/lightnas
```
