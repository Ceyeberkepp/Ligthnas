# KB-005 — Windows VM is slow

## First check KVM

```bash
ls -l /dev/kvm
virsh dominfo <vm-name>
```

If LightNAS is nested and `/dev/kvm` is unavailable, QEMU may use software emulation. Windows will be much slower.

## Windows compatibility hardware

Windows installation may initially use SATA/AHCI storage and Intel E1000 networking so Setup can boot without VirtIO drivers.

These devices are compatible but slower than VirtIO.

## Install VirtIO drivers

Use the LightNAS **Attach VirtIO Drivers** action, then install the required storage/network drivers inside Windows.

Do not change the boot disk to VirtIO before Windows has the matching storage driver.

## After drivers are installed

The VM can be moved toward:

- VirtIO network
- VirtIO SCSI or VirtIO block storage

Change one component at a time and verify the guest boots after each change.

## noVNC is not the VM CPU

A fast noVNC connection does not make a TCG/software-emulated Windows VM fast. Hardware virtualization is the biggest factor.
