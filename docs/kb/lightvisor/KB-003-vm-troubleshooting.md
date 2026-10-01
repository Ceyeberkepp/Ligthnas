# KB-003 — VM troubleshooting

## VM runtime shows unavailable

Check hardware virtualization:

```bash
ls -l /dev/kvm
grep -Ewo 'vmx|svm' /proc/cpuinfo | head
```

Check libvirt:

```bash
systemctl status libvirtd --no-pager
virsh list --all
```

If LightVisor itself is nested inside another hypervisor, the outer platform must expose nested virtualization and `/dev/kvm`.

## VM exists in libvirt but not LightVisor

```bash
virsh list --all
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

Then hard-refresh the browser.

## VM will not start

Inspect libvirt:

```bash
virsh dominfo VM_NAME
journalctl -u libvirtd -n 100 --no-pager
```

Common causes include unavailable storage, missing ISO/disk paths, network references, KVM access, or nested virtualization restrictions.

## Windows guest performance

LightVisor includes a workflow for VirtIO Windows guest drivers. Linux guests normally use VirtIO drivers already present in the kernel.
