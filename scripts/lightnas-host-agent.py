#!/usr/bin/env python3
"""Privileged local LightNAS host daemon.

This daemon is part of LightNAS itself.  It exposes a narrow Unix-socket API to
the unprivileged web control plane for operations that must run as root:
system-container lifecycle and host network configuration.  It never accepts
arbitrary shell commands.
"""

from __future__ import annotations

import grp
import json
import os
import pty
import re
import shutil
import socketserver
import subprocess
import threading
from pathlib import Path

SOCKET_PATH = Path(os.environ.get("LIGHTNAS_HOST_SOCKET", "/run/lightnas/host-agent.sock"))
MAX_REQUEST = 64 * 1024
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]{1,39}$")
IFACE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,32}$")
CONNECTION_RE = re.compile(r"^[A-Za-z0-9 _.:@+-]{1,80}$")
CIDR_RE = re.compile(r"^(?:[0-9A-Fa-f:.]+)/(?:[0-9]{1,3})$")

IMAGES = [
    {"id": "debian-13", "label": "Debian 13", "dist": "debian", "release": "trixie"},
    {"id": "ubuntu-24.04", "label": "Ubuntu 24.04 LTS", "dist": "ubuntu", "release": "noble"},
    {"id": "ubuntu-22.04", "label": "Ubuntu 22.04 LTS", "dist": "ubuntu", "release": "jammy"},
    {"id": "alpine-3.21", "label": "Alpine Linux 3.21", "dist": "alpine", "release": "3.21"},
]
IMAGE_BY_ID = {item["id"]: item for item in IMAGES}


def run(args: list[str], timeout: int = 30, check: bool = True) -> str:
    result = subprocess.run(args, check=check, text=True, capture_output=True, timeout=timeout)
    return result.stdout.strip()


def available(program: str) -> bool:
    return shutil.which(program) is not None


def in_container() -> bool:
    try:
        result = subprocess.run(["systemd-detect-virt", "--container"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return result.returncode == 0
    except OSError:
        return False


def container_capability() -> tuple[bool, str | None]:
    if not all(available(name) for name in ["lxc-create", "lxc-start", "lxc-stop", "lxc-attach", "lxc-ls"]):
        return False, "Native LXC tools are not installed."
    # Nested LXC is deliberately not assumed.  A nested appliance can be
    # enabled by the operator, but LightNAS must not escape to the outer host.
    if in_container() and os.environ.get("LIGHTNAS_ALLOW_NESTED_LXC") != "1":
        return False, "LightNAS is itself inside a container. Native system containers require nested LXC support; run LightNAS on bare metal or a VM, or explicitly enable nested LXC."
    return True, None


def lxc_state(name: str) -> str:
    try:
        output = run(["lxc-info", "-n", name, "-sH"], timeout=10)
        return output.lower() or "unknown"
    except Exception:
        return "unknown"


def container_inventory() -> dict:
    ok, reason = container_capability()
    names: list[str] = []
    if ok:
        try:
            names = [line.strip() for line in run(["lxc-ls", "-1"], timeout=15).splitlines() if NAME_RE.fullmatch(line.strip())]
        except Exception:
            names = []
    containers = []
    for name in names:
        state = lxc_state(name)
        pid = None
        try:
            raw_pid = run(["lxc-info", "-n", name, "-pH"], timeout=10)
            pid = int(raw_pid) if raw_pid.isdigit() else None
        except Exception:
            pass
        containers.append({"id": name, "name": name, "status": state, "pid": pid, "provider": "local-lxc"})
    return {
        "available": ok,
        "enabled": ok,
        "provider": "local-lxc",
        "reason": reason,
        "containers": containers,
        "images": IMAGES,
        "networks": local_networks(),
        "storageRoot": "/var/lib/lxc",
    }


def local_networks() -> list[str]:
    result = []
    try:
        links = json.loads(run(["ip", "-j", "link", "show"], timeout=10) or "[]")
        for item in links:
            name = str(item.get("ifname") or "")
            if IFACE_RE.fullmatch(name) and name != "lo":
                result.append(name)
    except Exception:
        pass
    for preferred in ["lightnas0", "lxcbr0"]:
        if preferred in result:
            result.remove(preferred)
            result.insert(0, preferred)
    return result


def append_unique(path: Path, line: str) -> None:
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    key = line.split("=", 1)[0].strip()
    kept = [row for row in current.splitlines() if row.split("=", 1)[0].strip() != key]
    kept.append(line)
    path.write_text("\n".join(kept) + "\n", encoding="utf-8")


def create_container(data: dict) -> dict:
    ok, reason = container_capability()
    if not ok:
        raise RuntimeError(reason)
    name = str(data.get("name") or "").strip()
    image_id = str(data.get("image") or "").strip()
    network = str(data.get("network") or "lxcbr0").strip()
    try:
        memory = int(data.get("memoryMiB") or 2048)
        cpus = int(data.get("cpus") or 2)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid container resource values") from exc
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid container name")
    image = IMAGE_BY_ID.get(image_id)
    if not image:
        raise ValueError("select a built-in Linux system-container image")
    if not IFACE_RE.fullmatch(network) or network not in local_networks():
        raise ValueError("select an existing local bridge or interface")
    host_cpus = max(1, os.cpu_count() or 1)
    if not (256 <= memory <= 262144 and 1 <= cpus <= min(128, host_cpus)):
        raise ValueError("container CPU or memory values are outside host limits")
    if Path("/var/lib/lxc", name).exists():
        raise ValueError("a container with this name already exists")

    args = [
        "lxc-create", "-n", name, "-t", "download", "--",
        "--dist", image["dist"], "--release", image["release"], "--arch", "amd64",
    ]
    run(args, timeout=900)
    config = Path("/var/lib/lxc") / name / "config"
    append_unique(config, "lxc.start.auto = 1")
    append_unique(config, f"lxc.cgroup2.memory.max = {memory * 1024 * 1024}")
    append_unique(config, f"lxc.cgroup2.cpuset.cpus = 0-{cpus - 1}")
    append_unique(config, "lxc.net.0.type = veth")
    append_unique(config, f"lxc.net.0.link = {network}")
    append_unique(config, "lxc.net.0.flags = up")
    append_unique(config, "lxc.net.0.name = eth0")
    run(["lxc-start", "-n", name, "-d"], timeout=60)
    return {"id": name, "name": name, "status": "running", "provider": "local-lxc"}


def container_action(data: dict) -> dict:
    name = str(data.get("id") or data.get("name") or "").strip()
    action = str(data.get("action") or "")
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid container name")
    if not (Path("/var/lib/lxc") / name / "config").exists():
        raise ValueError("unknown local LXC container")
    if action == "start":
        run(["lxc-start", "-n", name, "-d"], timeout=60)
    elif action in {"stop", "shutdown"}:
        run(["lxc-stop", "-n", name, "-t", "30"], timeout=45)
    elif action == "reboot":
        run(["lxc-stop", "-n", name, "-r", "-t", "30"], timeout=60)
    elif action == "delete":
        try:
            run(["lxc-stop", "-n", name, "-t", "10"], timeout=20, check=False)
        finally:
            run(["lxc-destroy", "-n", name], timeout=120)
    else:
        raise ValueError("unsupported container action")
    return {"id": name, "action": action, "status": "submitted"}


def update_container(data: dict) -> dict:
    current = str(data.get("id") or "").strip()
    new_name = str(data.get("name") or current).strip()
    try:
        memory = int(data.get("memoryMiB"))
        cpus = int(data.get("cpus"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid container update values") from exc
    if not NAME_RE.fullmatch(current) or not NAME_RE.fullmatch(new_name):
        raise ValueError("invalid container name")
    config = Path("/var/lib/lxc") / current / "config"
    if not config.exists():
        raise ValueError("unknown local LXC container")
    host_cpus = max(1, os.cpu_count() or 1)
    if not (256 <= memory <= 262144 and 1 <= cpus <= min(128, host_cpus)):
        raise ValueError("container CPU or memory values are outside host limits")
    # Renaming an LXC safely involves its path/rootfs and is intentionally kept
    # separate.  Resource edits are live/persistent.
    if new_name != current:
        raise ValueError("renaming local LXC containers is not enabled yet; clone or recreate with the new name")
    append_unique(config, f"lxc.cgroup2.memory.max = {memory * 1024 * 1024}")
    append_unique(config, f"lxc.cgroup2.cpuset.cpus = 0-{cpus - 1}")
    if lxc_state(current) == "running":
        subprocess.run(["lxc-cgroup", "-n", current, "memory.max", str(memory * 1024 * 1024)], check=False, capture_output=True)
        subprocess.run(["lxc-cgroup", "-n", current, "cpuset.cpus", f"0-{cpus - 1}"], check=False, capture_output=True)
    return {"id": current, "name": current, "memoryMiB": memory, "cpus": cpus, "status": "updated"}


def parse_nmcli(text: str, count: int) -> list[list[str]]:
    rows = []
    for line in text.splitlines():
        if not line:
            continue
        fields = line.split(":")
        if len(fields) >= count:
            rows.append(fields[: count - 1] + [":".join(fields[count - 1 :])])
    return rows


def network_inventory() -> dict:
    if not available("nmcli"):
        return {"editable": False, "manager": None, "reason": "NetworkManager is not installed.", "devices": [], "connections": [], "wifi": []}
    devices_raw = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"], timeout=15, check=False)
    devices = [
        {"name": row[0], "type": row[1], "state": row[2], "connection": row[3] or None}
        for row in parse_nmcli(devices_raw, 4)
        if IFACE_RE.fullmatch(row[0])
    ]
    connections_raw = run(["nmcli", "-t", "-f", "NAME,UUID,TYPE,DEVICE,AUTOCONNECT", "connection", "show"], timeout=15, check=False)
    connections = [
        {"name": row[0], "uuid": row[1], "type": row[2], "device": row[3] or None, "autoconnect": row[4] == "yes"}
        for row in parse_nmcli(connections_raw, 5)
        if row[0]
    ]
    wifi = []
    if any(item["type"] == "wifi" for item in devices):
        scan = run(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto"], timeout=20, check=False)
        seen = set()
        for row in parse_nmcli(scan, 4):
            ssid = row[1]
            if not ssid or ssid in seen:
                continue
            seen.add(ssid)
            wifi.append({"ssid": ssid, "connected": row[0] == "*", "signal": int(row[2] or 0), "security": row[3] or "Open"})
    return {"editable": True, "manager": "NetworkManager", "reason": None, "devices": devices, "connections": connections, "wifi": wifi}


def require_nmcli() -> None:
    if not available("nmcli"):
        raise RuntimeError("NetworkManager is not installed on this LightNAS host")


def network_action(data: dict) -> dict:
    require_nmcli()
    action = str(data.get("action") or "")
    if action == "wifi-connect":
        device = str(data.get("device") or "")
        ssid = str(data.get("ssid") or "")
        password = str(data.get("password") or "")
        if not IFACE_RE.fullmatch(device) or not ssid or len(ssid) > 64 or len(password) > 256:
            raise ValueError("invalid Wi-Fi connection settings")
        args = ["nmcli", "device", "wifi", "connect", ssid, "ifname", device]
        if password:
            args += ["password", password]
        run(args, timeout=45)
        return {"action": action, "device": device, "ssid": ssid, "status": "connected"}
    if action == "device-connect":
        device = str(data.get("device") or "")
        if not IFACE_RE.fullmatch(device):
            raise ValueError("invalid network device")
        run(["nmcli", "device", "connect", device], timeout=30)
        return {"action": action, "device": device}
    if action == "device-disconnect":
        device = str(data.get("device") or "")
        if not IFACE_RE.fullmatch(device):
            raise ValueError("invalid network device")
        run(["nmcli", "device", "disconnect", device], timeout=30)
        return {"action": action, "device": device}
    if action == "connection-delete":
        name = str(data.get("name") or "")
        if not CONNECTION_RE.fullmatch(name):
            raise ValueError("invalid connection name")
        run(["nmcli", "connection", "delete", name], timeout=30)
        return {"action": action, "name": name}
    if action == "connection-update":
        name = str(data.get("name") or "")
        method = str(data.get("method") or "auto")
        address = str(data.get("address") or "").strip()
        gateway = str(data.get("gateway") or "").strip()
        dns = str(data.get("dns") or "").strip()
        autoconnect = "yes" if bool(data.get("autoconnect", True)) else "no"
        if not CONNECTION_RE.fullmatch(name) or method not in {"auto", "manual"}:
            raise ValueError("invalid connection settings")
        if method == "manual" and not CIDR_RE.fullmatch(address):
            raise ValueError("manual IPv4 configuration requires an address in CIDR form")
        args = ["nmcli", "connection", "modify", name, "ipv4.method", method, "connection.autoconnect", autoconnect]
        if method == "manual":
            args += ["ipv4.addresses", address]
            if gateway:
                args += ["ipv4.gateway", gateway]
        else:
            args += ["ipv4.addresses", "", "ipv4.gateway", ""]
        args += ["ipv4.dns", dns]
        run(args, timeout=30)
        if bool(data.get("activate")):
            run(["nmcli", "connection", "up", name], timeout=45)
        return {"action": action, "name": name, "method": method, "activated": bool(data.get("activate"))}
    if action == "bridge-create":
        name = str(data.get("name") or "lightnas0")
        uplink = str(data.get("uplink") or "")
        if not IFACE_RE.fullmatch(name) or not IFACE_RE.fullmatch(uplink):
            raise ValueError("invalid bridge or uplink interface")
        run(["nmcli", "connection", "add", "type", "bridge", "ifname", name, "con-name", name], timeout=30)
        run(["nmcli", "connection", "add", "type", "bridge-slave", "ifname", uplink, "master", name, "con-name", f"{name}-{uplink}"], timeout=30)
        return {"action": action, "name": name, "uplink": uplink}
    if action == "vlan-create":
        name = str(data.get("name") or "")
        parent = str(data.get("parent") or "")
        vlan_id = int(data.get("vlanId") or 0)
        if not IFACE_RE.fullmatch(name) or not IFACE_RE.fullmatch(parent) or not (1 <= vlan_id <= 4094):
            raise ValueError("invalid VLAN settings")
        run(["nmcli", "connection", "add", "type", "vlan", "con-name", name, "ifname", name, "dev", parent, "id", str(vlan_id)], timeout=30)
        return {"action": action, "name": name, "parent": parent, "vlanId": vlan_id}
    raise ValueError("unsupported network action")


def stream_container(connection, data: dict) -> None:
    name = str(data.get("id") or data.get("name") or "")
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid container name")
    if lxc_state(name) != "running":
        raise ValueError("start the container before opening its terminal")
    master, slave = pty.openpty()
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    process = subprocess.Popen(["lxc-attach", "-n", name, "--", "/bin/sh", "-l"], stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env)
    os.close(slave)

    def input_loop():
        try:
            while process.poll() is None:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                os.write(master, chunk)
        except OSError:
            pass

    feeder = threading.Thread(target=input_loop, daemon=True)
    feeder.start()
    try:
        while process.poll() is None:
            chunk = os.read(master, 65536)
            if not chunk:
                break
            connection.sendall(chunk)
    except OSError:
        pass
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        if process.poll() is None:
            process.terminate()
        feeder.join(timeout=1)


def dispatch(request: dict) -> dict:
    action = str(request.get("action") or "")
    data = request.get("data") or {}
    if not isinstance(data, dict):
        raise ValueError("operation data must be an object")
    if action == "container-inventory":
        return container_inventory()
    if action == "container-create":
        return create_container(data)
    if action == "container-action":
        return container_action(data)
    if action == "container-update":
        return update_container(data)
    if action == "network-inventory":
        return network_inventory()
    if action == "network-action":
        return network_action(data)
    raise ValueError("unsupported LightNAS host operation")


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        raw = self.rfile.readline(MAX_REQUEST + 1)
        if not raw or len(raw) > MAX_REQUEST:
            return
        try:
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            if request.get("action") == "container-console":
                self.wfile.write(b'{"ok":true,"data":{"mode":"pty"}}\n')
                self.wfile.flush()
                stream_container(self.connection, request.get("data") or {})
                return
            data = dispatch(request)
            self.wfile.write((json.dumps({"ok": True, "data": data}, separators=(",", ":")) + "\n").encode())
        except PermissionError as exc:
            self.wfile.write((json.dumps({"ok": False, "code": "forbidden", "error": str(exc)}) + "\n").encode())
        except (ValueError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            detail = str(exc)
            if isinstance(exc, subprocess.CalledProcessError):
                detail = (exc.stderr or exc.stdout or str(exc)).strip()
            self.wfile.write((json.dumps({"ok": False, "code": "operation_failed", "error": detail[:1200]}) + "\n").encode())
        except Exception as exc:
            self.wfile.write((json.dumps({"ok": False, "code": "internal_error", "error": f"local host agent failed: {str(exc)[:300]}"}) + "\n").encode())


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


if __name__ == "__main__":
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    server = Server(str(SOCKET_PATH), Handler)
    try:
        gid = grp.getgrnam("lightnas").gr_gid
    except KeyError:
        gid = 0
    os.chown(SOCKET_PATH, 0, gid)
    os.chmod(SOCKET_PATH, 0o660)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            SOCKET_PATH.unlink()
        except FileNotFoundError:
            pass
