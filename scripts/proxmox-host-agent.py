#!/usr/bin/env python3
"""Narrow LightNAS bridge for a Proxmox VE host.

The service listens only on a local Unix-domain socket. LightNAS LXCs receive that
socket through a Proxmox bind mount and authenticate with a per-container secret.
Only explicit inventory and VM-creation operations are implemented; there is no
arbitrary command execution endpoint.
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
    # Refuse stale credentials for containers that no longer exist.
    run(["pct", "config", client], timeout=10)
    return client


def inventory() -> dict:
    node = node_name()
    machines = pvesh(f"/nodes/{node}/qemu") or []
    stores = pvesh(f"/nodes/{node}/storage", "--content", "images") or []
    bridges = pvesh(f"/nodes/{node}/network", "--type", "bridge") or []

    pools = [
        str(item.get("storage")) for item in stores
        if item.get("enabled", 1) != 0
        and item.get("active", 1) != 0
        and POOL_RE.fullmatch(str(item.get("storage", "")))
    ]

    iso_stores = pvesh(f"/nodes/{node}/storage", "--content", "iso") or []
    images: list[str] = []
    for item in iso_stores[:20]:
        storage = str(item.get("storage", ""))
        if item.get("enabled", 1) == 0 or item.get("active", 1) == 0 or not POOL_RE.fullmatch(storage):
            continue
        content = pvesh(f"/nodes/{node}/storage/{storage}/content", "--content", "iso") or []
        images.extend(
            str(entry.get("volid")) for entry in content
            if entry.get("content") == "iso" and isinstance(entry.get("volid"), str)
        )

    return {
        "available": True,
        "enabled": True,
        # Keep the provider name compatible with the existing LightNAS UI.
        # The transport is the automatic local host bridge, not an API token.
        "provider": "proxmox",
        "reason": None,
        "machines": [
            f"{item.get('name') or 'VM'} ({item.get('vmid')}) · {item.get('status') or 'unknown'}"
            for item in machines
        ],
        "pools": pools,
        "networks": [
            str(item.get("iface")) for item in bridges
            if item.get("active", 1) != 0 and NETWORK_RE.fullmatch(str(item.get("iface", "")))
        ],
        "images": images,
        "node": node,
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
    if pool not in current["pools"] or network not in current["networks"] or iso not in current["images"]:
        raise ValueError("storage, network, or ISO is not currently available on Proxmox")
    if any(machine.startswith(f"{name} (") for machine in current["machines"]):
        raise ValueError("a VM with this name already exists")

    vmid = int(pvesh("/cluster/nextid"))
    if vmid < 100:
        raise RuntimeError("Proxmox returned an invalid VM ID")

    # Use qm directly on the host. Every argument is validated above and passed
    # without a shell, so user input cannot become a host command.
    run([
        "qm", "create", str(vmid),
        "--name", name,
        "--memory", str(memory),
        "--cores", str(cpus),
        "--scsihw", "virtio-scsi-pci",
        "--scsi0", f"{pool}:{disk}",
        "--ide2", f"{iso},media=cdrom",
        "--net0", f"virtio,bridge={network}",
        "--boot", "order=ide2;scsi0",
        "--ostype", "l26",
    ], timeout=120)

    try:
        run(["qm", "start", str(vmid)], timeout=60)
        detail = "VM created and started on the Proxmox host."
    except Exception:
        detail = "VM created on the Proxmox host but could not be started automatically."

    return {"name": name, "vmid": vmid, "details": detail}


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
                detail = (exc.stderr or exc.stdout or str(exc)).strip()[:800]
            self._reply(False, error=detail[:800], code="operation_failed")
        except Exception:
            self._reply(False, error="unexpected host-agent failure", code="internal_error")

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
