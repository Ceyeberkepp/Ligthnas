#!/usr/bin/env python3
"""Narrow LightNAS bridge for a Proxmox VE host.

The service listens only on a local Unix-domain socket. LightNAS LXCs receive that
socket through a Proxmox bind mount and authenticate with a per-container secret.
Only explicit inventory and VM lifecycle operations are implemented; there is no
arbitrary host command execution endpoint.
"""

from __future__ import annotations

import hmac
import json
import os
import re
import socketserver
import subprocess
from pathlib import Path

SOCKET_PATH = Path(os.environ.get("LIGHTNAS_PVE_AGENT_SOCKET", "/var/lib/lightnas-pve/agent.sock"))
CLIENT_DIR = Path(os.environ.get("LIGHTNAS_PVE_CLIENT_DIR", "/etc/lightnas-pve/clients"))
MAX_REQUEST = 64 * 1024
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]{1,39}$")
POOL_RE = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
NETWORK_RE = re.compile(r"^[A-Za-z0-9._-]{1,48}$")
CLIENT_RE = re.compile(r"^[1-9][0-9]{1,5}$")


def run(args: list[str], timeout: int = 30) -> str:
    result = subprocess.run(args, check=True, text=True, capture_output=True, timeout=timeout)
    return result.stdout.strip()


def pvesh(path: str, *args: str):
    output = run(["pvesh", "get", path, *args, "--output-format", "json"])
    return json.loads(output or "null")


def node_name() -> str:
    name = run(["hostname", "-s"])
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", name):
        raise RuntimeError("Proxmox node name is invalid")
    return name


def node_address() -> str | None:
    try:
        addresses = run(["hostname", "-I"]).split()
    except Exception:
        return None
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
            if entry.get("content") == "iso"
            and isinstance(entry.get("volid"), str)
            and str(entry.get("volid")).lower().endswith(".iso")
        )
    images = sorted(set(images))

    machine_details = [
        {
            "vmid": int(item.get("vmid")),
            "name": str(item.get("name") or f"VM-{item.get('vmid')}"),
            "status": str(item.get("status") or "unknown"),
            "memory": int(item.get("maxmem") or 0),
            "disk": int(item.get("maxdisk") or 0),
            "cpus": int(item.get("cpus") or 0),
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
        "networks": [
            str(item.get("iface")) for item in bridges
            if item.get("active", 1) != 0 and NETWORK_RE.fullmatch(str(item.get("iface", "")))
        ],
        "images": images,
        "node": node,
        "proxmoxUrl": f"https://{address}:8006/" if address else None,
        "transport": "host-bridge",
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
        run([
            "qm", "create", str(vmid), "--name", name, "--memory", str(memory),
            "--cores", str(cpus), "--scsihw", "virtio-scsi-pci",
            "--net0", f"virtio,bridge={network}", "--ostype", "l26",
        ], timeout=60)
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


def dispatch(request: dict) -> dict:
    authenticate(request)
    action = request.get("action")
    if action == "inventory":
        return inventory()
    if action == "create-vm":
        data = request.get("data")
        if not isinstance(data, dict):
            raise ValueError("missing VM definition")
        return create_vm(data)
    if action == "vm-action":
        data = request.get("data")
        if not isinstance(data, dict):
            raise ValueError("missing VM action")
        return vm_action(data)
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
