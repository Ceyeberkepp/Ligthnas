#!/usr/bin/env python3
"""Narrow LightNAS bridge for a Proxmox VE host.

The service listens only on a local Unix-domain socket. LightNAS LXCs receive that
socket through a Proxmox bind mount and authenticate with a per-container secret.
The bridge exposes explicit inventory and lifecycle operations only; it never
accepts arbitrary host commands.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import socketserver
import subprocess
import threading
from pathlib import Path

SOCKET_PATH = Path(os.environ.get("LIGHTNAS_PVE_AGENT_SOCKET", "/var/lib/lightnas-pve/agent.sock"))
CLIENT_DIR = Path(os.environ.get("LIGHTNAS_PVE_CLIENT_DIR", "/etc/lightnas-pve/clients"))
MAX_REQUEST = 64 * 1024
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]{1,39}$")
POOL_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
NETWORK_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
CLIENT_RE = re.compile(r"^[1-9][0-9]{1,5}$")
DISK_RE = re.compile(r"^/dev/[A-Za-z0-9._+:-]{1,128}$")
PVE_CONTENT = {"images", "rootdir", "iso", "vztmpl", "backup", "snippets", "import"}


def run(args: list[str], timeout: int = 30) -> str:
    result = subprocess.run(args, check=True, text=True, capture_output=True, timeout=timeout)
    return result.stdout.strip()


def optional_run(args: list[str], timeout: int = 15, fallback: str = "") -> str:
    try:
        return run(args, timeout=timeout)
    except Exception:
        return fallback


def json_command(args: list[str], fallback):
    try:
        return json.loads(run(args, timeout=20) or "null")
    except Exception:
        return fallback


def pvesh(path: str, *args: str):
    output = run(["pvesh", "get", path, *args, "--output-format", "json"])
    return json.loads(output or "null")


def pvesh_set(path: str, *args: str):
    return run(["pvesh", "set", path, *args], timeout=60)


def node_name() -> str:
    name = run(["hostname", "-s"])
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name):
        raise RuntimeError("Proxmox node name is invalid")
    return name


def node_address() -> str | None:
    addresses = optional_run(["hostname", "-I"]).split()
    return next((item for item in addresses if ":" not in item and not item.startswith("127.")), addresses[0] if addresses else None)


def authenticate(request: dict) -> str:
    client = str(request.get("client", ""))
    supplied = str(request.get("secret", ""))
    if not CLIENT_RE.fullmatch(client) or not supplied:
        raise PermissionError("missing client authentication")
    secret_file = CLIENT_DIR / f"{client}.secret"
    try:
        expected = secret_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise PermissionError("unknown LightNAS client") from exc
    if not hmac.compare_digest(supplied, expected):
        raise PermissionError("invalid LightNAS client secret")
    run(["pct", "config", client], timeout=10)
    return client


def descendants(device: dict) -> list[dict]:
    result = [device]
    for child in device.get("children") or []:
        result.extend(descendants(child))
    return result


def mount_points(device: dict) -> list[str]:
    result: list[str] = []
    for item in descendants(device):
        values = item.get("mountpoints")
        if not isinstance(values, list):
            values = [item.get("mountpoint")] if item.get("mountpoint") else []
        result.extend(str(value) for value in values if value)
    return sorted(set(result))


def host_inventory(node: str) -> dict:
    status = pvesh(f"/nodes/{node}/status") or {}
    lxc = pvesh(f"/nodes/{node}/lxc") or []
    node_storage = pvesh(f"/nodes/{node}/storage") or []
    storage_config = pvesh("/storage") or []
    networks = pvesh(f"/nodes/{node}/network") or []

    block = json_command([
        "lsblk", "-J", "-b", "-o",
        "NAME,KNAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINTS,MODEL,SERIAL,TRAN,RO,RM"
    ], {"blockdevices": []})
    root_source = optional_run(["findmnt", "-n", "-o", "SOURCE", "/"])
    pvs = json_command(["pvs", "--reportformat", "json", "-o", "pv_name,vg_name"], {"report": []})
    pv_rows = []
    for report in pvs.get("report") or []:
        pv_rows.extend(report.get("pv") or [])
    zpool_status = optional_run(["zpool", "status", "-P"], fallback="")

    disks = []
    protected_mounts = {"/", "/boot", "/boot/efi"}
    for disk in block.get("blockdevices") or []:
        if disk.get("type") != "disk":
            continue
        items = descendants(disk)
        paths = {str(item.get("path")) for item in items if item.get("path")}
        mounts = mount_points(disk)
        os_protected = bool(protected_mounts.intersection(mounts)) or (root_source and root_source in paths)
        lvm_uses = sorted({
            str(row.get("vg_name")) for row in pv_rows
            if str(row.get("pv_name")) in paths and row.get("vg_name")
        })
        zfs_used = any(path and path in zpool_status for path in paths)
        reasons = []
        if mounts:
            reasons.append("mounted: " + ", ".join(mounts))
        if lvm_uses:
            reasons.append("LVM: " + ", ".join(lvm_uses))
        if zfs_used:
            reasons.append("member of a ZFS pool")
        if os_protected:
            reasons.insert(0, "contains the Proxmox operating system")
        read_only = bool(int(disk.get("ro") or 0))
        removable = bool(int(disk.get("rm") or 0))
        in_use = bool(reasons)
        path = str(disk.get("path") or "")
        disks.append({
            "name": str(disk.get("name") or ""),
            "path": path,
            "sizeBytes": int(disk.get("size") or 0),
            "model": str(disk.get("model") or "").strip() or None,
            "serial": str(disk.get("serial") or "").strip() or None,
            "transport": str(disk.get("tran") or "").strip() or None,
            "filesystem": str(disk.get("fstype") or "").strip() or None,
            "mountPoints": mounts,
            "readOnly": read_only,
            "removable": removable,
            "osProtected": os_protected,
            "inUse": in_use,
            "useReasons": reasons,
            "eligibleForClean": bool(path and DISK_RE.fullmatch(path) and not read_only and not in_use and not os_protected),
            "partitions": [
                {
                    "name": str(item.get("name") or ""),
                    "path": str(item.get("path") or ""),
                    "type": str(item.get("type") or ""),
                    "sizeBytes": int(item.get("size") or 0),
                    "filesystem": str(item.get("fstype") or "").strip() or None,
                    "mountPoints": [value for value in (item.get("mountpoints") or []) if value],
                }
                for item in items[1:]
            ],
        })

    status_by_name = {str(item.get("storage")): item for item in node_storage if item.get("storage")}
    storages = []
    for config in storage_config:
        name = str(config.get("storage") or "")
        if not POOL_RE.fullmatch(name):
            continue
        live = status_by_name.get(name, {})
        content = config.get("content") or live.get("content") or ""
        if isinstance(content, list):
            content_types = [str(value) for value in content]
        else:
            content_types = [value for value in str(content).split(",") if value]
        storages.append({
            "name": name,
            "type": str(config.get("type") or live.get("type") or "unknown"),
            "content": sorted(set(content_types)),
            "enabled": int(live.get("enabled", 1) or 0) != 0 and int(config.get("disable", 0) or 0) == 0,
            "active": int(live.get("active", 1) or 0) != 0,
            "shared": bool(int(config.get("shared", 0) or 0)),
            "totalBytes": int(live.get("total") or 0),
            "availableBytes": int(live.get("avail") or 0),
            "usedBytes": int(live.get("used") or 0),
            "path": config.get("path"),
            "pool": config.get("pool"),
            "vgname": config.get("vgname"),
            "thinpool": config.get("thinpool"),
        })

    zpool_rows = []
    raw_pools = optional_run(["zpool", "list", "-H", "-p", "-o", "name,size,alloc,free,health"])
    for row in raw_pools.splitlines():
        fields = row.split("\t")
        if len(fields) >= 5:
            zpool_rows.append({"name": fields[0], "sizeBytes": int(fields[1]), "allocatedBytes": int(fields[2]), "freeBytes": int(fields[3]), "health": fields[4]})
    dataset_rows = []
    raw_datasets = optional_run(["zfs", "list", "-H", "-p", "-o", "name,used,available,mountpoint,compression"])
    for row in raw_datasets.splitlines():
        fields = row.split("\t")
        if len(fields) >= 5:
            dataset_rows.append({"name": fields[0], "usedBytes": int(fields[1]), "availableBytes": int(fields[2]), "mountPoint": fields[3], "compression": fields[4]})

    memory = status.get("memory") or {}
    rootfs = status.get("rootfs") or {}
    cpu_value = float(status.get("cpu") or 0)
    host_status = {
        "uptimeSeconds": int(status.get("uptime") or 0),
        "cpuPercent": round(cpu_value * 100, 1),
        "cpuCount": int(status.get("cpuinfo", {}).get("cpus") or status.get("maxcpu") or 0),
        "memory": {
            "totalBytes": int(memory.get("total") or 0),
            "usedBytes": int(memory.get("used") or 0),
            "freeBytes": int(memory.get("free") or 0),
        },
        "rootfs": {
            "totalBytes": int(rootfs.get("total") or 0),
            "usedBytes": int(rootfs.get("used") or 0),
            "availableBytes": int(rootfs.get("avail") or 0),
        },
        "loadAverage": status.get("loadavg") or [],
    }

    wifi_devices = []
    iw = optional_run(["iw", "dev"])
    current = None
    for line in iw.splitlines():
        match = re.match(r"\s*Interface\s+(\S+)", line)
        if match:
            current = {"name": match.group(1)}
            wifi_devices.append(current)
        elif current:
            ssid = re.match(r"\s*ssid\s+(.+)", line)
            if ssid:
                current["ssid"] = ssid.group(1)

    return {
        "node": node,
        "address": node_address(),
        "status": host_status,
        "disks": disks,
        "storages": storages,
        "zfs": {"available": bool(zpool_rows or dataset_rows), "pools": zpool_rows, "datasets": dataset_rows},
        "networks": [
            {
                "name": str(item.get("iface") or ""),
                "type": str(item.get("type") or "unknown"),
                "active": int(item.get("active", 1) or 0) != 0,
                "address": item.get("address"),
                "cidr": item.get("cidr"),
                "gateway": item.get("gateway"),
                "bridgePorts": item.get("bridge_ports"),
                "comments": item.get("comments"),
            }
            for item in networks if NETWORK_RE.fullmatch(str(item.get("iface", "")))
        ],
        "wifi": wifi_devices,
        "containers": [
            {
                "vmid": int(item.get("vmid")),
                "name": str(item.get("name") or f"CT-{item.get('vmid')}"),
                "status": str(item.get("status") or "unknown"),
                "memory": int(item.get("maxmem") or 0),
                "disk": int(item.get("maxdisk") or 0),
                "cpus": int(item.get("cpus") or 0),
            }
            for item in lxc if str(item.get("vmid", "")).isdigit()
        ],
    }


def inventory() -> dict:
    node = node_name()
    machines = pvesh(f"/nodes/{node}/qemu") or []
    stores = pvesh(f"/nodes/{node}/storage", "--content", "images") or []
    bridges = pvesh(f"/nodes/{node}/network", "--type", "bridge") or []

    pool_details = []
    for item in stores:
        storage = str(item.get("storage", ""))
        if item.get("enabled", 1) == 0 or item.get("active", 1) == 0 or not POOL_RE.fullmatch(storage):
            continue
        pool_details.append({
            "name": storage,
            "type": str(item.get("type", "unknown")),
            "total": int(item.get("total") or 0),
            "available": int(item.get("avail") or 0),
        })
    pools = [item["name"] for item in pool_details]

    iso_stores = pvesh(f"/nodes/{node}/storage", "--content", "iso") or []
    images: list[str] = []
    for item in iso_stores[:20]:
        storage = str(item.get("storage", ""))
        if item.get("enabled", 1) == 0 or item.get("active", 1) == 0 or not POOL_RE.fullmatch(storage):
            continue
        content = pvesh(f"/nodes/{node}/storage/{storage}/content", "--content", "iso") or []
        images.extend(
            str(entry.get("volid")) for entry in content
            if entry.get("content") == "iso" and isinstance(entry.get("volid"), str) and str(entry.get("volid")).lower().endswith(".iso")
        )
    images = sorted(set(images))

    machine_details = [
        {
            "vmid": int(item.get("vmid")), "name": str(item.get("name") or f"VM-{item.get('vmid')}"),
            "status": str(item.get("status") or "unknown"), "memory": int(item.get("maxmem") or 0),
            "disk": int(item.get("maxdisk") or 0), "cpus": int(item.get("cpus") or 0),
        }
        for item in machines if str(item.get("vmid", "")).isdigit()
    ]
    address = node_address()
    return {
        "available": True,
        "enabled": True,
        "provider": "proxmox",
        "reason": None,
        "machines": [f"{item['name']} ({item['vmid']}) · {item['status']}" for item in machine_details],
        "machineDetails": machine_details,
        "pools": pools,
        "poolDetails": pool_details,
        "networks": [str(item.get("iface")) for item in bridges if item.get("active", 1) != 0 and NETWORK_RE.fullmatch(str(item.get("iface", "")))],
        "images": images,
        "node": node,
        "proxmoxUrl": f"https://{address}:8006/" if address else None,
        "transport": "host-bridge",
        "host": host_inventory(node),
    }


def create_vm(data: dict) -> dict:
    name = str(data.get("name", ""))
    pool = str(data.get("pool", ""))
    network = str(data.get("network", ""))
    iso = str(data.get("iso", ""))
    try:
        memory = int(data.get("memoryMiB"))
        cpus = int(data.get("cpus"))
        disk = int(data.get("diskGiB"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid VM resource values") from exc

    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid VM name")
    if not (1024 <= memory <= 65536 and 1 <= cpus <= 32 and 10 <= disk <= 2048):
        raise ValueError("VM resources are outside allowed limits")

    current = inventory()
    if pool not in current["pools"]:
        raise ValueError(f"VM storage '{pool}' is not currently available on Proxmox")
    if network not in current["networks"]:
        raise ValueError(f"network bridge '{network}' is not currently available on Proxmox")
    if iso not in current["images"] or not iso.lower().endswith(".iso"):
        raise ValueError("select an existing ISO image from Proxmox ISO storage")
    if any(machine.startswith(f"{name} (") for machine in current["machines"]):
        raise ValueError("a VM with this name already exists")

    vmid = int(pvesh("/cluster/nextid"))
    if vmid < 100:
        raise RuntimeError("Proxmox returned an invalid VM ID")

    created = False
    try:
        run(["qm", "create", str(vmid), "--name", name, "--memory", str(memory), "--cores", str(cpus), "--scsihw", "virtio-scsi-pci", "--net0", f"virtio,bridge={network}", "--ostype", "l26"], timeout=60)
        created = True
        run(["qm", "set", str(vmid), "--scsi0", f"{pool}:{disk}"], timeout=120)
        run(["qm", "set", str(vmid), "--ide2", f"{iso},media=cdrom"], timeout=60)
        run(["qm", "set", str(vmid), "--boot", "order=ide2;scsi0"], timeout=30)
    except Exception:
        if created:
            try:
                run(["qm", "destroy", str(vmid), "--purge", "1", "--destroy-unreferenced-disks", "1"], timeout=60)
            except Exception:
                pass
        raise

    try:
        run(["qm", "start", str(vmid)], timeout=60)
        detail = "VM created and started on the Proxmox host."
    except Exception as exc:
        detail = f"VM created, but automatic start failed: {str(exc)[:180]}"
    return {"name": name, "vmid": vmid, "details": detail}


def vm_action(data: dict) -> dict:
    try:
        vmid = int(data.get("vmid"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid VM ID") from exc
    action = str(data.get("action", ""))
    if vmid < 100 or vmid > 999999:
        raise ValueError("invalid VM ID")
    if action not in {"start", "stop", "shutdown", "reboot", "reset", "delete"}:
        raise ValueError("unsupported VM action")
    run(["qm", "config", str(vmid)], timeout=15)
    if action == "delete":
        try:
            run(["qm", "stop", str(vmid)], timeout=30)
        except Exception:
            pass
        run(["qm", "destroy", str(vmid), "--purge", "1", "--destroy-unreferenced-disks", "1"], timeout=120)
        return {"vmid": vmid, "action": action, "status": "deleted"}
    run(["qm", "reset" if action == "reset" else action, str(vmid)], timeout=60)
    return {"vmid": vmid, "action": action, "status": "submitted"}


def update_vm(data: dict) -> dict:
    try:
        vmid = int(data.get("vmid"))
        memory = int(data.get("memoryMiB"))
        cpus = int(data.get("cpus"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid VM update values") from exc
    name = str(data.get("name", ""))
    if vmid < 100 or vmid > 999999 or not NAME_RE.fullmatch(name):
        raise ValueError("invalid VM ID or name")
    if not (512 <= memory <= 262144 and 1 <= cpus <= 128):
        raise ValueError("VM resources are outside allowed limits")
    run(["qm", "config", str(vmid)], timeout=15)
    run(["qm", "set", str(vmid), "--name", name, "--memory", str(memory), "--cores", str(cpus)], timeout=60)
    return {"vmid": vmid, "name": name, "memoryMiB": memory, "cpus": cpus, "status": "updated"}



def container_inventory(client_id: str | None = None) -> dict:
    node = node_name()
    containers = pvesh(f"/nodes/{node}/lxc") or []
    root_stores = pvesh(f"/nodes/{node}/storage", "--content", "rootdir") or []
    template_stores = pvesh(f"/nodes/{node}/storage", "--content", "vztmpl") or []
    bridges = pvesh(f"/nodes/{node}/network", "--type", "bridge") or []

    pools = []
    for item in root_stores:
        storage = str(item.get("storage", ""))
        if item.get("enabled", 1) == 0 or item.get("active", 1) == 0 or not POOL_RE.fullmatch(storage):
            continue
        pools.append({
            "name": storage,
            "type": str(item.get("type") or "unknown"),
            "total": int(item.get("total") or 0),
            "available": int(item.get("avail") or 0),
        })

    templates = []
    for item in template_stores[:20]:
        storage = str(item.get("storage", ""))
        if item.get("enabled", 1) == 0 or item.get("active", 1) == 0 or not POOL_RE.fullmatch(storage):
            continue
        content = pvesh(f"/nodes/{node}/storage/{storage}/content", "--content", "vztmpl") or []
        for entry in content:
            volid = entry.get("volid")
            if entry.get("content") == "vztmpl" and isinstance(volid, str) and len(volid) <= 512:
                templates.append(volid)

    networks = [
        str(item.get("iface")) for item in bridges
        if item.get("active", 1) != 0 and NETWORK_RE.fullmatch(str(item.get("iface", "")))
    ]
    protected = int(client_id) if client_id and CLIENT_RE.fullmatch(str(client_id)) else None
    details = []
    for item in containers:
        raw_id = str(item.get("vmid", ""))
        if not raw_id.isdigit():
            continue
        vmid = int(raw_id)
        details.append({
            "vmid": vmid,
            "name": str(item.get("name") or f"CT-{vmid}"),
            "status": str(item.get("status") or "unknown"),
            "memory": int(item.get("maxmem") or 0),
            "disk": int(item.get("maxdisk") or 0),
            "cpus": int(item.get("cpus") or 0),
            "uptime": int(item.get("uptime") or 0),
            "protected": vmid == protected,
        })
    return {
        "available": True,
        "enabled": True,
        "provider": "proxmox-lxc",
        "reason": None,
        "containers": details,
        "pools": [item["name"] for item in pools],
        "poolDetails": pools,
        "networks": networks,
        "templates": sorted(set(templates)),
        "node": node,
    }


def create_container(data: dict, client_id: str) -> dict:
    name = str(data.get("name", "")).strip()
    template = str(data.get("template", "")).strip()
    pool = str(data.get("pool", "")).strip()
    network = str(data.get("network", "")).strip()
    try:
        memory = int(data.get("memoryMiB"))
        cpus = int(data.get("cpus"))
        disk = int(data.get("diskGiB"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid container resource values") from exc

    if not NAME_RE.fullmatch(name):
        raise ValueError("container name must contain 2-40 letters, numbers, or hyphens")
    if not (256 <= memory <= 65536 and 1 <= cpus <= 64 and 2 <= disk <= 2048):
        raise ValueError("container resources are outside allowed limits")

    current = container_inventory(client_id)
    if pool not in current["pools"]:
        raise ValueError(f"container storage '{pool}' is not available for rootdir content")
    if network not in current["networks"]:
        raise ValueError(f"network bridge '{network}' is not available")
    if template not in current["templates"]:
        raise ValueError("select an existing Proxmox LXC template")
    if any(item["name"].lower() == name.lower() for item in current["containers"]):
        raise ValueError("a container with this name already exists")

    vmid = int(pvesh("/cluster/nextid"))
    if vmid < 100 or str(vmid) == str(client_id):
        raise RuntimeError("Proxmox returned an invalid container ID")

    created = False
    try:
        run([
            "pct", "create", str(vmid), template,
            "--hostname", name,
            "--memory", str(memory),
            "--cores", str(cpus),
            "--rootfs", f"{pool}:{disk}",
            "--net0", f"name=eth0,bridge={network},ip=dhcp,type=veth",
            "--unprivileged", "1",
            "--onboot", "1",
        ], timeout=180)
        created = True
        run(["pct", "start", str(vmid)], timeout=60)
    except Exception:
        if created:
            try:
                run(["pct", "destroy", str(vmid), "--purge", "1"], timeout=120)
            except Exception:
                pass
        raise
    return {
        "vmid": vmid,
        "name": name,
        "provider": "proxmox-lxc",
        "status": "running",
        "details": "System container created and started on the Proxmox host.",
    }


def container_action(data: dict, client_id: str) -> dict:
    try:
        vmid = int(data.get("vmid"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid container ID") from exc
    action = str(data.get("action", ""))
    if vmid < 100 or vmid > 999999:
        raise ValueError("invalid container ID")
    if str(vmid) == str(client_id):
        raise PermissionError("LightNAS will not manage or delete the container it is currently running inside")
    if action not in {"start", "stop", "shutdown", "reboot", "delete"}:
        raise ValueError("unsupported container action")
    run(["pct", "config", str(vmid)], timeout=15)
    if action == "delete":
        try:
            run(["pct", "stop", str(vmid)], timeout=30)
        except Exception:
            pass
        run(["pct", "destroy", str(vmid), "--purge", "1"], timeout=120)
        return {"vmid": vmid, "action": action, "status": "deleted"}
    run(["pct", action, str(vmid)], timeout=60)
    return {"vmid": vmid, "action": action, "status": "submitted"}


def update_container(data: dict, client_id: str) -> dict:
    try:
        vmid = int(data.get("vmid"))
        memory = int(data.get("memoryMiB"))
        cpus = int(data.get("cpus"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid container update values") from exc
    name = str(data.get("name", "")).strip()
    if vmid < 100 or vmid > 999999 or not NAME_RE.fullmatch(name):
        raise ValueError("invalid container ID or name")
    if str(vmid) == str(client_id):
        raise PermissionError("LightNAS will not change the resources of the container it is currently running inside")
    if not (256 <= memory <= 262144 and 1 <= cpus <= 128):
        raise ValueError("container resources are outside allowed limits")
    run(["pct", "config", str(vmid)], timeout=15)
    run(["pct", "set", str(vmid), "--hostname", name, "--memory", str(memory), "--cores", str(cpus)], timeout=60)
    return {"vmid": vmid, "name": name, "memoryMiB": memory, "cpus": cpus, "status": "updated"}

def update_storage(data: dict) -> dict:
    storage = str(data.get("storage", ""))
    content = data.get("content")
    if not POOL_RE.fullmatch(storage) or not isinstance(content, list):
        raise ValueError("invalid storage update")
    normalized = sorted({str(item) for item in content if str(item) in PVE_CONTENT})
    if not normalized:
        raise ValueError("select at least one supported Proxmox content type")
    configured = {str(item.get("storage")) for item in (pvesh("/storage") or [])}
    if storage not in configured:
        raise ValueError("unknown Proxmox storage")
    pvesh_set(f"/storage/{storage}", "--content", ",".join(normalized))
    return {"storage": storage, "content": normalized, "status": "updated"}


def clean_disk(data: dict) -> dict:
    path = str(data.get("path", ""))
    confirm = str(data.get("confirm", ""))
    if not DISK_RE.fullmatch(path) or confirm != f"CLEAN {path}":
        raise ValueError(f"type CLEAN {path} to confirm")
    current = inventory()["host"]["disks"]
    disk = next((item for item in current if item.get("path") == path), None)
    if not disk:
        raise ValueError("disk is no longer present")
    if not disk.get("eligibleForClean"):
        reasons = "; ".join(disk.get("useReasons") or []) or "disk is protected or in use"
        raise PermissionError(f"refusing to clean {path}: {reasons}")
    if shutil.which("sgdisk"):
        run(["sgdisk", "--zap-all", path], timeout=60)
    run(["wipefs", "--all", "--force", path], timeout=60)
    try:
        run(["blockdev", "--rereadpt", path], timeout=20)
    except Exception:
        pass
    return {"path": path, "status": "cleaned"}


def dispatch(request: dict) -> dict:
    client = authenticate(request)
    action = request.get("action")
    if action == "inventory":
        return inventory()
    if action == "container-inventory":
        return container_inventory(client)
    data = request.get("data")
    if not isinstance(data, dict):
        raise ValueError("missing operation data")
    if action == "create-vm":
        return create_vm(data)
    if action == "vm-action":
        return vm_action(data)
    if action == "vm-update":
        return update_vm(data)
    if action == "create-container":
        return create_container(data, client)
    if action == "container-action":
        return container_action(data, client)
    if action == "container-update":
        return update_container(data, client)
    if action == "storage-update":
        return update_storage(data)
    if action == "disk-clean":
        return clean_disk(data)
    raise ValueError("unsupported host operation")


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        raw = self.rfile.readline(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            self._reply(False, error="request is too large")
            return
        try:
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            if request.get("action") == "vm-console":
                authenticate(request)
                self._stream_vm_console(request.get("data"))
                return
            data = dispatch(request)
            self._reply(True, data=data)
        except PermissionError as exc:
            self._reply(False, error=str(exc), code="forbidden")
        except (ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError) as exc:
            detail = str(exc)
            if isinstance(exc, subprocess.CalledProcessError):
                detail = (exc.stderr or exc.stdout or str(exc)).strip()[:1200]
            self._reply(False, error=detail[:1200], code="operation_failed")
        except Exception as exc:
            self._reply(False, error=f"unexpected host-agent failure: {str(exc)[:300]}", code="internal_error")

    def _stream_vm_console(self, data):
        if not isinstance(data, dict):
            raise ValueError("missing VM console request")
        try:
            vmid = int(data.get("vmid"))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid VM ID") from exc
        if vmid < 100 or vmid > 999999:
            raise ValueError("invalid VM ID")
        state = run(["qm", "status", str(vmid)], timeout=15)
        if "running" not in state:
            raise ValueError("VM must be running before opening the console")

        process = subprocess.Popen(
            ["qm", "vncproxy", str(vmid)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self._reply(True, data={"mode": "raw-vnc", "vmid": vmid})
        self.wfile.flush()

        def socket_to_vnc():
            try:
                while process.poll() is None:
                    chunk = self.connection.recv(65536)
                    if not chunk:
                        break
                    if process.stdin:
                        process.stdin.write(chunk)
                        process.stdin.flush()
            except (BrokenPipeError, ConnectionError, OSError):
                pass
            finally:
                try:
                    if process.stdin:
                        process.stdin.close()
                except Exception:
                    pass

        feeder = threading.Thread(target=socket_to_vnc, daemon=True)
        feeder.start()
        try:
            while process.poll() is None:
                chunk = process.stdout.read(65536) if process.stdout else b""
                if not chunk:
                    break
                self.connection.sendall(chunk)
        except (BrokenPipeError, ConnectionError, OSError):
            pass
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            feeder.join(timeout=1)

    def _reply(self, ok: bool, **payload):
        response = {"ok": ok, **payload}
        self.wfile.write((json.dumps(response, separators=(",", ":")) + "\n").encode("utf-8"))


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


if __name__ == "__main__":
    CLIENT_DIR.mkdir(parents=True, exist_ok=True)
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    server = Server(str(SOCKET_PATH), Handler)
    os.chmod(SOCKET_PATH, 0o666)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            SOCKET_PATH.unlink()
        except FileNotFoundError:
            pass
