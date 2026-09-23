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
import pty
import re
import shutil
import socket
import socketserver
import subprocess
import termios
import threading
from pathlib import Path

SOCKET_PATH = Path(os.environ.get("LIGHTNAS_HOST_SOCKET", "/run/lightnas/host-agent.sock"))
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
    {"id": "alpine-3.21", "label": "Alpine Linux 3.21", "dist": "alpine", "release": "3.21", "builder": "template", "template": "alpine", "arch": "x86_64", "nested": False},
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

    rootfs = rootfs_from_config(config)
    mode = "dhcp"
    address = ""
    gateway = ""
    dns: list[str] = []
    if rootfs:
        candidates = [
            rootfs / "etc" / "systemd" / "network" / "10-lightnas-eth0.network",
            rootfs / "etc" / "systemd" / "network" / "20-eth0.network",
        ]
        network_file = next((path for path in candidates if path.exists()), None)
        if network_file:
            try:
                network_text = network_file.read_text(encoding="utf-8")
                if not re.search(r"^DHCP\\s*=\\s*(?:yes|ipv4|true)\\s*$", network_text, re.MULTILINE | re.IGNORECASE):
                    mode = "manual"
                match = re.search(r"^Address\\s*=\\s*(.+?)\\s*$", network_text, re.MULTILINE)
                address = match.group(1).strip() if match else ""
                match = re.search(r"^Gateway\\s*=\\s*(.+?)\\s*$", network_text, re.MULTILINE)
                gateway = match.group(1).strip() if match else ""
                dns = [item.strip() for item in re.findall(r"^DNS\\s*=\\s*(.+?)\\s*$", network_text, re.MULTILINE)]
            except OSError:
                pass

    metadata = {}
    try:
        metadata = json.loads((config.parent / "lightnas.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        pass
    return {
        "network": config_value("lxc.net.0.link"),
        "macAddress": config_value("lxc.net.0.hwaddr"),
        "startOnBoot": config_value("lxc.start.auto") != "0",
        "ipv4Mode": mode,
        "ipv4Address": address,
        "gateway": gateway,
        "dns": ", ".join(dns),
        "storageId": str(metadata.get("storageId") or ""),
        "diskGiB": int(metadata.get("diskGiB") or 0),
        "imageId": str(metadata.get("imageId") or ""),
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
        addresses = [] if fast else container_addresses(name)
        containers.append({
            "id": name, "name": name, "status": state, "pid": pid,
            "memory": memory, "cpus": cpus, "provider": "local-lxc",
            "addresses": addresses,
            "ipv4": next((value for value in addresses if ":" not in value), None),
            **container_settings(name),
        })
    return containers


def container_summary() -> dict:
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
    if state.get("LIGHTNAS_NETWORK_MODE") == "nested-macvlan":
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
    args = [
        "debootstrap", "--variant=minbase", "--arch=amd64",
        f"--include={include}", image["release"], str(rootfs), image["mirror"],
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
        f"lxc.uts.name = {name}\n"
        "lxc.arch = x86_64\n",
        encoding="utf-8",
    )
    return config


def bootstrap_template_container(name: str, image: dict, storage_root_value: str) -> Path:
    template = str(image.get("template") or image["dist"])
    script = Path("/usr/share/lxc/templates") / f"lxc-{template}"
    if not script.exists():
        raise RuntimeError(f"local LXC template {template} is not installed")
    arch = str(image.get("arch") or "amd64")
    args = ["lxc-create", "-n", name, "-t", template, "--", "-r", image["release"], "-a", arch]
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
        run([
            "tar", "--numeric-owner", "--xattrs", "--xattrs-include=*",
            "-xaf", str(archive), "-C", str(rootfs)
        ], timeout=1800)
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
        f"lxc.uts.name = {name}\n"
        "lxc.arch = x86_64\n",
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

        network_lines = ["[Match]", "Name=eth0", "", "[Network]"]
        if mode == "dhcp":
            network_lines += ["DHCP=ipv4", "IPv6AcceptRA=yes"]
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
    nested_direct = network_state.get("LIGHTNAS_NETWORK_MODE") == "nested-macvlan"
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
    if not network or not IFACE_RE.fullmatch(network) or network not in networks:
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
    direct_macvlan = (
        nested_direct
        and network == str(network_state.get("LIGHTNAS_CONTAINER_PARENT") or network_state.get("LIGHTNAS_UPLINK") or "eth0")
    )
    append_unique(config, f"lxc.net.0.type = {'macvlan' if direct_macvlan else 'veth'}")
    append_unique(config, f"lxc.net.0.link = {network}")
    if direct_macvlan:
        append_unique(config, "lxc.net.0.macvlan.mode = bridge")
    append_unique(config, "lxc.net.0.flags = up")
    append_unique(config, "lxc.net.0.name = eth0")
    vlan_tag = data.get("vlanTag")
    if direct_macvlan and vlan_tag is not None:
        raise ValueError("nested LAN containers inherit the Proxmox uplink VLAN; do not set a second VLAN tag")
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
        append_unique(config, f"lxc.net.0.hwaddr = {mac_address}")
    if in_container():
        # The outer appliance container remains the security boundary. Avoid
        # inner AppArmor profile loading, which is commonly blocked in nested
        # Proxmox/LXC environments even when namespaces/cgroups are delegated.
        append_unique(config, "lxc.apparmor.profile = unconfined")

    try:
        run(["lxc-start", "-n", name, "-d"], timeout=60)
    except Exception:
        # Keep a completely built rootfs for troubleshooting rather than
        # deleting user data after an image was successfully created.
        raise RuntimeError(f"container {name} was built but could not start; inspect lxc-start -n {name} -F -l DEBUG")

    ipv4 = ""
    default_route = ""
    if direct_macvlan:
        # Do not tell the UI creation succeeded until upstream DHCP has had a
        # chance to provide a real LAN address and default route.
        for _attempt in range(30):
            addresses = [address for address in container_addresses(name) if ":" not in address]
            ipv4 = next((address for address in addresses if not address.startswith("10.77.0.")), "")
            if ipv4:
                try:
                    route = run(
                        ["lxc-attach", "-n", name, "--", "ip", "-4", "route", "show", "default"],
                        timeout=5,
                        check=False,
                    ).strip()
                except Exception:
                    route = ""
                if route:
                    default_route = route
                    break
            time.sleep(1)
        if not ipv4:
            raise RuntimeError(
                f"container {name} started but did not receive a LAN DHCP address; "
                "check the upstream DHCP server and Proxmox bridge MAC filtering"
            )
        if not default_route:
            raise RuntimeError(
                f"container {name} received {ipv4} but has no IPv4 default route"
            )

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
        "networkMode": "direct-lan" if direct_macvlan else "managed",
    }


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
        if requested_network not in networks:
            raise ValueError("selected container network is not available")
        network_state = lightnas_network_state()
        direct_macvlan = (
            network_state.get("LIGHTNAS_NETWORK_MODE") == "nested-macvlan"
            and requested_network == str(network_state.get("LIGHTNAS_CONTAINER_PARENT") or network_state.get("LIGHTNAS_UPLINK") or "eth0")
        )
        append_unique(config, f"lxc.net.0.type = {'macvlan' if direct_macvlan else 'veth'}")
        append_unique(config, f"lxc.net.0.link = {requested_network}")
        if direct_macvlan:
            append_unique(config, "lxc.net.0.macvlan.mode = bridge")

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
    for existing in network_dir.glob("*.network"):
        if existing.is_file() or existing.is_symlink():
            existing.unlink()
    lines = ["[Match]", "Name=eth0", "", "[Network]"]
    if mode == "dhcp":
        lines += ["DHCP=ipv4", "IPv6AcceptRA=yes"]
    else:
        lines.append(f"Address={address}")
        if gateway:
            lines.append(f"Gateway={gateway}")
        for item in dns_values:
            lines.append(f"DNS={item}")
    (network_dir / "10-lightnas-eth0.network").write_text("\n".join(lines) + "\n", encoding="utf-8")

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
        subprocess.run(
            ["lxc-attach", "-n", current, "--", "systemctl", "restart", "systemd-networkd.service"],
            check=False, capture_output=True, timeout=30,
        )
    return {
        "id": current, "name": current, "memoryMiB": memory, "cpus": cpus,
        "network": requested_network, "ipv4Mode": mode, "ipv4Address": address,
        "gateway": gateway, "dns": ", ".join(dns_values),
        "startOnBoot": bool(data.get("startOnBoot", True)), "status": "updated",
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
        if bridge_mode and name == bridge_port:
            # The physical NIC is now only a port of the appliance LAN bridge.
            continue
        devices.append(item)

    connections = []
    for item in raw_connections:
        name = item["name"]
        device = item.get("device") or ""
        if internal_device(device) or internal_device(name):
            continue
        if bridge_mode and (device == bridge_port or name == f"{bridge_name}-uplink"):
            continue
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
    require_nmcli()
    action = str(data.get("action") or "")
    if action == "firewall-add":
        if not available("ufw"):
            raise RuntimeError("UFW is not installed on this LightNAS host")
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
            raise RuntimeError("UFW is not installed on this LightNAS host")
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



def vm_console_target(name: str) -> tuple[str, int]:
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid VM name")
    if not available("virsh"):
        raise RuntimeError("libvirt client is not installed")
    state = run(["virsh", "-c", "qemu:///system", "domstate", name], timeout=15).lower()
    if "running" not in state:
        raise ValueError("start the VM before opening its console")
    display = run(["virsh", "-c", "qemu:///system", "vncdisplay", name], timeout=15).strip()
    # Common forms are :0, 127.0.0.1:0 and 127.0.0.1:5900.
    host = "127.0.0.1"
    value = display
    if ":" in display and not display.startswith(":"):
        host, value = display.rsplit(":", 1)
    else:
        value = display.lstrip(":")
    try:
        number = int(value)
    except ValueError as exc:
        raise RuntimeError(f"libvirt returned an invalid VNC display: {display}") from exc
    port = number if number >= 5900 else 5900 + number
    if not (5900 <= port <= 65535):
        raise RuntimeError("VM VNC port is outside the allowed range")
    if host in {"0.0.0.0", "::", "localhost", ""}:
        host = "127.0.0.1"
    return host, port


def stream_vm_console(connection, data: dict) -> None:
    name = str(data.get("id") or data.get("name") or "")
    host, port = vm_console_target(name)
    backend = socket.create_connection((host, port), timeout=10)

    def input_loop():
        try:
            while True:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                backend.sendall(chunk)
        except OSError:
            pass
        finally:
            try:
                backend.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    feeder = threading.Thread(target=input_loop, daemon=True)
    feeder.start()
    try:
        while True:
            chunk = backend.recv(65536)
            if not chunk:
                break
            connection.sendall(chunk)
    except OSError:
        pass
    finally:
        backend.close()
        feeder.join(timeout=1)

def stream_container(connection, data: dict) -> None:
    name = str(data.get("id") or data.get("name") or "")
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid container name")
    if lxc_state(name) != "running":
        raise ValueError("start the container before opening its terminal")
    master, slave = pty.openpty()
    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    # Give the attached shell a real session and controlling terminal. Without
    # this, the PTY echoes browser input but an interactive shell may never
    # consume Enter or display its prompt when LightNAS runs under systemd.
    def child_setup():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    terminal_shell = (
        "export HOME=/root USER=root LOGNAME=root; "
        "cd /root 2>/dev/null || cd /; "
        f'if [ -x /bin/bash ]; then export PS1="root@{name}:\\w# "; '
        "exec /bin/bash --noprofile --norc -i; "
        f'else export PS1="root@{name}:# "; exec /bin/sh -i; fi'
    )
    process = subprocess.Popen(
        ["lxc-attach", "-n", name, "--", "/bin/sh", "-c", terminal_shell],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        env=env,
        preexec_fn=child_setup,
    )
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



def execute_container_command(data: dict) -> dict:
    name = str(data.get("id") or data.get("name") or "")
    command = str(data.get("command") or "")
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid container name")
    if not command.strip():
        raise ValueError("enter a command")
    if len(command) > 8192 or "\x00" in command:
        raise ValueError("command is too long or contains invalid data")
    if lxc_state(name) != "running":
        raise ValueError("start the container before running commands")
    try:
        completed = subprocess.run(
            ["lxc-attach", "-n", name, "--", "/bin/sh", "-lc", command],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        output = (exc.stdout or b"")
        if isinstance(output, str):
            output = output.encode("utf-8", "replace")
        raise RuntimeError(f"command timed out after 120 seconds. Output: {output[-2000:].decode('utf-8', 'replace')}") from exc
    limit = 1024 * 1024
    raw = completed.stdout or b""
    truncated = len(raw) > limit
    if truncated:
        raw = raw[:limit]
    return {
        "name": name,
        "output": raw.decode("utf-8", "replace"),
        "exitCode": completed.returncode,
        "truncated": truncated,
    }



def service_active(name: str) -> bool:
    if not available("systemctl"):
        return False
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "--quiet", name],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10
        )
        return result.returncode == 0
    except Exception:
        return False


def appliance_health() -> dict:
    networks = local_networks()
    container_tools = all(available(tool) for tool in ("lxc-create", "lxc-start", "lxc-ls"))
    vm_tools = all(available(tool) for tool in ("virsh", "qemu-system-x86_64"))
    docker_ready = available("docker") and probe_command(["docker", "info"], timeout=15).get("ok", False)
    local_storage = Path("/var/lib/lightnas/storage/local")
    checks = [
        {
            "id": "management",
            "label": "Management control plane",
            "healthy": service_active("lightnas.service"),
            "detail": "LightNAS web service is active" if service_active("lightnas.service") else "LightNAS web service needs attention",
        },
        {
            "id": "host-agent",
            "label": "Privileged host agent",
            "healthy": service_active("lightnas-host-agent.service"),
            "detail": "Privileged appliance operations are available" if service_active("lightnas-host-agent.service") else "Privileged appliance operations need attention",
        },
        {
            "id": "containers",
            "label": "System containers",
            "healthy": container_tools and bool(networks),
            "detail": f"Native LXC ready on {networks[0]}" if container_tools and networks else ("LXC tools are installed but no active LightNAS bridge is ready" if container_tools else "Native LXC tools are missing"),
        },
        {
            "id": "virtualization",
            "label": "Virtual machines",
            "healthy": vm_tools and (service_active("libvirtd.service") or service_active("libvirtd.socket")),
            "detail": "QEMU/libvirt is ready" if vm_tools and (service_active("libvirtd.service") or service_active("libvirtd.socket")) else "QEMU/libvirt needs attention",
        },
        {
            "id": "apps",
            "label": "App Store runtime",
            "healthy": docker_ready,
            "detail": "Docker/OCI engine is ready" if docker_ready else "Docker/OCI engine needs attention",
        },
        {
            "id": "storage",
            "label": "Local appliance storage",
            "healthy": local_storage.is_dir() and os.access(local_storage, os.W_OK | os.X_OK),
            "detail": str(local_storage),
        },
    ]
    healthy = all(item["healthy"] for item in checks)
    return {
        "healthy": healthy,
        "status": "healthy" if healthy else "needs-attention",
        "checks": checks,
        "containerNetworks": networks,
        "kvm": Path("/dev/kvm").exists(),
        "softwareVirtualization": vm_tools,
    }


def appliance_repair() -> dict:
    # Fixed, appliance-owned recovery actions only. This endpoint never accepts
    # commands or paths from the browser.
    Path("/var/lib/lightnas/storage/local").mkdir(parents=True, exist_ok=True)
    Path("/var/lib/lightnas/app-data").mkdir(parents=True, exist_ok=True)

    provisioner = Path("/opt/lightnas/scripts/provision-runtimes.sh")
    if provisioner.is_file():
        env = os.environ.copy()
        if in_container():
            env["LIGHTNAS_ALLOW_NESTED_LXC"] = "1"
            env["LIGHTNAS_ENABLE_NESTED_RUNTIMES"] = "1"
        env["LIGHTNAS_RUNTIME_STATUS_FILE"] = "/var/lib/lightnas/runtime-status.txt"
        subprocess.run(
            ["bash", str(provisioner)],
            env=env, text=True, capture_output=True, timeout=900, check=False
        )

    if available("systemctl"):
        subprocess.run(["systemctl", "daemon-reload"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        for unit in (
            "lightnas-container-network.service",
            "lxc-net.service",
            "libvirtd.socket",
            "libvirtd.service",
            "docker.service",
        ):
            subprocess.run(
                ["systemctl", "enable", "--now", unit],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False
            )
    return appliance_health()


def dispatch(request: dict) -> dict:
    action = str(request.get("action") or "")
    data = request.get("data") or {}
    if not isinstance(data, dict):
        raise ValueError("operation data must be an object")
    if action == "container-summary":
        return container_summary()
    if action == "container-inventory":
        return container_inventory()
    if action == "runtime-diagnostics":
        return nested_runtime_diagnostics()
    if action == "container-create":
        return create_container(data)
    if action == "container-action":
        return container_action(data)
    if action == "container-update":
        return update_container(data)
    if action == "container-exec":
        return execute_container_command(data)
    if action == "network-inventory":
        return network_inventory()
    if action == "network-action":
        return network_action(data)
    if action == "appliance-health":
        return appliance_health()
    if action == "appliance-repair":
        return appliance_repair()
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
            if request.get("action") == "vm-console":
                self.wfile.write(b'{"ok":true,"data":{"mode":"raw-vnc"}}\n')
                self.wfile.flush()
                stream_vm_console(self.connection, request.get("data") or {})
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
