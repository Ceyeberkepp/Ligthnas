# LightNAS Optional Integrations

LightNAS is a standalone NAS and infrastructure operating environment. The
integrations in this document are optional and are not required for normal
LightNAS installation or operation.

## Proxmox deployment integration

Proxmox is supported only as an optional external deployment environment for
users who choose to run a LightNAS instance there.

When LightNAS itself runs inside a Proxmox LXC and nested capabilities are
needed, use the helper from the Proxmox node shell:

```bash
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/scripts/proxmox-lxc-install.sh \
  -o /root/lightnas-proxmox-install.sh
chmod +x /root/lightnas-proxmox-install.sh
bash /root/lightnas-proxmox-install.sh <CTID>
```

The helper prepares the outer Proxmox container for the LightNAS instance. It
does not make Proxmox a LightNAS dependency, backend, brand, or control plane.

Normal LightNAS container and VM management continues to run through LightNAS'
own local LXC and QEMU/KVM/libvirt engines.

Additional platform integrations may be documented here as they are added.
