#!/usr/bin/env python3
"""Privileged local LightNAS host daemon.

This daemon is part of LightNAS itself.  It exposes a narrow Unix-socket API to
the unprivileged web control plane for operations that must run as root:
system-container lifecycle and host network configuration.  It never accepts
arbitrary shell commands.
"""

from __future__ import annotations

import fcntl
import ipaddress
import grp
import json
import os
import platform
import pty
import re
import shutil
import socket
import socketserver
import subprocess
import termios
import threading
import time
from pathlib import Path

SOCKET_PATH = Path(os.environ.get("LIGHTNAS_HOST_SOCKET", "/run/lightnas/host-agent.sock"))
LOCAL_STORAGE_ROOT = Path(os.environ.get("LIGHTNAS_LOCAL_STORAGE_ROOT", "/var/lib/lightnas/storage/local")).resolve()
INSTALL_ROOT = Path(os.environ.get("LIGHTNAS_INSTALL_ROOT", "/opt/lightnas")).resolve()
MAX_REQUEST = 64 * 1024
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]{1,39}$")
IFACE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,32}$")
CONNECTION_RE = re.compile(r"^[A-Za-z0-9 _.:@+-]{1,80}$")
CIDR_RE = re.compile(r"^(?:[0-9A-Fa-f:.]+)/(?:[0-9]{1,3})$")

IMAGES = [
    {"id": "debian-13", "label": "Debian 13", "dist": "debian", "release": "trixie", "builder": "debootstrap", "mirror": "https://deb.debian.org/debian", "nested": True},
    {"id": "ubuntu-24.04", "label": "Ubuntu 24.04 LTS", "dist": "ubuntu", "release": "noble", "builder": "debootstrap", "mirror": "https://archive.ubuntu.com/ubuntu", "nested": True},
    {"id": "ubuntu-22.04", "label": "Ubuntu 22.04 LTS", "dist": "ubuntu", "release": "jammy", "builder": "debootstrap", "mirror": "https://archive.ubuntu.com/ubuntu", "nested": True},
    # Alpine's legacy LXC template refuses user-namespace builds. Keep it
    # available on bare metal while nested LightNAS exposes only builders that
    # do not depend on images.linuxcontainers.org/index-user.
    {"id": "alpine-3.21", "label": "Alpine Linux 3.21", "dist": "alpine", "release": "3.21", "builder": "template", "template": "alpine", "nested": False},
]
IMAGE_BY_ID = {item["id"]: item for item in IMAGES}


def run(args: list[str], timeout: int = 30, check: bool = True) -> str:
    result = subprocess.run(args, check=check, text=True, capture_output=True, timeout=timeout)
    return result.stdout.strip()


def available(program: str) -> bool:
    return shutil.which(program) is not None


def native_debian_arch() -> str:
    """Return the native Debian architecture used for system-container builds."""
    if available("dpkg"):
        try:
            value = run(["dpkg", "--print-architecture"], timeout=5).strip()
            if value:
                return value
        except Exception:
            pass
    machine = platform.machine().lower()
    mapping = {
        "x86_64": "amd64", "amd64": "amd64",
        "i386": "i386", "i486": "i386", "i586": "i386", "i686": "i386", "x86": "i386",
        "aarch64": "arm64", "arm64": "arm64",
        "armv7l": "armhf", "armv7": "armhf", "armhf": "armhf",
        "riscv64": "riscv64",
    }
    value = mapping.get(machine)
    if not value:
        raise RuntimeError(f"unsupported native architecture for LightNAS system containers: {machine or 'unknown'}")
    return value


def debootstrap_mirror(image: dict, architecture: str) -> str:
    # Ubuntu publishes non-x86 ports from ports.ubuntu.com rather than the
    # ordinary archive host. Debian's deb.debian.org mirror is multi-arch.
    if str(image.get("dist") or "").lower() == "ubuntu" and architecture not in {"amd64", "i386"}:
        return "https://ports.ubuntu.com/ubuntu-ports"
    return str(image["mirror"])


def in_container() -> bool:
    try:
        result = subprocess.run(["systemd-detect-virt", "--container"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return result.returncode == 0
    except OSError:
        return False


def probe_command(args: list[str], timeout: int = 10) -> dict:
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=timeout)
        return {"ok": result.returncode == 0, "error": (result.stderr or result.stdout or "").strip()[:500] or None}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:500]}


def nested_runtime_diagnostics() -> dict:
    nested = in_container()
    bridges = local_networks()
    diagnostics = {
        "nested": nested,
        "nestedEnabled": os.environ.get("LIGHTNAS_ALLOW_NESTED_LXC") == "1",
        "tools": all(available(name) for name in ["lxc-create", "lxc-start", "lxc-stop", "lxc-attach", "lxc-ls"]),
        "bridges": bridges,
        "cgroupWritable": True,
        "mountNamespace": True,
        "networkNamespace": True,
        "veth": True,
        "apparmorProfile": None,
        "kvm": {"present": Path("/dev/kvm").exists(), "usable": False, "apiVersion": None, "error": None},
        "tun": Path("/dev/net/tun").exists(),
        "errors": [],
    }

    try:
        diagnostics["apparmorProfile"] = Path("/proc/self/attr/current").read_text(encoding="utf-8").strip()
    except OSError:
        pass

    if nested:
        cgroup_probe = Path("/sys/fs/cgroup") / f"lightnas-probe-{os.getpid()}"
        try:
            cgroup_probe.mkdir()
            cgroup_probe.rmdir()
        except OSError as exc:
            diagnostics["cgroupWritable"] = False
            diagnostics["errors"].append(f"cgroup delegation is unavailable: {exc}")

        if available("unshare"):
            mount_probe = probe_command(["unshare", "--mount", "--propagation", "private", "true"])
            diagnostics["mountNamespace"] = mount_probe["ok"]
            if not mount_probe["ok"]:
                diagnostics["errors"].append(f"mount namespace unavailable: {mount_probe['error'] or 'permission denied'}")
            net_probe = probe_command(["unshare", "--net", "true"])
            diagnostics["networkNamespace"] = net_probe["ok"]
            if not net_probe["ok"]:
                diagnostics["errors"].append(f"network namespace unavailable: {net_probe['error'] or 'permission denied'}")
        else:
            diagnostics["mountNamespace"] = False
            diagnostics["networkNamespace"] = False
            diagnostics["errors"].append("util-linux unshare is unavailable")

        if available("ip"):
            left = f"lnp{os.getpid() % 10000}a"
            right = f"lnp{os.getpid() % 10000}b"
            probe = probe_command(["ip", "link", "add", left, "type", "veth", "peer", "name", right])
            diagnostics["veth"] = probe["ok"]
            if probe["ok"]:
                subprocess.run(["ip", "link", "delete", left], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                diagnostics["errors"].append(f"veth creation unavailable: {probe['error'] or 'permission denied'}")
        else:
            diagnostics["veth"] = False
            diagnostics["errors"].append("iproute2 is unavailable")

    if diagnostics["kvm"]["present"]:
        try:
            fd = os.open("/dev/kvm", os.O_RDWR | getattr(os, "O_CLOEXEC", 0))
            try:
                api_version = fcntl.ioctl(fd, 0xAE00, 0)
                diagnostics["kvm"].update({"usable": api_version == 12, "apiVersion": api_version})
                if api_version != 12:
                    diagnostics["kvm"]["error"] = f"unexpected KVM API version {api_version}"
            finally:
                os.close(fd)
        except OSError as exc:
            diagnostics["kvm"]["error"] = str(exc)
    else:
        diagnostics["kvm"]["error"] = "/dev/kvm is not present"

    return diagnostics


def container_capability() -> tuple[bool, str | None, dict]:
    diagnostics = nested_runtime_diagnostics()
    if not diagnostics["tools"]:
        return False, "Native LXC tools are not installed.", diagnostics
    if diagnostics["nested"] and not diagnostics["nestedEnabled"]:
        return False, "LightNAS is inside another container and nested LXC has not been enabled.", diagnostics
    if diagnostics["nested"]:
        critical = [
            ("cgroupWritable", "nested cgroup delegation is unavailable"),
            ("mountNamespace", "nested mount namespaces are blocked"),
            ("networkNamespace", "nested network namespaces are blocked"),
            ("veth", "nested veth creation is blocked"),
        ]
        for key, message in critical:
            if not diagnostics[key]:
                detail = next((item for item in diagnostics["errors"] if key.split("Namespace")[0].lower() in item.lower()), None)
                return False, detail or message, diagnostics
    if not diagnostics["bridges"]:
        return False, "No local Linux bridge is available for LXC networking. Start lxc-net or create a LightNAS bridge.", diagnostics
    return True, None, diagnostics


def lxc_state(name: str) -> str:
    try:
        output = run(["lxc-info", "-n", name, "-sH"], timeout=10)
        return output.lower() or "unknown"
    except Exception:
        return "unknown"


def container_limits(name: str) -> tuple[int, int]:
    memory = 0
    cpus = 0
    path = Path("/var/lib/lxc") / name / "config"
    try:
        for row in path.read_text(encoding="utf-8").splitlines():
            if row.startswith("lxc.cgroup2.memory.max"):
                raw = row.split("=", 1)[1].strip()
                if raw.isdigit():
                    memory = int(raw)
            elif row.startswith("lxc.cgroup2.cpu.max"):
                raw = row.split("=", 1)[1].strip().split()
                if len(raw) == 2 and raw[0].isdigit() and raw[1].isdigit() and int(raw[1]) > 0:
                    cpus = max(1, round(int(raw[0]) / int(raw[1])))
    except OSError:
        pass
    return memory, cpus


def container_addresses(name: str) -> list[str]:
    if lxc_state(name) != "running":
        return []
    try:
        values = run(["lxc-info", "-n", name, "-iH"], timeout=5, check=False).splitlines()
    except Exception:
        return []
    addresses = []
    for value in values:
        value = value.strip()
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            continue
        if not address.is_loopback and not address.is_link_local:
            addresses.append(value)
    return addresses


def container_settings(name: str) -> dict:
    config = Path("/var/lib/lxc") / name / "config"
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        text = ""

    def config_value(key: str) -> str:
        match = re.search(rf"^{re.escape(key)}\\s*=\\s*(.+?)\\s*$", text, re.MULTILINE)
        return match.group(1).strip() if match else ""

    metadata = {}
    try:
        metadata = json.loads((config.parent / "lightnas.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        pass

    rootfs = rootfs_from_config(config)
    mode = ""
    address = ""
    gateway = ""
    dns: list[str] = []
    settings_source = ""

    # First read the actual guest configuration written on disk. This is the
    # authoritative configured state, including when the container is stopped.
    if rootfs:
        candidates = [
            rootfs / "etc" / "systemd" / "network" / "10-lightnas-eth0.network",
            rootfs / "etc" / "systemd" / "network" / "20-eth0.network",
        ]
        network_file = next((path for path in candidates if path.exists()), None)
        if network_file:
            try:
                network_text = network_file.read_text(encoding="utf-8")
                dhcp = bool(re.search(r"^DHCP\\s*=\\s*(?:yes|ipv4|true)\\s*$", network_text, re.MULTILINE | re.IGNORECASE))
                mode = "dhcp" if dhcp else "manual"
                match = re.search(r"^Address\\s*=\\s*(.+?)\\s*$", network_text, re.MULTILINE)
                address = match.group(1).strip() if match else ""
                match = re.search(r"^Gateway\\s*=\\s*(.+?)\\s*$", network_text, re.MULTILINE)
                gateway = match.group(1).strip() if match else ""
                dns = [item.strip() for item in re.findall(r"^DNS\\s*=\\s*(.+?)\\s*$", network_text, re.MULTILINE)]
                settings_source = "guest-config"
            except OSError:
                pass

    # Some LXC configurations carry static addressing directly on net.0.
    if not address:
        lxc_address = config_value("lxc.net.0.ipv4.address")
        if lxc_address:
            address = lxc_address
            mode = "manual"
            settings_source = settings_source or "lxc-config"
    if not gateway:
        lxc_gateway = config_value("lxc.net.0.ipv4.gateway")
        if lxc_gateway:
            gateway = lxc_gateway
            settings_source = settings_source or "lxc-config"

    # Metadata is a fallback only. It must never overwrite a real guest/LXC
    # setting because it can become stale after manual changes.
    if not mode:
        mode = str(metadata.get("ipv4Mode") or "dhcp")
        settings_source = "saved-metadata"
    if not address:
        address = str(metadata.get("ipv4Address") or "")
    if not gateway:
        gateway = str(metadata.get("gateway") or "")
    if not dns:
        dns = [item.strip() for item in str(metadata.get("dns") or "").split(",") if item.strip()]

    routed_next_hop = str(metadata.get("routedLanNextHop") or "").strip()
    if routed_next_hop:
        address = str(metadata.get("ipv4Address") or address)
        gateway = str(metadata.get("gateway") or gateway)
        saved_dns = [item.strip() for item in str(metadata.get("dns") or "").split(",") if item.strip()]
        if saved_dns:
            dns = saved_dns

    configured_address = address
    configured_gateway = gateway
    configured_dns = list(dns)

    # For a running guest, also retrieve the effective network state. These
    # values are shown separately in the UI so administrators can immediately
    # see whether a saved static configuration has actually taken effect.
    live_address = ""
    live_gateway = ""
    live_dns: list[str] = []
    if lxc_state(name) == "running":
        # Detect the actual default interface instead of assuming eth0. Imported
        # or rebuilt containers may use a different guest interface name.
        live_device = ""
        try:
            live_route = run(
                ["lxc-attach", "-n", name, "--", "ip", "-4", "route", "show", "default"],
                timeout=5, check=False,
            )
            gateway_match = re.search(r"\\bvia\\s+([0-9.]+)", live_route)
            device_match = re.search(r"\\bdev\\s+([^\\s]+)", live_route)
            live_gateway = gateway_match.group(1).strip() if gateway_match else ""
            live_device = device_match.group(1).strip() if device_match else ""
        except Exception:
            pass

        try:
            address_args = ["lxc-attach", "-n", name, "--", "ip", "-4", "-o", "addr", "show"]
            if live_device:
                address_args += ["dev", live_device]
            address_args += ["scope", "global"]
            live_ip = run(address_args, timeout=5, check=False)
            match = re.search(r"\\binet\\s+([^\\s]+)", live_ip)
            live_address = match.group(1).strip() if match else ""
        except Exception:
            pass

        # systemd-resolved commonly leaves /etc/resolv.conf pointing at
        # 127.0.0.53. Ask resolvectl first, then inspect the real resolver file.
        resolver_texts: list[str] = []
        if live_device:
            try:
                resolver_texts.append(run(
                    ["lxc-attach", "-n", name, "--", "resolvectl", "dns", live_device],
                    timeout=5, check=False,
                ))
            except Exception:
                pass
        for resolver_path in ("/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"):
            try:
                resolver_texts.append(run(
                    ["lxc-attach", "-n", name, "--", "cat", resolver_path],
                    timeout=5, check=False,
                ))
            except Exception:
                pass
        for resolver_text in resolver_texts:
            candidates = re.findall(r"^nameserver\\s+([^\\s#]+)", resolver_text, re.MULTILINE)
            candidates += re.findall(r"\\b(?:DNS Servers?|Current DNS Server):\\s*(.+)$", resolver_text, re.MULTILINE)
            candidates += re.findall(r"^Link\\s+\\d+\\s+\\([^)]+\\):\\s*(.+)$", resolver_text, re.MULTILINE)
            for candidate in candidates:
                for item in str(candidate).split():
                    value = item.strip()
                    try:
                        parsed = ipaddress.ip_address(value)
                        if not parsed.is_loopback and value not in live_dns:
                            live_dns.append(value)
                    except ValueError:
                        continue

    extra_nics = []
    nic_indexes = sorted({
        int(match.group(1))
        for match in re.finditer(r"^lxc\\.net\\.(\\d+)\\.", text, re.MULTILINE)
        if int(match.group(1)) > 0
    })
    for index in nic_indexes:
        def nic_value(field: str) -> str:
            match = re.search(rf"^lxc\\.net\\.{index}\\.{re.escape(field)}\\s*=\\s*(.+?)\\s*$", text, re.MULTILINE)
            return match.group(1).strip() if match else ""
        extra_nics.append({
            "index": index,
            "type": nic_value("type") or "veth",
            "network": nic_value("link"),
            "name": nic_value("name") or f"eth{index}",
            "macAddress": nic_value("hwaddr"),
            "vlanTag": nic_value("vlan.id"),
        })

    mount_points = []
    device_paths = []
    for match in re.finditer(r"^lxc\\.mount\\.entry\\s*=\\s*(.+?)\\s*$", text, re.MULTILINE):
        raw = match.group(1).strip()
        parts = raw.split()
        if len(parts) < 2:
            continue
        source, target = parts[0], parts[1]
        options = parts[3] if len(parts) > 3 else ""
        record = {
            "source": source,
            "target": target,
            "readOnly": "ro" in options.split(","),
            "raw": raw,
        }
        if source.startswith("/dev/"):
            device_paths.append(record)
        else:
            mount_points.append(record)

    return {
        "network": config_value("lxc.net.0.link") or str(metadata.get("network") or ""),
        "macAddress": config_value("lxc.net.0.hwaddr"),
        "startOnBoot": config_value("lxc.start.auto") != "0",
        "ipv4Mode": mode,
        "ipv4Address": configured_address,
        "gateway": configured_gateway,
        "dns": ", ".join(configured_dns),
        "networkSettingsSource": settings_source,
        "liveIpv4Address": live_address,
        "liveGateway": configured_gateway if routed_next_hop and live_gateway == routed_next_hop else live_gateway,
        "liveNextHop": live_gateway if routed_next_hop and live_gateway == routed_next_hop else "",
        "liveDns": ", ".join(live_dns),
        "storageId": str(metadata.get("storageId") or ""),
        "diskGiB": int(metadata.get("diskGiB") or 0),
        "imageId": str(metadata.get("imageId") or ""),
        "rootfsPath": str(rootfs or ""),
        "extraNics": extra_nics,
        "mountPoints": mount_points,
        "devicePaths": device_paths,
        "unprivileged": config_value("lxc.idmap") != "",
        "nesting": "nesting=1" in text,
        "ttyCount": config_value("lxc.tty.max") or "",
        "consolePath": config_value("lxc.console.path") or "",
    }


def container_records(fast: bool = False) -> list[dict]:
    names: list[str] = []
    # The web container list must not wait on liblxc. Read the authoritative
    # control directories first; lxc-ls is only a compatibility fallback for
    # hosts whose control path is not readable.
    try:
        names = sorted(
            item.name for item in Path("/var/lib/lxc").iterdir()
            if item.is_dir() and NAME_RE.fullmatch(item.name) and (item / "config").is_file()
        )
    except OSError:
        names = []
    if not names and available("lxc-ls"):
        try:
            names = [line.strip() for line in run(["lxc-ls", "-1"], timeout=5, check=False).splitlines() if NAME_RE.fullmatch(line.strip())]
        except Exception:
            names = []

    running: set[str] = set()
    if fast and names and available("lxc-ls"):
        try:
            running = {
                line.strip() for line in run(["lxc-ls", "--running", "-1"], timeout=2, check=False).splitlines()
                if NAME_RE.fullmatch(line.strip())
            }
        except Exception:
            running = set()

    containers = []
    for name in names:
        state = "running" if name in running else ("stopped" if fast else lxc_state(name))
        pid = None
        if not fast:
            try:
                raw_pid = run(["lxc-info", "-n", name, "-pH"], timeout=3, check=False)
                pid = int(raw_pid) if raw_pid.isdigit() else None
            except Exception:
                pass
        memory, cpus = container_limits(name)
        if fast and state == "running":
            # The summary endpoint powers the main Containers page, so it
            # still needs the live guest IP. Query only running guests and do
            # not repeat the slower state lookup performed by container_addresses().
            addresses = []
            try:
                values = run(["lxc-info", "-n", name, "-iH"], timeout=2, check=False).splitlines()
                for value in values:
                    value = value.strip()
                    try:
                        address = ipaddress.ip_address(value)
                    except ValueError:
                        continue
                    if not address.is_loopback and not address.is_link_local:
                        addresses.append(value)
            except Exception:
                addresses = []
        else:
            addresses = [] if fast else container_addresses(name)
        settings = container_settings(name)
        containers.append({
            "id": name, "name": name, "status": state, "pid": pid,
            "memory": memory, "cpus": cpus, "provider": "local-lxc",
            "addresses": addresses,
            "ipv4": next((value for value in addresses if ":" not in value), None) or str(settings.get("ipv4Address") or "").split("/", 1)[0] or None,
            **settings,
        })
    return containers


def container_summary() -> dict:
    restore_nested_routed_lan_routes()
    networks = local_networks()
    tools = all(available(name) for name in ["lxc-create", "lxc-start", "lxc-stop", "lxc-attach", "lxc-ls"])
    nested = in_container()
    nested_enabled = os.environ.get("LIGHTNAS_ALLOW_NESTED_LXC") == "1"
    reason = None
    if not tools:
        reason = "Native LXC tools are not installed."
    elif nested and not nested_enabled:
        reason = "LightNAS is inside another container and nested LXC has not been enabled."
    elif not networks:
        reason = "LightNAS internal container network is not ready yet."
    return {
        "available": tools and (not nested or nested_enabled) and bool(networks),
        "enabled": tools and (not nested or nested_enabled),
        "provider": "local-lxc",
        "reason": reason,
        "containers": container_records(fast=True),
        "images": [item for item in IMAGES if item.get("nested", True) or not nested],
        "networks": networks,
        "networkReady": bool(networks),
        "inventoryAvailable": Path("/var/lib/lxc").is_dir() or available("lxc-ls"),
        "storageRoot": "/var/lib/lxc",
        "diagnostics": {
            "nested": nested,
            "nestedEnabled": nested_enabled,
            "tools": tools,
            "bridges": networks,
            "cgroupWritable": True,
            "mountNamespace": True,
            "networkNamespace": True,
            "veth": True,
            "kvm": {"present": Path("/dev/kvm").exists(), "usable": False, "apiVersion": None, "error": None},
            "tun": Path("/dev/net/tun").exists(),
            "errors": [],
            "fast": True,
        },
    }


def container_inventory() -> dict:
    restore_nested_routed_lan_routes()
    ok, reason, diagnostics = container_capability()
    networks = local_networks()
    return {
        "available": ok,
        "enabled": ok,
        "provider": "local-lxc",
        "reason": reason,
        "containers": container_records(),
        "images": [item for item in IMAGES if item.get("nested", True) or not in_container()],
        "networks": networks,
        "networkReady": bool(networks),
        "inventoryAvailable": available("lxc-ls") or Path("/var/lib/lxc").is_dir(),
        "storageRoot": "/var/lib/lxc",
        "diagnostics": diagnostics,
    }


def local_networks() -> list[str]:
    # Native system containers always use a LightNAS-owned bridge. When
    # LightNAS itself runs in an LXC, never attach nested containers to the
    # libvirt virbr0 or to the hypervisor-provided uplink.
    result = []
    try:
        links = json.loads(run(["ip", "-j", "link", "show", "type", "bridge"], timeout=10) or "[]")
        for item in links:
            name = str(item.get("ifname") or "")
            flags = set(item.get("flags") or [])
            if IFACE_RE.fullmatch(name) and name != "docker0" and "UP" in flags:
                result.append(name)
    except Exception:
        pass

    state = lightnas_network_state()
    if state.get("LIGHTNAS_NETWORK_MODE") in {"nested-macvlan", "nested-ipvlan"}:
        parent = str(state.get("LIGHTNAS_CONTAINER_PARENT") or state.get("LIGHTNAS_UPLINK") or "eth0")
        if IFACE_RE.fullmatch(parent) and Path("/sys/class/net", parent).exists():
            return [parent]
        return []
    if state.get("LIGHTNAS_NETWORK_MODE") == "lxc-nat":
        allowed = [name for name in ("lightnas0", "lxcbr0") if name in result]
        return allowed

    default_device = ""
    try:
        routes = json.loads(run(["ip", "-j", "-4", "route", "show", "default"], timeout=10, check=False) or "[]")
        default_device = str(routes[0].get("dev") or "") if routes else ""
    except Exception:
        pass
    preferred_order = [default_device, "virbr0", "lightnas0", "lxcbr0"]
    for preferred in reversed([name for name in preferred_order if name]):
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


def unique_container_mac() -> str:
    """Generate a locally administered unicast MAC not used by another LightNAS LXC."""
    used = set()
    try:
        for config in Path("/var/lib/lxc").glob("*/config"):
            match = re.search(r"^lxc\.net\.0\.hwaddr\s*=\s*([0-9A-Fa-f:]{17})\s*$", config.read_text(encoding="utf-8", errors="ignore"), re.MULTILINE)
            if match:
                used.add(match.group(1).lower())
    except OSError:
        pass
    for _attempt in range(64):
        raw = bytearray(os.urandom(6))
        raw[0] = (raw[0] | 0x02) & 0xFE
        value = ":".join(f"{part:02x}" for part in raw)
        if value not in used:
            return value
    raise RuntimeError("could not allocate a unique container MAC address")


def managed_container_ipv4_pool() -> tuple[ipaddress.IPv4Network, ipaddress.IPv4Address, ipaddress.IPv4Address, ipaddress.IPv4Address]:
    """Return the active LightNAS-managed IPv4 pool, preferring the host LAN pool."""
    state = lightnas_network_state()
    direct_mode = str(state.get("LIGHTNAS_NETWORK_MODE") or "") in {"nested-macvlan", "nested-ipvlan", "bridge"}
    try:
        if not direct_mode:
            raise ValueError("host LAN pool is only valid on direct-LAN container networking")
        subnet = ipaddress.ip_network(str(state.get("LIGHTNAS_CONTAINER_SUBNET") or ""), strict=False)
        start = ipaddress.ip_address(str(state.get("LIGHTNAS_CONTAINER_POOL_START") or ""))
        end = ipaddress.ip_address(str(state.get("LIGHTNAS_CONTAINER_POOL_END") or ""))
        gateway = ipaddress.ip_address(str(state.get("LIGHTNAS_CONTAINER_GATEWAY") or ""))
        if (
            isinstance(subnet, ipaddress.IPv4Network)
            and isinstance(start, ipaddress.IPv4Address)
            and isinstance(end, ipaddress.IPv4Address)
            and isinstance(gateway, ipaddress.IPv4Address)
            and start in subnet and end in subnet and gateway in subnet and int(start) <= int(end)
        ):
            return subnet, start, end, gateway
    except ValueError:
        pass
    return (
        ipaddress.ip_network("10.77.0.0/24"),
        ipaddress.ip_address("10.77.0.20"),
        ipaddress.ip_address("10.77.0.250"),
        ipaddress.ip_address("10.77.0.1"),
    )


def address_responds_on_host(candidate: str) -> bool:
    """Best-effort collision check before LightNAS assigns a managed LAN address."""
    try:
        neighbors = run(["ip", "neigh", "show", candidate], timeout=3, check=False).strip()
        if neighbors and "FAILED" not in neighbors and "INCOMPLETE" not in neighbors:
            return True
    except Exception:
        pass
    if available("ping"):
        try:
            probe = subprocess.run(
                ["ping", "-c", "1", "-W", "1", candidate],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=2,
                check=False,
            )
            return probe.returncode == 0
        except Exception:
            pass
    return False


def next_managed_container_ipv4(exclude: str = "") -> str:
    """Allocate the next free address from the LightNAS-managed container pool."""
    subnet, start, end, gateway = managed_container_ipv4_pool()
    state = lightnas_network_state()
    used = {
        str(gateway),
        str(state.get("LIGHTNAS_HOST_ADDRESS") or "").split("/", 1)[0],
    }
    try:
        for config in Path("/var/lib/lxc").glob("*/config"):
            if exclude and config.parent.name == exclude:
                continue
            settings = container_settings(config.parent.name)
            raw = str(settings.get("ipv4Address") or "").split("/", 1)[0]
            if raw:
                used.add(raw)
            for address in container_addresses(config.parent.name):
                if ":" not in address:
                    used.add(address)
    except Exception:
        pass

    candidate = start
    while int(candidate) <= int(end):
        text = str(candidate)
        if text not in used and candidate in subnet and not address_responds_on_host(text):
            return f"{text}/{subnet.prefixlen}"
        candidate += 1
    raise RuntimeError(f"LightNAS managed container pool {start}-{end} has no free IPv4 addresses")


def managed_container_storage_root(value: str) -> Path:
    path = Path(value or "/var/lib/lightnas/storage/local/rootdir").resolve()
    text = str(path)
    local_root = str(Path("/var/lib/lightnas/storage/local/rootdir").resolve())
    attached = re.compile(
        rf"{re.escape(os.sep)}\.lightnas{re.escape(os.sep)}storage{re.escape(os.sep)}"
        rf"[A-Za-z][A-Za-z0-9_-]{{1,31}}{re.escape(os.sep)}rootdir$"
    )
    if text != local_root and not attached.search(text):
        raise ValueError("container storage is outside a LightNAS-managed rootdir")
    path.mkdir(parents=True, exist_ok=True)
    return path


def container_layout(name: str, storage_root_value: str) -> tuple[Path, Path]:
    control = Path("/var/lib/lxc") / name
    storage_root = managed_container_storage_root(storage_root_value)
    rootfs = storage_root / name / "rootfs"
    return control, rootfs


def rootfs_from_config(config: Path) -> Path | None:
    try:
        text = config.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"^lxc\.rootfs\.path\s*=\s*(?:dir:)?(.+?)\s*$", text, re.MULTILINE)
    return Path(match.group(1)).resolve() if match else None


def managed_external_rootfs(path: Path | None, name: str) -> bool:
    if not path:
        return False
    text = str(path)
    return path.name == "rootfs" and path.parent.name == name and (
        text.startswith(str(Path("/var/lib/lightnas/storage/local/rootdir").resolve()) + os.sep)
        or re.search(
            rf"{re.escape(os.sep)}\.lightnas{re.escape(os.sep)}storage{re.escape(os.sep)}"
            rf"[A-Za-z][A-Za-z0-9_-]{{1,31}}{re.escape(os.sep)}rootdir{re.escape(os.sep)}"
            rf"{re.escape(name)}{re.escape(os.sep)}rootfs$",
            text,
        )
    )


def cleanup_container_path(name: str) -> None:
    path = Path("/var/lib/lxc") / name
    external_rootfs = rootfs_from_config(path / "config") if path.exists() else None
    subprocess.run(["lxc-stop", "-n", name, "-k"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["lxc-destroy", "-n", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    if managed_external_rootfs(external_rootfs, name) and external_rootfs.parent.exists():
        shutil.rmtree(external_rootfs.parent, ignore_errors=True)


def cleanup_failed_container(name: str, rootfs: Path) -> None:
    cleanup_container_path(name)
    if managed_external_rootfs(rootfs, name) and rootfs.parent.exists():
        shutil.rmtree(rootfs.parent, ignore_errors=True)


def bootstrap_deb_container(name: str, image: dict, storage_root_value: str) -> Path:
    if not available("debootstrap"):
        raise RuntimeError("debootstrap is not installed; rerun the LightNAS installer")
    base, rootfs = container_layout(name, storage_root_value)
    base.mkdir(parents=True, exist_ok=False)
    rootfs.mkdir(parents=True, exist_ok=False)

    # systemd-resolved is not present in every release/component combination.
    # A static resolv.conf is installed below, so DNS works without making the
    # whole container build fail on that optional split package.
    include = ",".join([
        "systemd-sysv", "iproute2",
        "iputils-ping", "ca-certificates", "netbase", "procps"
    ])
    architecture = native_debian_arch()
    args = [
        "debootstrap", "--variant=minbase", f"--arch={architecture}",
        f"--include={include}", image["release"], str(rootfs), debootstrap_mirror(image, architecture),
    ]
    try:
        run(args, timeout=1800)
    except Exception:
        cleanup_failed_container(name, rootfs)
        raise

    (rootfs / "etc" / "hostname").write_text(f"{name}\n", encoding="utf-8")
    (rootfs / "etc" / "hosts").write_text(
        f"127.0.0.1\tlocalhost\n127.0.1.1\t{name}\n::1\tlocalhost ip6-localhost ip6-loopback\n",
        encoding="utf-8",
    )
    resolv = rootfs / "etc" / "resolv.conf"
    try:
        if resolv.exists() or resolv.is_symlink():
            resolv.unlink()
        host_resolv = Path("/etc/resolv.conf")
        resolv.write_text(host_resolv.read_text(encoding="utf-8", errors="replace") if host_resolv.exists() else "nameserver 1.1.1.1\n", encoding="utf-8")
    except OSError:
        pass
    services = ["systemd-networkd.service"]
    if (rootfs / "usr" / "lib" / "systemd" / "system" / "systemd-resolved.service").exists():
        services.append("systemd-resolved.service")
    subprocess.run(
        ["systemctl", "--root", str(rootfs), "enable", *services],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    )
    machine_id = rootfs / "etc" / "machine-id"
    if machine_id.exists():
        machine_id.write_text("", encoding="utf-8")

    config = base / "config"
    config.write_text(
        "# LightNAS locally bootstrapped LXC system container\n"
        "lxc.include = /usr/share/lxc/config/common.conf\n"
        f"lxc.rootfs.path = dir:{rootfs}\n"
        f"lxc.uts.name = {name}\n",
        encoding="utf-8",
    )
    return config


def bootstrap_template_container(name: str, image: dict, storage_root_value: str) -> Path:
    template = str(image.get("template") or image["dist"])
    script = Path("/usr/share/lxc/templates") / f"lxc-{template}"
    if not script.exists():
        raise RuntimeError(f"local LXC template {template} is not installed")
    args = ["lxc-create", "-n", name, "-t", template, "--", "-r", image["release"]]
    if image.get("arch"):
        args += ["-a", str(image["arch"])]
    try:
        run(args, timeout=1800)
        config = Path("/var/lib/lxc") / name / "config"
        source_rootfs = rootfs_from_config(config) or (Path("/var/lib/lxc") / name / "rootfs")
        _control, target_rootfs = container_layout(name, storage_root_value)
        target_rootfs.parent.mkdir(parents=True, exist_ok=False)
        shutil.move(str(source_rootfs), str(target_rootfs))
        text = config.read_text(encoding="utf-8")
        text = re.sub(r"^lxc\.rootfs\.path\s*=.*$", f"lxc.rootfs.path = dir:{target_rootfs}", text, flags=re.MULTILINE)
        config.write_text(text, encoding="utf-8")
        return config
    except Exception:
        cleanup_container_path(name)
        raise


def managed_template_archive(value: str) -> Path:
    try:
        path = Path(value).resolve(strict=True)
    except OSError as exc:
        raise ValueError("container template archive is unavailable") from exc
    name = path.name.lower()
    if not path.is_file() or not any(name.endswith(suffix) for suffix in (".tar.zst", ".tar.xz", ".tar.gz", ".tgz")):
        raise ValueError("unsupported container template archive")
    text = str(path)
    legacy_root = str(Path("/var/lib/lightnas/templates").resolve())
    local_cache = str(Path("/var/lib/lightnas/storage/local/template/cache").resolve())
    legacy_marker = f"{os.sep}.lightnas{os.sep}template{os.sep}cache{os.sep}"
    storage_cache = re.compile(
        rf"{re.escape(os.sep)}\.lightnas{re.escape(os.sep)}storage{re.escape(os.sep)}"
        rf"[A-Za-z][A-Za-z0-9_-]{{1,31}}{re.escape(os.sep)}template{re.escape(os.sep)}cache{re.escape(os.sep)}"
    )
    if not (
        text.startswith(legacy_root + os.sep)
        or text.startswith(local_cache + os.sep)
        or legacy_marker in text
        or storage_cache.search(text)
    ):
        raise ValueError("template archive is outside a LightNAS-managed template cache")
    return path


def bootstrap_archive_container(name: str, archive_value: str, storage_root_value: str) -> Path:
    archive = managed_template_archive(archive_value)
    base, rootfs = container_layout(name, storage_root_value)
    base.mkdir(parents=True, exist_ok=False)
    rootfs.mkdir(parents=True, exist_ok=False)

    try:
        listing = run(["tar", "-taf", str(archive)], timeout=120)
        for entry in listing.splitlines():
            cleaned = entry.lstrip("./")
            if entry.startswith("/") or ".." in Path(cleaned).parts:
                raise ValueError("template archive contains an unsafe path")
        # Container template archives often contain character/block device
        # nodes under /dev. When LightNAS itself is running inside an
        # unprivileged Proxmox LXC, recreating those nodes with mknod is
        # intentionally blocked by the outer security boundary. They are not
        # needed in the stored rootfs: LXC supplies the runtime /dev mount when
        # the inner container starts. Skip archived /dev contents so template
        # installation works out of the box in both nested and bare-metal
        # LightNAS installations.
        run([
            "tar", "--numeric-owner", "--xattrs", "--xattrs-include=*",
            "--exclude=./dev/*", "--exclude=dev/*",
            "-xaf", str(archive), "-C", str(rootfs)
        ], timeout=1800)
        (rootfs / "dev").mkdir(mode=0o755, exist_ok=True)
    except Exception:
        cleanup_failed_container(name, rootfs)
        raise

    if not (rootfs / "etc").is_dir():
        cleanup_failed_container(name, rootfs)
        raise ValueError("template archive does not contain a Linux root filesystem")

    (rootfs / "etc" / "hostname").write_text(f"{name}\n", encoding="utf-8")
    hosts = rootfs / "etc" / "hosts"
    if not hosts.exists():
        hosts.write_text(
            f"127.0.0.1\tlocalhost\n127.0.1.1\t{name}\n::1\tlocalhost ip6-localhost ip6-loopback\n",
            encoding="utf-8",
        )

    if (rootfs / "usr" / "lib" / "systemd").exists() or (rootfs / "lib" / "systemd").exists():
        subprocess.run(
            ["systemctl", "--root", str(rootfs), "enable", "systemd-networkd.service"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )

    config = base / "config"
    config.write_text(
        "# LightNAS imported system-container template\n"
        "lxc.include = /usr/share/lxc/config/common.conf\n"
        f"lxc.rootfs.path = dir:{rootfs}\n"
        f"lxc.uts.name = {name}\n",
        encoding="utf-8",
    )
    return config


def configure_container_guest(config: Path, data: dict) -> None:
    rootfs = rootfs_from_config(config)
    if not rootfs or not rootfs.is_dir():
        raise RuntimeError("container root filesystem is unavailable")

    password = str(data.get("password") or "")
    if not (4 <= len(password) <= 128) or any(character in password for character in ("\r", "\n", ":")):
        raise ValueError("root password must contain 4-128 characters without colons or line breaks")
    result = subprocess.run(
        ["chroot", str(rootfs), "chpasswd"],
        input=f"root:{password}\n",
        text=True,
        capture_output=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"could not set the container root password: {(result.stderr or result.stdout).strip()[:300]}")

    mode = str(data.get("ipv4Mode") or "dhcp")
    address = str(data.get("ipv4Address") or "").strip()
    gateway = str(data.get("gateway") or "").strip()
    dns_values = [item.strip() for item in str(data.get("dns") or "").split(",") if item.strip()]
    if mode not in {"dhcp", "manual"}:
        raise ValueError("invalid container IPv4 mode")
    if mode == "manual":
        try:
            ipaddress.ip_interface(address)
            if gateway:
                ipaddress.ip_address(gateway)
            for item in dns_values:
                ipaddress.ip_address(item)
        except ValueError as exc:
            raise ValueError("invalid static IPv4 address, gateway, or DNS server") from exc

    routed_next_hop = ""
    systemd_present = (rootfs / "usr" / "lib" / "systemd").exists() or (rootfs / "lib" / "systemd").exists()
    if mode == "manual" and not systemd_present:
        raise ValueError("static networking currently requires a systemd-based container image")
    if systemd_present:
        # LightNAS owns eth0 configuration. Distribution templates may ship
        # ifupdown, NetworkManager, netplan, or an earlier networkd DHCP file.
        # Leaving two managers active creates two IPv4 leases on one interface.
        network_dir = rootfs / "etc" / "systemd" / "network"
        network_dir.mkdir(parents=True, exist_ok=True)
        for existing in network_dir.glob("*.network"):
            if existing.is_file() or existing.is_symlink():
                existing.unlink()

        interfaces = rootfs / "etc" / "network" / "interfaces"
        if interfaces.parent.exists():
            interfaces.write_text("auto lo\niface lo inet loopback\n", encoding="utf-8")
            interfaces_dropins = interfaces.parent / "interfaces.d"
            if interfaces_dropins.exists():
                for existing in interfaces_dropins.iterdir():
                    if existing.is_file() or existing.is_symlink():
                        existing.unlink()

        netplan_dir = rootfs / "etc" / "netplan"
        if netplan_dir.exists():
            for existing in netplan_dir.glob("*.yaml"):
                existing.unlink()
            for existing in netplan_dir.glob("*.yml"):
                existing.unlink()

        cloud_dir = rootfs / "etc" / "cloud" / "cloud.cfg.d"
        if cloud_dir.exists():
            (cloud_dir / "99-lightnas-network.cfg").write_text(
                "network: {config: disabled}\n", encoding="utf-8"
            )

        nm_dir = rootfs / "etc" / "NetworkManager" / "conf.d"
        if nm_dir.parent.exists():
            nm_dir.mkdir(parents=True, exist_ok=True)
            (nm_dir / "90-lightnas-unmanaged.conf").write_text(
                "[keyfile]\nunmanaged-devices=interface-name:eth0\n", encoding="utf-8"
            )

        subprocess.run(
            ["systemctl", "--root", str(rootfs), "disable", "NetworkManager.service", "networking.service"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        subprocess.run(
            ["systemctl", "--root", str(rootfs), "enable", "systemd-networkd.service"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )

        # Every container gets its own machine identity. Imported/cloned rootfs
        # archives commonly carry the same /etc/machine-id, which can make
        # DHCP servers hand multiple containers the same lease.
        machine_id = os.urandom(16).hex()
        (rootfs / "etc" / "machine-id").write_text(machine_id + "\n", encoding="utf-8")
        dbus_machine_id = rootfs / "var" / "lib" / "dbus" / "machine-id"
        if dbus_machine_id.parent.exists() and not dbus_machine_id.is_symlink():
            dbus_machine_id.write_text(machine_id + "\n", encoding="utf-8")

        network_lines = ["[Match]", "Name=eth0", "", "[Network]"]
        routed_next_hop = _nested_routed_guest_next_hop(address, gateway) if mode == "manual" else ""
        if mode == "dhcp":
            client_id = "duid" if lightnas_network_state().get("LIGHTNAS_NETWORK_MODE") == "nested-ipvlan" else "mac"
            network_lines += ["DHCP=ipv4", "IPv6AcceptRA=yes", "", "[DHCPv4]", f"ClientIdentifier={client_id}"]
        elif routed_next_hop:
            routed_address = f"{ipaddress.ip_interface(address).ip}/32"
            network_lines.append(f"Address={routed_address}")
            for item in dns_values:
                network_lines.append(f"DNS={item}")
            network_lines += [
                "",
                "[Route]",
                f"Destination={routed_next_hop}/32",
                "Scope=link",
                "",
                "[Route]",
                "Destination=0.0.0.0/0",
                f"Gateway={routed_next_hop}",
                "GatewayOnLink=yes",
            ]
        else:
            network_lines.append(f"Address={address}")
            if gateway:
                network_lines.append(f"Gateway={gateway}")
            for item in dns_values:
                network_lines.append(f"DNS={item}")
        (network_dir / "10-lightnas-eth0.network").write_text("\n".join(network_lines) + "\n", encoding="utf-8")

    metadata = {
        "storageId": str(data.get("storageId") or ""),
        "diskGiB": int(data.get("diskGiB") or 0),
        "network": str(data.get("network") or ""),
        "imageId": str(data.get("image") or ""),
        "templateFile": Path(str(data.get("templatePath") or "")).name,
        "ipv4Mode": mode,
        "ipv4Address": address,
        "gateway": gateway,
        "dns": ", ".join(dns_values),
        "routedLanNextHop": routed_next_hop if mode == "manual" else "",
        "createdBy": "LightNAS",
    }
    (config.parent / "lightnas.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")



def verify_container_installation(config: Path, image: dict | None, template_path: str) -> dict:
    rootfs = rootfs_from_config(config)
    if not rootfs or not rootfs.is_dir():
        raise RuntimeError("the selected image did not create a container root filesystem")
    shell = rootfs / "bin" / "sh"
    release_file = rootfs / "etc" / "os-release"
    if not shell.exists() or not release_file.is_file():
        raise RuntimeError("the selected image is incomplete: /bin/sh or /etc/os-release is missing")

    values = {}
    for row in release_file.read_text(encoding="utf-8", errors="replace").splitlines():
        if "=" not in row:
            continue
        key, value = row.split("=", 1)
        values[key] = value.strip().strip('"').strip("'")
    actual_id = values.get("ID", "").lower()
    id_like = set(values.get("ID_LIKE", "").lower().split())
    if image:
        expected = str(image.get("dist") or "").lower()
        if expected and expected != actual_id and expected not in id_like:
            raise RuntimeError(
                f"selected image verification failed: expected {expected}, installed {actual_id or 'unknown'}"
            )
    return {
        "id": actual_id or "linux",
        "name": values.get("PRETTY_NAME") or values.get("NAME") or (Path(template_path).name if template_path else "Linux"),
        "version": values.get("VERSION_ID") or values.get("VERSION_CODENAME") or "",
    }



def kick_container_dhcp(name: str) -> None:
    """Make a DHCP-configured guest actively request/renew an IPv4 lease."""
    commands = [
        ["lxc-attach", "-n", name, "--", "ip", "link", "set", "eth0", "up"],
        ["lxc-attach", "-n", name, "--", "systemctl", "restart", "systemd-networkd.service"],
        ["lxc-attach", "-n", name, "--", "networkctl", "reload"],
        ["lxc-attach", "-n", name, "--", "networkctl", "reconfigure", "eth0"],
    ]
    for args in commands:
        try:
            run(args, timeout=20, check=False)
        except Exception:
            pass


def clear_managed_automatic_address(config: Path) -> None:
    """Remove LightNAS host-injected automatic IPv4 fallback settings."""
    if not config.exists():
        return
    current = config.read_text(encoding="utf-8")
    kept = [
        row for row in current.splitlines()
        if row.split("=", 1)[0].strip() not in {
            "lxc.net.0.ipv4.address",
            "lxc.net.0.ipv4.gateway",
        }
    ]
    config.write_text("\n".join(kept) + "\n", encoding="utf-8")


def apply_managed_automatic_address(name: str, config: Path) -> str:
    """Apply the LightNAS-managed address without modifying the appliance IP."""
    address = next_managed_container_ipv4(name)
    _subnet, _start, _end, gateway = managed_container_ipv4_pool()
    gateway_text = str(gateway)
    clear_managed_automatic_address(config)

    # Persist the managed fallback inside systemd-networkd. The LightNAS UI
    # still records this as DHCP/Automatic; this file is only the deterministic
    # fallback used when nested DHCP broadcasts do not work.
    # The LightNAS UI still records this as DHCP/Automatic; this file is only
    # the deterministic fallback used when nested DHCP broadcasts do not work.
    rootfs = rootfs_from_config(config)
    if rootfs and rootfs.is_dir():
        network_dir = rootfs / "etc" / "systemd" / "network"
        network_dir.mkdir(parents=True, exist_ok=True)
        fallback_lines = [
            "[Match]",
            "Name=eth0",
            "",
            "[Network]",
            f"Address={address}",
            f"Gateway={gateway_text}",
            f"DNS={gateway_text}",
            "IPv6AcceptRA=yes",
        ]
        (network_dir / "10-lightnas-eth0.network").write_text(
            "\n".join(fallback_lines) + "\n",
            encoding="utf-8",
        )

    if lxc_state(name) == "running":
        run(["lxc-stop", "-n", name, "-t", "20"], timeout=35, check=False)
    run(["lxc-start", "-n", name, "-d"], timeout=60)
    bare = address.split("/", 1)[0]
    try:
        run(["lxc-attach", "-n", name, "--", "ip", "addr", "replace", address, "dev", "eth0"], timeout=10, check=False)
        run(["lxc-attach", "-n", name, "--", "ip", "route", "replace", "default", "via", gateway_text, "dev", "eth0"], timeout=10, check=False)
    except Exception:
        pass
    return bare



def sanitize_nested_lxc_network(config: Path) -> bool:
    """Remove host-side static IPv4 directives that can abort nested LXC boot."""
    if not in_container() or not config.exists():
        return False
    current = config.read_text(encoding="utf-8")
    kept = [
        row for row in current.splitlines()
        if row.split("=", 1)[0].strip() not in {
            "lxc.net.0.ipv4.address",
            "lxc.net.0.ipv4.gateway",
        }
    ]
    cleaned = "\n".join(kept) + "\n"
    if cleaned == current:
        return False
    config.write_text(cleaned, encoding="utf-8")
    return True



def _nested_routed_lan_context(address: str, gateway: str) -> dict | None:
    """Return routed-LAN details when a nested LightNAS LXC is using the NAT bridge."""
    state = lightnas_network_state()
    if not in_container() or str(state.get("LIGHTNAS_NETWORK_MODE") or "") != "lxc-nat":
        return None
    try:
        interface = ipaddress.ip_interface(str(address or "").strip())
        gateway_ip = ipaddress.ip_address(str(gateway or "").strip())
    except ValueError:
        return None
    if not isinstance(interface, ipaddress.IPv4Interface) or not isinstance(gateway_ip, ipaddress.IPv4Address):
        return None
    if gateway_ip not in interface.network:
        return None

    uplink = str(state.get("LIGHTNAS_UPLINK") or "").strip()
    bridge = str(state.get("LIGHTNAS_CONTAINER_BRIDGE") or "lightnas0").strip()
    if not IFACE_RE.fullmatch(uplink) or not IFACE_RE.fullmatch(bridge):
        return None
    if not Path("/sys/class/net", uplink).exists() or not Path("/sys/class/net", bridge).exists():
        return None

    try:
        addresses = json.loads(run(["ip", "-j", "-4", "addr", "show", "dev", uplink], timeout=5, check=False) or "[]")
        host_ips = []
        for item in addresses:
            for info in item.get("addr_info") or []:
                if info.get("family") == "inet" and info.get("local"):
                    host_ips.append(ipaddress.ip_address(str(info["local"])))
        if not any(host_ip in interface.network for host_ip in host_ips):
            return None
    except Exception:
        return None

    return {
        "address": interface,
        "host": str(interface.ip),
        "network": interface.network,
        "gateway": str(gateway_ip),
        "uplink": uplink,
        "bridge": bridge,
    }


def _nested_routed_guest_next_hop(address: str, gateway: str) -> str:
    """Return the LightNAS bridge IPv4 used as the inner container's next hop."""
    context = _nested_routed_lan_context(address, gateway)
    if not context:
        return ""
    bridge = context["bridge"]
    try:
        rows = json.loads(run(["ip", "-j", "-4", "addr", "show", "dev", bridge], timeout=5, check=False) or "[]")
        for row in rows:
            for info in row.get("addr_info") or []:
                value = str(info.get("local") or "").strip()
                if info.get("family") == "inet" and value:
                    parsed = ipaddress.ip_address(value)
                    if isinstance(parsed, ipaddress.IPv4Address):
                        return value
    except Exception:
        pass
    # Standard LightNAS private bridge fallback.
    return "10.77.0.1"


def ensure_nested_routed_lan(address: str, gateway: str) -> bool:
    """
    Keep a nested system container on the appliance's real LAN even when the
    outer Proxmox LXC cannot create macvlan/ipvlan interfaces.

    The inner LXC remains connected to the LightNAS-owned bridge, while
    LightNAS routes the requested /32 through that bridge and answers ARP on
    both sides. Upstream Ethernet therefore continues to use the appliance's
    permitted outer-LXC MAC address instead of requiring another MAC behind it.
    """
    context = _nested_routed_lan_context(address, gateway)
    if not context:
        return False

    host = context["host"]
    gateway_ip = context["gateway"]
    uplink = context["uplink"]
    bridge = context["bridge"]

    # Enable routed forwarding and proxy ARP now.
    for path, value in (
        (Path("/proc/sys/net/ipv4/ip_forward"), "1"),
        (Path(f"/proc/sys/net/ipv4/conf/{uplink}/proxy_arp"), "1"),
        (Path(f"/proc/sys/net/ipv4/conf/{bridge}/proxy_arp"), "1"),
        (Path(f"/proc/sys/net/ipv4/conf/{uplink}/rp_filter"), "0"),
        (Path(f"/proc/sys/net/ipv4/conf/{bridge}/rp_filter"), "0"),
    ):
        try:
            path.write_text(value + "\n", encoding="utf-8")
        except OSError:
            pass

    # Persist the forwarding behavior across LightNAS restarts/reboots.
    sysctl_path = Path("/etc/sysctl.d/99-lightnas-routed-containers.conf")
    try:
        sysctl_path.write_text(
            "\n".join([
                "# LightNAS nested-LXC routed LAN compatibility",
                "net.ipv4.ip_forward = 1",
                f"net.ipv4.conf.{uplink}.proxy_arp = 1",
                f"net.ipv4.conf.{bridge}.proxy_arp = 1",
                f"net.ipv4.conf.{uplink}.rp_filter = 0",
                f"net.ipv4.conf.{bridge}.rp_filter = 0",
                "",
            ]),
            encoding="utf-8",
        )
    except OSError:
        pass

    # Route this exact LAN IP toward the inner LXC bridge. Explicit proxy-neigh
    # entries make ARP deterministic even though both sides use the same /24.
    run(["ip", "route", "replace", f"{host}/32", "dev", bridge, "scope", "link"], timeout=10, check=False)
    run(["ip", "neigh", "replace", "proxy", host, "dev", uplink], timeout=10, check=False)
    run(["ip", "neigh", "replace", "proxy", gateway_ip, "dev", bridge], timeout=10, check=False)

    # Preserve existing firewall policy, but add narrowly scoped forwarding
    # rules when iptables is available. These rules allow only this container IP.
    if available("iptables"):
        rules = [
            ["FORWARD", "-i", bridge, "-o", uplink, "-s", f"{host}/32", "-j", "ACCEPT"],
            ["FORWARD", "-i", uplink, "-o", bridge, "-d", f"{host}/32", "-j", "ACCEPT"],
        ]
        for rule in rules:
            check = subprocess.run(["iptables", "-C", *rule], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if check.returncode != 0:
                subprocess.run(["iptables", "-I", *rule], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)

        # The outer Proxmox LXC may enforce source-IP anti-spoofing and reject
        # Internet traffic sourced directly from the inner container's LAN IP.
        # Masquerade only traffic leaving the configured LAN; local LAN traffic
        # keeps the container's 192.168.x.x identity and proxy-ARP route.
        lan_cidr = str(context["network"])
        nat_rule = [
            "POSTROUTING", "-s", f"{host}/32", "!", "-d", lan_cidr,
            "-o", uplink, "-j", "MASQUERADE",
        ]
        check = subprocess.run(
            ["iptables", "-t", "nat", "-C", *nat_rule],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        if check.returncode != 0:
            subprocess.run(
                ["iptables", "-t", "nat", "-I", *nat_rule],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            )

    return True


def restore_nested_routed_lan_routes() -> None:
    """Reapply /32 and proxy-ARP state for saved static LAN containers."""
    state = lightnas_network_state()
    if str(state.get("LIGHTNAS_NETWORK_MODE") or "") != "lxc-nat":
        return
    try:
        container_dirs = list(Path("/var/lib/lxc").iterdir())
    except OSError:
        return
    for container_dir in container_dirs:
        if not container_dir.is_dir() or not NAME_RE.fullmatch(container_dir.name):
            continue
        try:
            settings = container_settings(container_dir.name)
            if str(settings.get("ipv4Mode") or "") != "manual":
                continue
            address = str(settings.get("ipv4Address") or "").strip()
            gateway = str(settings.get("gateway") or "").strip()
            if address and gateway:
                ensure_nested_routed_lan(address, gateway)
        except Exception:
            continue



def create_container(data: dict) -> dict:
    ok, reason, _diagnostics = container_capability()
    if not ok:
        raise RuntimeError(reason)
    name = str(data.get("name") or "").strip()
    image_id = str(data.get("image") or "").strip()
    template_path = str(data.get("templatePath") or "").strip()
    storage_root_value = str(data.get("storageRoot") or "").strip()
    requested_network = str(data.get("network") or "").strip()
    networks = local_networks()
    network_state = lightnas_network_state()
    nested_mode = str(network_state.get("LIGHTNAS_NETWORK_MODE") or "")
    nested_direct = nested_mode in {"nested-macvlan", "nested-ipvlan"}
    nested_nat = nested_mode == "lxc-nat"
    if nested_direct:
        # In a nested Proxmox LightNAS appliance, container networking is not
        # a per-app choice. Every new system container uses the already-working
        # outer LAN uplink and DHCP, just like creating an LXC directly in
        # Proxmox. This keeps the appliance management IP untouched.
        network = str(network_state.get("LIGHTNAS_CONTAINER_PARENT") or network_state.get("LIGHTNAS_UPLINK") or "eth0")
        data = {
            **data,
            "network": network,
            "ipv4Mode": "dhcp",
            "ipv4Address": "",
            "gateway": "",
            "dns": "",
            "vlanTag": None,
        }
    elif nested_nat:
        # The UI intentionally exposes the appliance LAN uplink (for example
        # eth0). The nested LXC itself must still attach to LightNAS's internal
        # bridge; routed/proxy-ARP mode makes a user-selected LAN address
        # reachable without moving the appliance management address.
        uplink = str(network_state.get("LIGHTNAS_UPLINK") or "eth0")
        internal_bridge = str(network_state.get("LIGHTNAS_CONTAINER_BRIDGE") or "lightnas0")
        if requested_network and requested_network not in {uplink, internal_bridge}:
            raise ValueError("selected container network is not available")
        network = internal_bridge
        data = {**data, "network": uplink}
    else:
        network = requested_network if requested_network in networks else (networks[0] if networks else "")
    try:
        memory = int(data.get("memoryMiB") or 2048)
        cpus = int(data.get("cpus") or 2)
        disk_gib = int(data.get("diskGiB") or 8)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid container resource values") from exc
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid container name")
    image = IMAGE_BY_ID.get(image_id)
    if not template_path and (not image or (in_container() and not image.get("nested", True))):
        raise ValueError("select a Linux system-container image or imported LightNAS template")
    valid_nested_nat_bridge = nested_nat and network == str(network_state.get("LIGHTNAS_CONTAINER_BRIDGE") or "lightnas0")
    if not network or not IFACE_RE.fullmatch(network) or (network not in networks and not valid_nested_nat_bridge):
        raise ValueError("no active local container bridge is available")
    host_cpus = max(1, os.cpu_count() or 1)
    if not (256 <= memory <= 65536 and 1 <= cpus <= min(32, host_cpus) and 2 <= disk_gib <= 2048):
        raise ValueError("container CPU, memory, or disk values are outside host limits")
    managed_container_storage_root(storage_root_value)

    container_path = Path("/var/lib/lxc") / name
    if container_path.exists():
        # Failed image downloads commonly leave a partial directory behind.
        # Remove only clearly incomplete containers; never destroy an existing
        # valid container implicitly.
        partial = (container_path / "partial").exists()
        existing_rootfs = rootfs_from_config(container_path / "config")
        valid = (container_path / "config").exists() and bool(existing_rootfs and existing_rootfs.exists())
        if partial or not valid:
            cleanup_container_path(name)
        else:
            raise ValueError("a container with this name already exists")

    if template_path:
        config = bootstrap_archive_container(name, template_path, storage_root_value)
    elif image.get("builder") == "debootstrap":
        config = bootstrap_deb_container(name, image, storage_root_value)
    else:
        config = bootstrap_template_container(name, image, storage_root_value)

    try:
        configure_container_guest(config, data)
        installed_guest = verify_container_installation(config, image, template_path)
    except Exception:
        rootfs = rootfs_from_config(config)
        if rootfs:
            cleanup_failed_container(name, rootfs)
        raise
    append_unique(config, f"lxc.start.auto = {1 if data.get('startOnBoot', True) else 0}")
    append_unique(config, f"lxc.cgroup2.memory.max = {memory * 1024 * 1024}")
    append_unique(config, f"lxc.cgroup2.cpu.max = {cpus * 100000} 100000")
    direct_lan = (
        nested_direct
        and network == str(network_state.get("LIGHTNAS_CONTAINER_PARENT") or network_state.get("LIGHTNAS_UPLINK") or "eth0")
    )
    direct_type = "macvlan" if nested_mode == "nested-macvlan" else ("ipvlan" if nested_mode == "nested-ipvlan" else "veth")
    append_unique(config, f"lxc.net.0.type = {direct_type if direct_lan else 'veth'}")
    append_unique(config, f"lxc.net.0.link = {network}")
    if direct_lan and direct_type == "macvlan":
        append_unique(config, "lxc.net.0.macvlan.mode = bridge")
    if direct_lan and direct_type == "ipvlan":
        append_unique(config, "lxc.net.0.ipvlan.mode = l2")
    append_unique(config, "lxc.net.0.flags = up")
    append_unique(config, "lxc.net.0.name = eth0")
    vlan_tag = data.get("vlanTag")
    if direct_lan and vlan_tag is not None:
        raise ValueError("nested LAN containers inherit the outer uplink VLAN; do not set a second VLAN tag")
    if vlan_tag is not None:
        try:
            vlan_tag = int(vlan_tag)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid VLAN tag") from exc
        if not 1 <= vlan_tag <= 4094:
            raise ValueError("invalid VLAN tag")
        append_unique(config, f"lxc.net.0.vlan.id = {vlan_tag}")
    mac_address = str(data.get("macAddress") or "").strip()
    if mac_address:
        if not re.fullmatch(r"(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}", mac_address):
            raise ValueError("invalid container MAC address")
    else:
        mac_address = unique_container_mac()
    append_unique(config, f"lxc.net.0.hwaddr = {mac_address.lower()}")
    if in_container():
        # The outer appliance container remains the security boundary. Avoid
        # inner AppArmor profile loading, which is commonly blocked in nested
        # Proxmox/LXC environments even when namespaces/cgroups are delegated.
        append_unique(config, "lxc.apparmor.profile = unconfined")

    clear_managed_automatic_address(config)
    sanitize_nested_lxc_network(config)

    routed_lan = False
    if str(data.get("ipv4Mode") or "dhcp") == "manual":
        routed_lan = ensure_nested_routed_lan(
            str(data.get("ipv4Address") or ""),
            str(data.get("gateway") or ""),
        )

    try:
        run(["lxc-start", "-n", name, "-d"], timeout=60)
    except Exception as start_error:
        # Keep a completely built rootfs for troubleshooting rather than
        # deleting user data after an image was successfully created. Capture
        # the real LXC boot blocker so the web UI does not only show ABORTING.
        log_path = Path("/run/lightnas") / f"lxc-{name}-start.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(
                ["lxc-start", "-n", name, "-F", "-l", "DEBUG", "-o", str(log_path)],
                text=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=20,
                check=False,
            )
        except subprocess.TimeoutExpired:
            subprocess.run(["lxc-stop", "-n", name, "-k"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        detail = ""
        try:
            lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
            useful = [
                line.strip() for line in lines
                if re.search(r"(ERROR|Failed|Permission denied|Operation not permitted|No such file|exec|mount|apparmor|cgroup|hook)", line, re.IGNORECASE)
            ]
            detail = " | ".join(useful[-5:])[:1200]
        except OSError:
            pass
        message = f"container {name} was built but could not start"
        if detail:
            message += f": {detail}"
        else:
            message += f": {start_error}"
        raise RuntimeError(message) from start_error

    managed_pool_direct = direct_lan and bool(network_state.get("LIGHTNAS_CONTAINER_POOL_START")) and bool(network_state.get("LIGHTNAS_CONTAINER_POOL_END"))
    if str(data.get("ipv4Mode") or "dhcp") == "dhcp" and not managed_pool_direct:
        kick_container_dhcp(name)

    ipv4 = ""
    default_route = ""
    automatic_fallback = False
    managed_pool_assignment = False
    if managed_pool_direct:
        ipv4 = apply_managed_automatic_address(name, config)
        managed_pool_assignment = True
    # DHCP is always attempted first. Nested hypervisors can occasionally pass
    # veth traffic while dropping DHCP broadcasts; LightNAS then guarantees an
    # automatic address from its own managed pool without changing the user's
    # IPv4 mode to Static.
    dhcp_mode = str(data.get("ipv4Mode") or "dhcp") == "dhcp"
    for _attempt in range(20 if dhcp_mode else 30):
        addresses = [address for address in container_addresses(name) if ":" not in address]
        discovered = next((address for address in addresses if not direct_lan or not address.startswith("10.77.0.")), "")
        if discovered:
            ipv4 = discovered
        if ipv4:
            try:
                default_route = run(
                    ["lxc-attach", "-n", name, "--", "ip", "-4", "route", "show", "default"],
                    timeout=5,
                    check=False,
                ).strip()
            except Exception:
                default_route = ""
            if default_route:
                break
        time.sleep(1)

    if not ipv4 and dhcp_mode and network_state.get("LIGHTNAS_NETWORK_MODE") == "lxc-nat":
        ipv4 = apply_managed_automatic_address(name, config)
        automatic_fallback = True
        for _attempt in range(10):
            addresses = [address for address in container_addresses(name) if ":" not in address]
            ipv4 = next((address for address in addresses if address.startswith("10.77.0.")), ipv4)
            try:
                default_route = run(
                    ["lxc-attach", "-n", name, "--", "ip", "-4", "route", "show", "default"],
                    timeout=5,
                    check=False,
                ).strip()
            except Exception:
                default_route = ""
            if ipv4 and default_route:
                break
            time.sleep(1)

    if not ipv4:
        raise RuntimeError(f"container {name} started but automatic IPv4 configuration failed")
    if not default_route:
        raise RuntimeError(f"container {name} received {ipv4} but automatic default-route configuration failed")

    return {
        "id": name,
        "name": name,
        "status": "running",
        "provider": "local-lxc",
        "image": image_id,
        "installedImage": Path(template_path).name if template_path else image.get("label"),
        "guestOs": installed_guest,
        "verified": True,
        "builder": "archive" if template_path else image.get("builder"),
        "storageId": str(data.get("storageId") or ""),
        "diskGiB": disk_gib,
        "network": network,
        "ipv4": ipv4 or (container_addresses(name)[0] if container_addresses(name) else ""),
        "defaultRoute": default_route,
        "networkMode": "direct-lan" if direct_lan else ("routed-lan" if routed_lan else "managed"),
        "automaticFallback": automatic_fallback,
        "managedLanPool": managed_pool_assignment,
    }


def repair_container_network(name: str) -> dict:
    config = Path("/var/lib/lxc") / name / "config"
    if not config.exists():
        raise ValueError("unknown local LXC container")
    rootfs = rootfs_from_config(config)
    if not rootfs or not rootfs.is_dir():
        raise RuntimeError("container root filesystem is unavailable")

    state = lightnas_network_state()
    settings = container_settings(name)
    metadata_path = config.parent / "lightnas.json"
    metadata = {}
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        pass

    # New containers are DHCP by default. Legacy LightNAS builds silently
    # converted DHCP requests to a private static 10.77.0.x address; those
    # records have no ipv4Mode metadata and are restored to DHCP here.
    explicit_manual = metadata.get("ipv4Mode") == "manual"
    mode = "manual" if explicit_manual else "dhcp"

    network_dir = rootfs / "etc" / "systemd" / "network"
    network_dir.mkdir(parents=True, exist_ok=True)
    for existing in network_dir.glob("*.network"):
        if existing.is_file() or existing.is_symlink():
            existing.unlink()

    direct_mode = str(state.get("LIGHTNAS_NETWORK_MODE") or "")
    direct_lan = direct_mode in {"nested-macvlan", "nested-ipvlan"}
    if direct_lan:
        parent = str(state.get("LIGHTNAS_CONTAINER_PARENT") or state.get("LIGHTNAS_UPLINK") or "eth0")
        direct_type = "macvlan" if direct_mode == "nested-macvlan" else "ipvlan"
        append_unique(config, f"lxc.net.0.type = {direct_type}")
        append_unique(config, f"lxc.net.0.link = {parent}")
        if direct_type == "macvlan":
            append_unique(config, "lxc.net.0.macvlan.mode = bridge")
        else:
            append_unique(config, "lxc.net.0.ipvlan.mode = l2")
        append_unique(config, "lxc.net.0.flags = up")
        append_unique(config, "lxc.net.0.name = eth0")
    elif state.get("LIGHTNAS_NETWORK_MODE") == "lxc-nat":
        append_unique(config, "lxc.net.0.type = veth")
        append_unique(config, "lxc.net.0.link = lightnas0")

    lines = ["[Match]", "Name=eth0", "", "[Network]"]
    if mode == "manual":
        address = str(settings.get("ipv4Address") or "").strip()
        gateway = str(settings.get("gateway") or "").strip()
        dns_values = [item.strip() for item in str(settings.get("dns") or "").split(",") if item.strip()]
        if not address:
            raise RuntimeError("container is marked static but has no IPv4 address configured")
        routed_next_hop = _nested_routed_guest_next_hop(address, gateway)
        if routed_next_hop:
            append_unique(config, "lxc.net.0.type = veth")
            append_unique(config, "lxc.net.0.link = lightnas0")
            routed_address = f"{ipaddress.ip_interface(address).ip}/32"
            lines.append(f"Address={routed_address}")
            for item in dns_values:
                lines.append(f"DNS={item}")
            lines += [
                "",
                "[Route]",
                f"Destination={routed_next_hop}/32",
                "Scope=link",
                "",
                "[Route]",
                "Destination=0.0.0.0/0",
                f"Gateway={routed_next_hop}",
                "GatewayOnLink=yes",
            ]
            metadata["routedLanNextHop"] = routed_next_hop
            ensure_nested_routed_lan(address, gateway)
        else:
            lines.append(f"Address={address}")
            if gateway:
                lines.append(f"Gateway={gateway}")
            for item in dns_values:
                lines.append(f"DNS={item}")
    else:
        append_unique(config, f"lxc.net.0.hwaddr = {unique_container_mac()}")
        machine_id = os.urandom(16).hex()
        (rootfs / "etc" / "machine-id").write_text(machine_id + "\n", encoding="utf-8")
        dbus_machine_id = rootfs / "var" / "lib" / "dbus" / "machine-id"
        if dbus_machine_id.parent.exists() and not dbus_machine_id.is_symlink():
            dbus_machine_id.write_text(machine_id + "\n", encoding="utf-8")
        lines += ["DHCP=ipv4", "IPv6AcceptRA=yes", "", "[DHCPv4]", "ClientIdentifier=mac"]
        metadata["ipv4Mode"] = "dhcp"

    try:
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass

    (network_dir / "10-lightnas-eth0.network").write_text("\n".join(lines) + "\n", encoding="utf-8")
    subprocess.run(
        ["systemctl", "--root", str(rootfs), "disable", "NetworkManager.service", "networking.service"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    )
    subprocess.run(
        ["systemctl", "--root", str(rootfs), "enable", "systemd-networkd.service"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    )

    if mode == "dhcp":
        clear_managed_automatic_address(config)

    if lxc_state(name) == "running":
        run(["lxc-stop", "-n", name, "-t", "20"], timeout=35, check=False)
    run(["lxc-start", "-n", name, "-d"], timeout=60)
    managed_pool_assignment = False
    if mode == "dhcp" and direct_lan and state.get("LIGHTNAS_CONTAINER_POOL_START") and state.get("LIGHTNAS_CONTAINER_POOL_END"):
        ipv4 = apply_managed_automatic_address(name, config)
        managed_pool_assignment = True
    else:
        ipv4 = ""
        if mode == "dhcp":
            kick_container_dhcp(name)

    default_route = ""
    automatic_fallback = False
    for _attempt in range(20 if mode == "dhcp" else 30):
        ipv4 = next((value for value in container_addresses(name) if ":" not in value), "")
        if ipv4:
            try:
                default_route = run(
                    ["lxc-attach", "-n", name, "--", "ip", "-4", "route", "show", "default"],
                    timeout=5,
                    check=False,
                ).strip()
            except Exception:
                default_route = ""
            if default_route:
                break
        time.sleep(1)
    if not ipv4 and mode == "dhcp" and state.get("LIGHTNAS_NETWORK_MODE") == "lxc-nat":
        ipv4 = apply_managed_automatic_address(name, config)
        automatic_fallback = True
        for _attempt in range(10):
            ipv4 = next((value for value in container_addresses(name) if value.startswith("10.77.0.")), ipv4)
            try:
                default_route = run(
                    ["lxc-attach", "-n", name, "--", "ip", "-4", "route", "show", "default"],
                    timeout=5,
                    check=False,
                ).strip()
            except Exception:
                default_route = ""
            if ipv4 and default_route:
                break
            time.sleep(1)

    if not ipv4:
        raise RuntimeError(f"container {name} automatic IPv4 configuration failed")
    if not default_route:
        raise RuntimeError(f"container {name} received {ipv4} but automatic default-route configuration failed")
    return {
        "id": name, "action": "repair-network", "status": "running",
        "ipv4": ipv4, "ipv4Mode": mode, "defaultRoute": default_route,
        "networkMode": "direct-lan" if direct_lan else "managed",
        "automaticFallback": automatic_fallback,
        "managedLanPool": managed_pool_assignment,
    }


def container_action(data: dict) -> dict:
    name = str(data.get("id") or data.get("name") or "").strip()
    action = str(data.get("action") or "")
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid container name")
    config = Path("/var/lib/lxc") / name / "config"
    if not config.exists():
        raise ValueError("unknown local LXC container")
    if action == "start":
        sanitize_nested_lxc_network(config)
        settings = container_settings(name)
        if str(settings.get("ipv4Mode") or "") == "manual":
            ensure_nested_routed_lan(str(settings.get("ipv4Address") or ""), str(settings.get("gateway") or ""))
        run(["lxc-start", "-n", name, "-d"], timeout=60)
    elif action in {"stop", "shutdown"}:
        run(["lxc-stop", "-n", name, "-t", "30"], timeout=45)
    elif action == "reboot":
        settings = container_settings(name)
        if str(settings.get("ipv4Mode") or "") == "manual":
            ensure_nested_routed_lan(str(settings.get("ipv4Address") or ""), str(settings.get("gateway") or ""))
        run(["lxc-stop", "-n", name, "-r", "-t", "30"], timeout=60)
    elif action == "repair-network":
        return repair_container_network(name)
    elif action == "delete":
        if data.get("deleteFiles") is not True or str(data.get("confirmation") or "") != name:
            raise ValueError("deleting a container requires delete all files and the exact container ID")
        cleanup_container_path(name)
    else:
        raise ValueError("unsupported container action")
    return {"id": name, "action": action, "status": "deleted" if action == "delete" else "submitted"}


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
    if new_name != current:
        raise ValueError("renaming local LXC containers is not enabled yet; clone or recreate with the new name")

    append_unique(config, f"lxc.cgroup2.memory.max = {memory * 1024 * 1024}")
    append_unique(config, f"lxc.cgroup2.cpu.max = {cpus * 100000} 100000")
    append_unique(config, f"lxc.start.auto = {1 if data.get('startOnBoot', True) else 0}")

    requested_network = str(data.get("network") or "").strip()
    if requested_network:
        networks = local_networks()
        network_state = lightnas_network_state()
        nested_mode = str(network_state.get("LIGHTNAS_NETWORK_MODE") or "")
        actual_network = requested_network
        if nested_mode == "lxc-nat":
            uplink = str(network_state.get("LIGHTNAS_UPLINK") or "eth0")
            internal_bridge = str(network_state.get("LIGHTNAS_CONTAINER_BRIDGE") or "lightnas0")
            if requested_network not in {uplink, internal_bridge}:
                raise ValueError("selected container network is not available")
            actual_network = internal_bridge
        elif requested_network not in networks:
            raise ValueError("selected container network is not available")
        direct_lan = (
            nested_mode in {"nested-macvlan", "nested-ipvlan"}
            and actual_network == str(network_state.get("LIGHTNAS_CONTAINER_PARENT") or network_state.get("LIGHTNAS_UPLINK") or "eth0")
        )
        direct_type = "macvlan" if nested_mode == "nested-macvlan" else ("ipvlan" if nested_mode == "nested-ipvlan" else "veth")
        append_unique(config, f"lxc.net.0.type = {direct_type if direct_lan else 'veth'}")
        append_unique(config, f"lxc.net.0.link = {actual_network}")
        if direct_lan and direct_type == "macvlan":
            append_unique(config, "lxc.net.0.macvlan.mode = bridge")
        if direct_lan and direct_type == "ipvlan":
            append_unique(config, "lxc.net.0.ipvlan.mode = l2")

    mode = str(data.get("ipv4Mode") or "dhcp")
    address = str(data.get("ipv4Address") or "").strip()
    gateway = str(data.get("gateway") or "").strip()
    dns_values = [item.strip() for item in str(data.get("dns") or "").split(",") if item.strip()]
    if mode not in {"dhcp", "manual"}:
        raise ValueError("invalid container IPv4 mode")
    try:
        if mode == "manual":
            ipaddress.ip_interface(address)
            if gateway:
                ipaddress.ip_address(gateway)
        for item in dns_values:
            ipaddress.ip_address(item)
    except ValueError as exc:
        raise ValueError("invalid static IPv4 address, gateway, or DNS server") from exc

    rootfs = rootfs_from_config(config)
    if not rootfs or not rootfs.is_dir():
        raise RuntimeError("container root filesystem is unavailable")
    network_dir = rootfs / "etc" / "systemd" / "network"
    network_dir.mkdir(parents=True, exist_ok=True)
    clear_managed_automatic_address(config)
    for existing in network_dir.glob("*.network"):
        if existing.is_file() or existing.is_symlink():
            existing.unlink()
    guest_interface = "eth0"
    try:
        config_text = config.read_text(encoding="utf-8")
        name_match = re.search(r"^lxc\.net\.0\.name\s*=\s*(\S+)\s*$", config_text, re.MULTILINE)
        if name_match and IFACE_RE.fullmatch(name_match.group(1)):
            guest_interface = name_match.group(1)
    except OSError:
        pass

    lines = ["[Match]", f"Name={guest_interface}", "", "[Network]"]
    routed_next_hop = _nested_routed_guest_next_hop(address, gateway) if mode == "manual" else ""
    if mode == "dhcp":
        lines += ["DHCP=ipv4", "IPv6AcceptRA=yes"]
    elif routed_next_hop:
        routed_address = f"{ipaddress.ip_interface(address).ip}/32"
        lines.append(f"Address={routed_address}")
        for item in dns_values:
            lines.append(f"DNS={item}")
        lines += [
            "",
            "[Route]",
            f"Destination={routed_next_hop}/32",
            "Scope=link",
            "",
            "[Route]",
            "Destination=0.0.0.0/0",
            f"Gateway={routed_next_hop}",
            "GatewayOnLink=yes",
        ]
    else:
        lines.append(f"Address={address}")
        if gateway:
            lines.append(f"Gateway={gateway}")
        for item in dns_values:
            lines.append(f"DNS={item}")
    (network_dir / "10-lightnas-eth0.network").write_text("\n".join(lines) + "\n", encoding="utf-8")

    metadata_path = config.parent / "lightnas.json"
    metadata = {}
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        pass
    metadata["ipv4Mode"] = mode
    metadata["network"] = requested_network or metadata.get("network") or ""
    metadata["ipv4Address"] = address
    metadata["gateway"] = gateway
    metadata["dns"] = ", ".join(dns_values)
    metadata["routedLanNextHop"] = routed_next_hop
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    routed_lan = False
    if mode == "manual":
        routed_lan = ensure_nested_routed_lan(address, gateway)

    # Additional NICs are managed as lxc.net.1+ while lxc.net.0 remains the
    # primary LightNAS interface.
    if "extraNics" in data:
        extra_nics = data.get("extraNics")
        if not isinstance(extra_nics, list) or len(extra_nics) > 7:
            raise ValueError("extraNics must be a list of at most 7 interfaces")
        config_text = config.read_text(encoding="utf-8")
        config_text = re.sub(r"^lxc\.net\.[1-9][0-9]*\..*\n?", "", config_text, flags=re.MULTILINE)
        config.write_text(config_text.rstrip() + "\n", encoding="utf-8")
        available_networks = local_networks()
        for offset, nic in enumerate(extra_nics, start=1):
            if not isinstance(nic, dict):
                raise ValueError("invalid extra NIC configuration")
            link = str(nic.get("network") or "").strip()
            if link not in available_networks:
                raise ValueError(f"extra NIC network {link or '(blank)'} is not available")
            mac = str(nic.get("macAddress") or "").strip().lower() or unique_container_mac()
            if not re.fullmatch(r"(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}", mac):
                raise ValueError("invalid extra NIC MAC address")
            append_unique(config, f"lxc.net.{offset}.type = veth")
            append_unique(config, f"lxc.net.{offset}.link = {link}")
            append_unique(config, f"lxc.net.{offset}.flags = up")
            append_unique(config, f"lxc.net.{offset}.name = eth{offset}")
            append_unique(config, f"lxc.net.{offset}.hwaddr = {mac}")
            vlan = str(nic.get("vlanTag") or "").strip()
            if vlan:
                vlan_id = int(vlan)
                if not 1 <= vlan_id <= 4094:
                    raise ValueError("invalid extra NIC VLAN tag")
                append_unique(config, f"lxc.net.{offset}.vlan.id = {vlan_id}")

    # Add requested host-directory mount points and device pass-through entries.
    # Existing non-LightNAS entries are preserved.
    for mount in data.get("addMountPoints") or []:
        if not isinstance(mount, dict):
            raise ValueError("invalid mount point")
        source = str(mount.get("source") or "").strip()
        target = str(mount.get("target") or "").strip().lstrip("/")
        if not source.startswith("/") or ".." in Path(source).parts or not target or ".." in Path(target).parts:
            raise ValueError("mount points require absolute host source and safe container target")
        if not Path(source).exists():
            raise ValueError(f"mount source does not exist: {source}")
        options = "bind,create=dir" + (",ro" if mount.get("readOnly") else "")
        with config.open("a", encoding="utf-8") as handle:
            handle.write(f"lxc.mount.entry = {source} {target} none {options} 0 0\n")

    for device in data.get("addDevicePaths") or []:
        path = str(device.get("path") if isinstance(device, dict) else device or "").strip()
        if not path.startswith("/dev/") or ".." in Path(path).parts or not Path(path).exists():
            raise ValueError("device passthrough must reference an existing /dev path")
        target = path.lstrip("/")
        with config.open("a", encoding="utf-8") as handle:
            handle.write(f"lxc.mount.entry = {path} {target} none bind,optional,create=file 0 0\n")

    interfaces = rootfs / "etc" / "network" / "interfaces"
    if interfaces.parent.exists():
        interfaces.write_text("auto lo\niface lo inet loopback\n", encoding="utf-8")
    subprocess.run(
        ["systemctl", "--root", str(rootfs), "disable", "NetworkManager.service", "networking.service"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    )
    subprocess.run(
        ["systemctl", "--root", str(rootfs), "enable", "systemd-networkd.service"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
    )

    if lxc_state(current) == "running":
        subprocess.run(["lxc-cgroup", "-n", current, "memory.max", str(memory * 1024 * 1024)], check=False, capture_output=True)
        subprocess.run(["lxc-cgroup", "-n", current, "cpu.max", f"{cpus * 100000} 100000"], check=False, capture_output=True)

        # Restart the persistent guest network manager first.
        subprocess.run(
            ["lxc-attach", "-n", current, "--", "systemctl", "restart", "systemd-networkd.service"],
            check=False, capture_output=True, timeout=30,
        )

        if mode == "dhcp":
            kick_container_dhcp(current)
        else:
            # Apply the saved static settings to the running guest immediately.
            # This avoids showing a stale DHCP lease until the next reboot.
            run(["lxc-attach", "-n", current, "--", "ip", "link", "set", guest_interface, "up"], timeout=10, check=False)
            run(["lxc-attach", "-n", current, "--", "ip", "-4", "addr", "flush", "dev", guest_interface, "scope", "global"], timeout=10, check=False)
            if routed_next_hop:
                routed_address = f"{ipaddress.ip_interface(address).ip}/32"
                run(["lxc-attach", "-n", current, "--", "ip", "addr", "add", routed_address, "dev", guest_interface], timeout=10)
                run(["lxc-attach", "-n", current, "--", "ip", "route", "replace", f"{routed_next_hop}/32", "dev", guest_interface, "scope", "link"], timeout=10)
                run(["lxc-attach", "-n", current, "--", "ip", "route", "replace", "default", "via", routed_next_hop, "dev", guest_interface, "onlink"], timeout=10)
            else:
                run(["lxc-attach", "-n", current, "--", "ip", "addr", "add", address, "dev", guest_interface], timeout=10)
                if gateway:
                    run(["lxc-attach", "-n", current, "--", "ip", "route", "replace", "default", "via", gateway, "dev", guest_interface], timeout=10)

        # Apply an explicit resolver override when requested. resolvectl is
        # preferred because /etc/resolv.conf is often the 127.0.0.53 stub.
        if dns_values:
            resolvectl = run(["lxc-attach", "-n", current, "--", "sh", "-lc", "command -v resolvectl || true"], timeout=5, check=False).strip()
            resolved_active = run(
                ["lxc-attach", "-n", current, "--", "sh", "-lc", "systemctl is-active systemd-resolved.service 2>/dev/null || true"],
                timeout=5, check=False,
            ).strip() == "active"
            if resolvectl and resolved_active:
                run(["lxc-attach", "-n", current, "--", "resolvectl", "dns", guest_interface, *dns_values], timeout=10)
                run(["lxc-attach", "-n", current, "--", "resolvectl", "domain", guest_interface, "~."], timeout=10, check=False)
            else:
                resolver_body = "".join(f"nameserver {value}\n" for value in dns_values)
                escaped = resolver_body.replace("'", "'\\''")
                run([
                    "lxc-attach", "-n", current, "--", "sh", "-lc",
                    f"rm -f /etc/resolv.conf && printf '%s' '{escaped}' > /etc/resolv.conf",
                ], timeout=10)

    live_ipv4 = next((value for value in container_addresses(current) if ":" not in value), "")
    automatic_fallback = False
    if mode == "dhcp" and lxc_state(current) == "running" and not live_ipv4:
        for _attempt in range(12):
            time.sleep(1)
            live_ipv4 = next((value for value in container_addresses(current) if ":" not in value), "")
            if live_ipv4:
                break
        if not live_ipv4 and lightnas_network_state().get("LIGHTNAS_NETWORK_MODE") == "lxc-nat":
            live_ipv4 = apply_managed_automatic_address(current, config)
            automatic_fallback = True

    updated_settings = container_settings(current)
    return {
        "id": current, "name": current, "memoryMiB": memory, "cpus": cpus,
        "network": requested_network, "ipv4Mode": mode, "ipv4Address": address,
        "gateway": gateway, "dns": ", ".join(dns_values),
        "startOnBoot": bool(data.get("startOnBoot", True)), "status": "updated",
        "ipv4": live_ipv4 or str(updated_settings.get("liveIpv4Address") or "").split("/", 1)[0],
        "liveIpv4Address": updated_settings.get("liveIpv4Address") or "",
        "liveGateway": updated_settings.get("liveGateway") or "",
        "liveNextHop": updated_settings.get("liveNextHop") or "",
        "liveDns": updated_settings.get("liveDns") or "",
        "automaticFallback": automatic_fallback,
    }


def parse_nmcli(text: str, count: int) -> list[list[str]]:
    rows = []
    for line in text.splitlines():
        if not line:
            continue
        fields = line.split(":")
        if len(fields) >= count:
            rows.append(fields[: count - 1] + [":".join(fields[count - 1 :])])
    return rows


def _derive_nested_lan_state(uplink: str, mode: str) -> dict:
    result = {
        "LIGHTNAS_NETWORK_MODE": mode,
        "LIGHTNAS_UPLINK": uplink,
        "LIGHTNAS_CONTAINER_PARENT": uplink,
    }
    try:
        cidr = run(["ip", "-4", "-o", "addr", "show", "dev", uplink, "scope", "global"], timeout=5, check=False)
        cidr_match = re.search(r"\binet\s+([^\s]+)", cidr)
        routes = run(["ip", "-4", "route", "show", "default", "dev", uplink], timeout=5, check=False)
        gateway_match = re.search(r"\bvia\s+([0-9.]+)", routes)
        if not cidr_match or not gateway_match:
            return result
        iface = ipaddress.ip_interface(cidr_match.group(1))
        network = iface.network
        gateway = ipaddress.ip_address(gateway_match.group(1))
        usable = max(0, network.num_addresses - 2)
        if usable < 60:
            return result
        start_index = 50 if usable >= 200 else max(2, usable // 4)
        end_index = 200 if usable >= 200 else max(start_index, usable - 5)
        start = network.network_address + start_index
        end = network.network_address + end_index
        while start in {iface.ip, gateway} and start < end:
            start += 1
        while end in {iface.ip, gateway} and end > start:
            end -= 1
        result.update({
            "LIGHTNAS_CONTAINER_SUBNET": network.with_prefixlen,
            "LIGHTNAS_CONTAINER_POOL_START": str(start),
            "LIGHTNAS_CONTAINER_POOL_END": str(end),
            "LIGHTNAS_CONTAINER_GATEWAY": str(gateway),
            "LIGHTNAS_HOST_ADDRESS": str(iface.ip),
        })
    except Exception:
        pass
    return result


def _upgrade_nested_lan_state(state: dict, path: Path) -> dict:
    """Use direct L2 only when an administrator explicitly requests it."""
    if not in_container() or str(state.get("LIGHTNAS_NETWORK_MODE") or "") != "lxc-nat":
        return state
    requested_mode = os.environ.get("LIGHTNAS_NESTED_LAN_MODE", "nat").strip().lower()
    if requested_mode not in {"macvlan", "ipvlan"}:
        return state

    uplink = str(state.get("LIGHTNAS_UPLINK") or "").strip()
    if not uplink:
        try:
            routes = json.loads(run(["ip", "-j", "-4", "route", "show", "default"], timeout=5, check=False) or "[]")
            uplink = str(routes[0].get("dev") or "") if routes else ""
        except Exception:
            uplink = ""
    if not uplink or not IFACE_RE.fullmatch(uplink) or not Path("/sys/class/net", uplink).exists():
        return state

    probes = {
        "macvlan": ("nested-macvlan", ["ip", "link", "add", "link", uplink, "name", f"lnmv{os.getpid() % 10000}", "type", "macvlan", "mode", "bridge"]),
        "ipvlan": ("nested-ipvlan", ["ip", "link", "add", "link", uplink, "name", f"lniv{os.getpid() % 10000}", "type", "ipvlan", "mode", "l2"]),
    }
    probes = [probes[requested_mode]]
    for mode, command_args in probes:
        probe_name = command_args[command_args.index("name") + 1]
        probe = subprocess.run(command_args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode != 0:
            continue
        subprocess.run(["ip", "link", "delete", probe_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        upgraded = _derive_nested_lan_state(uplink, mode)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(f"{key}={value}" for key, value in upgraded.items()) + "\n", encoding="utf-8")
        except OSError:
            pass
        return upgraded
    return state


def lightnas_network_state() -> dict:
    state = {}
    path = Path("/etc/lightnas/network.env")
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.startswith("LIGHTNAS_"):
                state[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass

    requested_mode = os.environ.get("LIGHTNAS_NESTED_LAN_MODE", "nat").strip().lower()
    current_mode = str(state.get("LIGHTNAS_NETWORK_MODE") or "")
    if in_container() and current_mode in {"nested-macvlan", "nested-ipvlan"} and requested_mode not in {"macvlan", "ipvlan"}:
        # Older LightNAS builds auto-promoted a nested Proxmox LXC to direct
        # macvlan/ipvlan after only checking that the link type could be
        # created. That does not prove the outer bridge permits a second MAC or
        # source IP. Revert those installs to the routed LightNAS bridge.
        state["LIGHTNAS_NETWORK_MODE"] = "lxc-nat"
        state["LIGHTNAS_CONTAINER_BRIDGE"] = str(state.get("LIGHTNAS_CONTAINER_BRIDGE") or "lightnas0")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(f"{key}={value}" for key, value in state.items()) + "\n", encoding="utf-8")
        except OSError:
            pass

    state = _upgrade_nested_lan_state(state, path)
    return state


def network_inventory() -> dict:
    if not available("nmcli"):
        return {
            "editable": False, "manager": None, "reason": "NetworkManager is not installed.",
            "devices": [], "connections": [], "wifi": [], "wifiAvailable": False,
            "uplinks": [], "currentUplink": None, "connectivity": "unknown", "bridge": None
        }

    raw_devices_text = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"], timeout=15, check=False)
    raw_devices = [
        {"name": row[0], "type": row[1], "state": row[2], "connection": row[3] or None}
        for row in parse_nmcli(raw_devices_text, 4)
        if IFACE_RE.fullmatch(row[0])
    ]

    raw_connections_text = run(["nmcli", "-t", "-f", "NAME,UUID,TYPE,DEVICE,AUTOCONNECT", "connection", "show"], timeout=15, check=False)
    raw_connections = [
        {"name": row[0], "uuid": row[1], "type": row[2], "device": row[3] or None, "autoconnect": row[4] == "yes"}
        for row in parse_nmcli(raw_connections_text, 5)
        if row[0]
    ]

    default_routes = []
    try:
        default_routes = json.loads(run(["ip", "-j", "-4", "route", "show", "default"], timeout=10, check=False) or "[]")
    except Exception:
        default_routes = []
    default_routes = sorted(default_routes, key=lambda item: int(item.get("metric") or 0))
    preferred_route = default_routes[0] if default_routes else {}
    default_device = str(preferred_route.get("dev") or "")

    state = lightnas_network_state()
    bridge_mode = state.get("LIGHTNAS_NETWORK_MODE") == "bridge"
    bridge_name = state.get("LIGHTNAS_LAN_BRIDGE") or ("virbr0" if bridge_mode else "")
    bridge_port = state.get("LIGHTNAS_UPLINK") or ""

    def internal_device(name: str) -> bool:
        return bool(re.fullmatch(r"(?:lo|veth.*|tap.*|tun.*|docker\d*|br-[A-Fa-f0-9]+|lightnas\d*|lxcbr\d*)", name or ""))

    devices = []
    for item in raw_devices:
        name = item["name"]
        if internal_device(name):
            continue
        devices.append({**item, **({"bridgePortOf": bridge_name} if bridge_mode and name == bridge_port else {})})

    connections = []
    for item in raw_connections:
        name = item["name"]
        device = item.get("device") or ""
        if internal_device(device) or internal_device(name):
            continue
        # Keep the appliance bridge slave visible so the Networking page can
        # present physical-port membership like Proxmox does.
        # Hide stale auto-generated wired profiles with no active device.
        if not device and item["type"] in {"802-3-ethernet", "ethernet"}:
            continue
        connections.append(item)

    connectivity = run(["nmcli", "-t", "-f", "CONNECTIVITY", "general"], timeout=10, check=False).strip() or "unknown"

    uplinks = []
    for item in devices:
        name = item["name"]
        is_default = name == default_device
        is_bridge_uplink = is_default and item["type"] == "bridge"
        if item["type"] not in {"ethernet", "wifi"} and not is_bridge_uplink:
            continue
        if item["state"] == "unavailable" or (item["state"] == "unmanaged" and not is_default):
            continue
        kind = "Wi-Fi" if item["type"] == "wifi" else ("Ethernet bridge" if is_bridge_uplink else "Ethernet")
        uplinks.append({
            **item,
            "active": is_default or (not default_device and item["state"] == "connected"),
            "managed": item["state"] != "unmanaged" or is_bridge_uplink,
            "kind": kind,
            **({"physicalPort": bridge_port} if is_bridge_uplink and bridge_port else {}),
        })

    current_uplink = next((item for item in uplinks if item["active"]), None)
    if current_uplink:
        current_uplink = {
            **current_uplink,
            "gateway": preferred_route.get("gateway") or None,
            "metric": preferred_route.get("metric"),
        }

    wifi = []
    wifi_devices = [item for item in raw_devices if item["type"] == "wifi" and item["state"] not in {"unavailable", "unmanaged"}]
    if wifi_devices:
        scan = run(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto"], timeout=20, check=False)
        seen = set()
        for row in parse_nmcli(scan, 4):
            ssid = row[1]
            if not ssid or ssid in seen:
                continue
            seen.add(ssid)
            wifi.append({"ssid": ssid, "connected": row[0] == "*", "signal": int(row[2] or 0), "security": row[3] or "Open"})

    return {
        "editable": True,
        "manager": "NetworkManager",
        "reason": None,
        "devices": devices,
        "connections": connections,
        "wifi": wifi,
        "wifiAvailable": bool(wifi_devices),
        "uplinks": uplinks,
        "currentUplink": current_uplink,
        "connectivity": connectivity,
        "bridge": {
            "mode": state.get("LIGHTNAS_NETWORK_MODE") or None,
            "name": bridge_name or None,
            "port": bridge_port or None,
        },
    }


def prefer_uplink(device: str) -> dict:
    if not IFACE_RE.fullmatch(device):
        raise ValueError("invalid network device")

    raw = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"], timeout=15, check=False)
    rows = parse_nmcli(raw, 4)
    selected = next((row for row in rows if row[0] == device), None)
    if not selected or selected[1] not in {"ethernet", "wifi"}:
        raise ValueError("select an available Ethernet or Wi-Fi interface")
    if selected[2] in {"unavailable", "unmanaged"}:
        raise RuntimeError("selected network interface is not currently usable")

    if selected[2] != "connected":
        result = subprocess.run(["nmcli", "device", "connect", device], text=True, capture_output=True, timeout=45)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "unable to connect device").strip()
            if selected[1] == "wifi":
                raise RuntimeError(f"Connect to a Wi-Fi network first: {detail}")
            raise RuntimeError(detail)
        raw = run(["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"], timeout=15, check=False)
        selected = next((row for row in parse_nmcli(raw, 4) if row[0] == device), selected)

    connection = selected[3] if len(selected) > 3 else ""
    if not connection:
        raise RuntimeError("NetworkManager did not report an active connection profile")

    # Prefer the selected connection without dropping the fallback link. Lower
    # route metric wins, so switching does not intentionally break management.
    run(["nmcli", "connection", "modify", connection, "ipv4.route-metric", "50", "ipv6.route-metric", "50", "connection.autoconnect", "yes"], timeout=20)

    active_raw = run(["nmcli", "-t", "-f", "NAME,TYPE,DEVICE", "connection", "show", "--active"], timeout=15, check=False)
    for row in parse_nmcli(active_raw, 3):
        other_name, other_type, other_device = row
        if other_name == connection or other_device == device:
            continue
        if "ethernet" in other_type or "wireless" in other_type or other_type == "wifi":
            run(["nmcli", "connection", "modify", other_name, "ipv4.route-metric", "600", "ipv6.route-metric", "600"], timeout=20, check=False)

    run(["nmcli", "connection", "up", connection], timeout=45)
    return {"device": device, "connection": connection, "status": "preferred"}



def require_nmcli() -> None:
    if not available("nmcli"):
        raise RuntimeError("NetworkManager is not installed on this LightNAS host")


def network_action(data: dict) -> dict:
    action = str(data.get("action") or "")
    if action == "firewall-add":
        if not available("ufw"):
            return {"action": action, "status": "unmanaged", "backend": "none", "message": "UFW is not installed; existing host firewall policy is unchanged."}
        decision = str(data.get("decision") or "").lower()
        protocol = str(data.get("protocol") or "").lower()
        try:
            port = int(data.get("port"))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid firewall port") from exc
        source = str(data.get("source") or "").strip()
        if decision not in {"allow", "deny"} or protocol not in {"tcp", "udp"} or not (1 <= port <= 65535):
            raise ValueError("invalid firewall rule")
        args = ["ufw", decision]
        if source:
            if not re.fullmatch(r"[A-Fa-f0-9:.]+(?:/[0-9]{1,3})?", source):
                raise ValueError("invalid firewall source address")
            args += ["from", source, "to", "any"]
        else:
            # UFW's long rule form requires an explicit destination.  Using
            # ``allow port 8443 proto tcp`` makes UFW reject the request with
            # "Need 'to' or 'from' clause", which used to make container app
            # publishing look like an image-download failure in the UI.
            args += ["to", "any"]
        args += ["port", str(port), "proto", protocol]
        run(args, timeout=30)
        return {"action": action, "decision": decision, "protocol": protocol, "port": port, "source": source or "any"}
    if action == "firewall-delete":
        if not available("ufw"):
            raise RuntimeError("UFW is not installed on this LightNAS host")
        try:
            number = int(data.get("number"))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid firewall rule number") from exc
        if not (1 <= number <= 9999):
            raise ValueError("invalid firewall rule number")
        run(["ufw", "--force", "delete", str(number)], timeout=30)
        return {"action": action, "number": number}
    if action == "firewall-remove-port":
        if not available("ufw"):
            return {"action": action, "status": "unmanaged", "backend": "none", "message": "UFW is not installed; existing host firewall policy is unchanged."}
        try:
            port = int(data.get("port"))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid firewall port") from exc
        protocol = str(data.get("protocol") or "tcp").lower()
        if protocol not in {"tcp", "udp"} or not (1 <= port <= 65535):
            raise ValueError("invalid firewall rule")
        run(["ufw", "--force", "delete", "allow", "to", "any", "port", str(port), "proto", protocol], timeout=30, check=False)
        return {"action": action, "protocol": protocol, "port": port}
    if action == "firewall-enable":
        if not available("ufw"):
            raise RuntimeError("UFW is not installed on this LightNAS host")
        run(["ufw", "--force", "enable"], timeout=30)
        return {"action": action, "status": "enabled"}
    if action == "firewall-disable":
        if not available("ufw"):
            raise RuntimeError("UFW is not installed on this LightNAS host")
        run(["ufw", "disable"], timeout=30)
        return {"action": action, "status": "disabled"}
    if action == "wifi-connect":
        require_nmcli()
        device = str(data.get("device") or "")
        ssid = str(data.get("ssid") or "")
        password = str(data.get("password") or "")
        if not IFACE_RE.fullmatch(device) or not ssid or len(ssid) > 64 or len(password) > 256:
            raise ValueError("invalid Wi-Fi connection settings")
        args = ["nmcli", "device", "wifi", "connect", ssid, "ifname", device]
        if password:
            args += ["password", password]
        run(args, timeout=45)
        preferred = prefer_uplink(device)
        return {"action": action, "device": device, "ssid": ssid, "status": "connected", "preferred": preferred}
    if action == "uplink-prefer":
        device = str(data.get("device") or "")
        result = prefer_uplink(device)
        return {"action": action, **result}
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
    if action == "bond-create":
        name = str(data.get("name") or "")
        mode = str(data.get("mode") or "active-backup")
        members = [str(item) for item in (data.get("members") or [])]
        allowed_modes = {"active-backup", "802.3ad", "balance-xor", "balance-rr"}
        if not IFACE_RE.fullmatch(name) or mode not in allowed_modes:
            raise ValueError("invalid bond settings")
        if len(members) < 1 or len(set(members)) != len(members) or any(not IFACE_RE.fullmatch(item) for item in members):
            raise ValueError("select one or more valid bond member interfaces")
        # Create the profiles without bringing them up. This mirrors the safe
        # Proxmox workflow: configuration can be reviewed before the operator
        # activates a change that may affect management connectivity.
        run(["nmcli", "connection", "add", "type", "bond", "ifname", name, "con-name", name, "bond.options", f"mode={mode}"], timeout=30)
        created = []
        try:
            for member in members:
                profile = f"{name}-{member}"
                run(["nmcli", "connection", "add", "type", "ethernet", "ifname", member, "con-name", profile, "master", name, "slave-type", "bond"], timeout=30)
                created.append(profile)
        except Exception:
            for profile in created:
                run(["nmcli", "connection", "delete", profile], timeout=20, check=False)
            run(["nmcli", "connection", "delete", name], timeout=20, check=False)
            raise
        return {"action": action, "name": name, "mode": mode, "members": members, "activated": False}
    if action == "route-create":
        name = str(data.get("connection") or "")
        destination = str(data.get("destination") or "").strip()
        gateway = str(data.get("gateway") or "").strip()
        try:
            metric = int(data.get("metric") or 100)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid route metric") from exc
        if not CONNECTION_RE.fullmatch(name) or not (0 <= metric <= 65535):
            raise ValueError("invalid route settings")
        if destination == "default":
            destination = "0.0.0.0/0"
        if not CIDR_RE.fullmatch(destination):
            raise ValueError("route destination must be an IPv4 network in CIDR form or default")
        if not re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", gateway):
            raise ValueError("route gateway must be an IPv4 address")
        octets = [int(part) for part in gateway.split(".")]
        if any(part > 255 for part in octets):
            raise ValueError("route gateway must be an IPv4 address")
        route = f"{destination} {gateway} {metric}"
        run(["nmcli", "connection", "modify", name, "+ipv4.routes", route], timeout=30)
        if bool(data.get("activate")):
            run(["nmcli", "connection", "up", name], timeout=45)
        return {"action": action, "connection": name, "destination": destination, "gateway": gateway, "metric": metric, "activated": bool(data.get("activate"))}
    if action == "route-delete":
        name = str(data.get("connection") or "")
        route = str(data.get("route") or "").strip()
        if not CONNECTION_RE.fullmatch(name) or not route or len(route) > 256 or any(ch in route for ch in "\r\n\x00"):
            raise ValueError("invalid route removal request")
        run(["nmcli", "connection", "modify", name, "-ipv4.routes", route], timeout=30)
        if bool(data.get("activate")):
            run(["nmcli", "connection", "up", name], timeout=45)
        return {"action": action, "connection": name, "route": route, "activated": bool(data.get("activate"))}
    if action == "route-update":
        name = str(data.get("connection") or "")
        old_route = str(data.get("oldRoute") or "").strip()
        destination = str(data.get("destination") or "").strip()
        gateway = str(data.get("gateway") or "").strip()
        try:
            metric = int(data.get("metric") or 100)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid route metric") from exc
        if not CONNECTION_RE.fullmatch(name) or not old_route or len(old_route) > 256 or any(ch in old_route for ch in "\r\n\x00"):
            raise ValueError("invalid route update request")
        if destination == "default":
            destination = "0.0.0.0/0"
        if not CIDR_RE.fullmatch(destination):
            raise ValueError("route destination must be an IPv4 network in CIDR form or default")
        try:
            ipaddress.ip_address(gateway)
        except ValueError as exc:
            raise ValueError("route gateway must be an IPv4 address") from exc
        if not (0 <= metric <= 65535):
            raise ValueError("invalid route metric")
        new_route = f"{destination} {gateway} {metric}"
        run(["nmcli", "connection", "modify", name, "-ipv4.routes", old_route], timeout=30)
        try:
            run(["nmcli", "connection", "modify", name, "+ipv4.routes", new_route], timeout=30)
        except Exception:
            run(["nmcli", "connection", "modify", name, "+ipv4.routes", old_route], timeout=30, check=False)
            raise
        if bool(data.get("activate")):
            run(["nmcli", "connection", "up", name], timeout=45)
        return {"action": action, "connection": name, "oldRoute": old_route, "route": new_route, "activated": bool(data.get("activate"))}
    if action == "route-runtime-update":
        old_destination = str(data.get("oldDestination") or "").strip()
        old_gateway = str(data.get("oldGateway") or "").strip()
        destination = str(data.get("destination") or "").strip()
        gateway = str(data.get("gateway") or "").strip()
        device = str(data.get("device") or "").strip()
        try:
            old_metric = int(data.get("oldMetric") or 0)
            metric = int(data.get("metric") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid route metric") from exc
        if not IFACE_RE.fullmatch(device) or not Path("/sys/class/net", device).exists():
            raise ValueError("route device is unavailable")
        if old_destination == "default":
            old_destination = "default"
        elif not CIDR_RE.fullmatch(old_destination):
            raise ValueError("existing route destination is invalid")
        if destination == "default":
            destination = "default"
        elif not CIDR_RE.fullmatch(destination):
            raise ValueError("route destination must be an IPv4 network in CIDR form or default")
        try:
            ipaddress.ip_address(old_gateway)
            ipaddress.ip_address(gateway)
        except ValueError as exc:
            raise ValueError("route gateway must be an IPv4 address") from exc
        if not (0 <= metric <= 65535 and 0 <= old_metric <= 65535):
            raise ValueError("invalid route metric")

        old_args = ["ip", "-4", "route", "del", old_destination, "via", old_gateway, "dev", device]
        if old_metric:
            old_args += ["metric", str(old_metric)]
        new_args = ["ip", "-4", "route", "replace", destination, "via", gateway, "dev", device]
        if metric:
            new_args += ["metric", str(metric)]
