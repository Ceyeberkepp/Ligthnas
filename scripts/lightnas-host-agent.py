#!/usr/bin/env python3
"""Privileged local LightNAS host daemon.

This daemon is part of LightNAS itself.  It exposes a narrow Unix-socket API to
the unprivileged web control plane for operations that must run as root:
system-container lifecycle and host network configuration.  It never accepts
arbitrary shell commands.
"""

from __future__ import annotations

import fcntl
import grp
import json
import os
import pty
import re
import shutil
import socket
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


def container_inventory() -> dict:
    ok, reason, diagnostics = container_capability()
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
        memory, cpus = container_limits(name)
        containers.append({"id": name, "name": name, "status": state, "pid": pid, "memory": memory, "cpus": cpus, "provider": "local-lxc"})
    return {
        "available": ok,
        "enabled": ok,
        "provider": "local-lxc",
        "reason": reason,
        "containers": containers,
        "images": [item for item in IMAGES if item.get("nested", True) or not in_container()],
        "networks": local_networks(),
        "storageRoot": "/var/lib/lxc",
        "diagnostics": diagnostics,
    }


def local_networks() -> list[str]:
    # LXC veth devices need an administratively-up Linux bridge. Do not offer
    # Docker's private bridge or inactive libvirt bridges as container targets.
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
    for preferred in ["lightnas0", "lxcbr0", "virbr0"]:
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


def cleanup_container_path(name: str) -> None:
    path = Path("/var/lib/lxc") / name
    if not path.exists():
        return
    subprocess.run(["lxc-stop", "-n", name, "-k"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["lxc-destroy", "-n", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)


def bootstrap_deb_container(name: str, image: dict) -> Path:
    if not available("debootstrap"):
        raise RuntimeError("debootstrap is not installed; rerun the LightNAS installer")
    base = Path("/var/lib/lxc") / name
    rootfs = base / "rootfs"
    base.mkdir(parents=True, exist_ok=False)
    rootfs.mkdir(parents=True, exist_ok=True)

    include = ",".join([
        "systemd-sysv", "systemd-resolved", "iproute2",
        "iputils-ping", "ca-certificates", "netbase", "procps"
    ])
    args = [
        "debootstrap", "--variant=minbase", "--arch=amd64",
        f"--include={include}", image["release"], str(rootfs), image["mirror"],
    ]
    try:
        run(args, timeout=1800)
    except Exception:
        cleanup_container_path(name)
        raise

    (rootfs / "etc" / "hostname").write_text(f"{name}\n", encoding="utf-8")
    (rootfs / "etc" / "hosts").write_text(
        f"127.0.0.1\tlocalhost\n127.0.1.1\t{name}\n::1\tlocalhost ip6-localhost ip6-loopback\n",
        encoding="utf-8",
    )
    network_dir = rootfs / "etc" / "systemd" / "network"
    network_dir.mkdir(parents=True, exist_ok=True)
    (network_dir / "20-eth0.network").write_text(
        "[Match]\nName=eth0\n\n[Network]\nDHCP=yes\nIPv6AcceptRA=yes\n",
        encoding="utf-8",
    )
    resolv = rootfs / "etc" / "resolv.conf"
    try:
        if resolv.exists() or resolv.is_symlink():
            resolv.unlink()
        resolv.symlink_to("/run/systemd/resolve/stub-resolv.conf")
    except OSError:
        pass
    subprocess.run(
        ["systemctl", "--root", str(rootfs), "enable", "systemd-networkd.service", "systemd-resolved.service"],
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


def bootstrap_template_container(name: str, image: dict) -> Path:
    template = str(image.get("template") or image["dist"])
    script = Path("/usr/share/lxc/templates") / f"lxc-{template}"
    if not script.exists():
        raise RuntimeError(f"local LXC template {template} is not installed")
    arch = str(image.get("arch") or "amd64")
    args = ["lxc-create", "-n", name, "-t", template, "--", "-r", image["release"], "-a", arch]
    try:
        run(args, timeout=1800)
    except Exception:
        cleanup_container_path(name)
        raise
    return Path("/var/lib/lxc") / name / "config"


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


def bootstrap_archive_container(name: str, archive_value: str) -> Path:
    archive = managed_template_archive(archive_value)
    base = Path("/var/lib/lxc") / name
    rootfs = base / "rootfs"
    base.mkdir(parents=True, exist_ok=False)
    rootfs.mkdir(parents=True, exist_ok=True)

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
        cleanup_container_path(name)
        raise

    if not (rootfs / "etc").is_dir():
        cleanup_container_path(name)
        raise ValueError("template archive does not contain a Linux root filesystem")

    (rootfs / "etc" / "hostname").write_text(f"{name}\n", encoding="utf-8")
    hosts = rootfs / "etc" / "hosts"
    if not hosts.exists():
        hosts.write_text(
            f"127.0.0.1\tlocalhost\n127.0.1.1\t{name}\n::1\tlocalhost ip6-localhost ip6-loopback\n",
            encoding="utf-8",
        )

    # Proxmox system templates generally already contain guest networking.
    # Add a networkd DHCP profile only when systemd is present so imported
    # templates remain bootable on the LightNAS NAT bridge.
    if (rootfs / "usr" / "lib" / "systemd").exists() or (rootfs / "lib" / "systemd").exists():
        network_dir = rootfs / "etc" / "systemd" / "network"
        network_dir.mkdir(parents=True, exist_ok=True)
        (network_dir / "20-eth0.network").write_text(
            "[Match]\nName=eth0\n\n[Network]\nDHCP=yes\nIPv6AcceptRA=yes\n",
            encoding="utf-8",
        )
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


def create_container(data: dict) -> dict:
    ok, reason, _diagnostics = container_capability()
    if not ok:
        raise RuntimeError(reason)
    name = str(data.get("name") or "").strip()
    image_id = str(data.get("image") or "").strip()
    template_path = str(data.get("templatePath") or "").strip()
    network = str(data.get("network") or "lightnas0").strip()
    try:
        memory = int(data.get("memoryMiB") or 2048)
        cpus = int(data.get("cpus") or 2)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid container resource values") from exc
    if not NAME_RE.fullmatch(name):
        raise ValueError("invalid container name")
    image = IMAGE_BY_ID.get(image_id)
    if not template_path and (not image or (in_container() and not image.get("nested", True))):
        raise ValueError("select a Linux system-container image or imported LightNAS template")
    if not IFACE_RE.fullmatch(network) or network not in local_networks():
        raise ValueError("select an active local container bridge")
    host_cpus = max(1, os.cpu_count() or 1)
    if not (256 <= memory <= 262144 and 1 <= cpus <= min(128, host_cpus)):
        raise ValueError("container CPU or memory values are outside host limits")

    container_path = Path("/var/lib/lxc") / name
    if container_path.exists():
        # Failed image downloads commonly leave a partial directory behind.
        # Remove only clearly incomplete containers; never destroy an existing
        # valid container implicitly.
        partial = (container_path / "partial").exists()
        valid = (container_path / "config").exists() and (container_path / "rootfs").exists()
        if partial or not valid:
            cleanup_container_path(name)
        else:
            raise ValueError("a container with this name already exists")

    if template_path:
        config = bootstrap_archive_container(name, template_path)
    elif image.get("builder") == "debootstrap":
        config = bootstrap_deb_container(name, image)
    else:
        config = bootstrap_template_container(name, image)

    append_unique(config, "lxc.start.auto = 1")
    append_unique(config, f"lxc.cgroup2.memory.max = {memory * 1024 * 1024}")
    append_unique(config, f"lxc.cgroup2.cpu.max = {cpus * 100000} 100000")
    append_unique(config, "lxc.net.0.type = veth")
    append_unique(config, f"lxc.net.0.link = {network}")
    append_unique(config, "lxc.net.0.flags = up")
    append_unique(config, "lxc.net.0.name = eth0")
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

    return {
        "id": name,
        "name": name,
        "status": "running",
        "provider": "local-lxc",
        "image": image_id,
        "builder": "archive" if template_path else image.get("builder"),
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
    append_unique(config, f"lxc.cgroup2.cpu.max = {cpus * 100000} 100000")
    if lxc_state(current) == "running":
        subprocess.run(["lxc-cgroup", "-n", current, "memory.max", str(memory * 1024 * 1024)], check=False, capture_output=True)
        subprocess.run(["lxc-cgroup", "-n", current, "cpu.max", f"{cpus * 100000} 100000"], check=False, capture_output=True)
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
        return {
            "editable": False, "manager": None, "reason": "NetworkManager is not installed.",
            "devices": [], "connections": [], "wifi": [], "wifiAvailable": False,
            "uplinks": [], "currentUplink": None, "connectivity": "unknown"
        }

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

    default_routes = []
    try:
        default_routes = json.loads(run(["ip", "-j", "route", "show", "default"], timeout=10, check=False) or "[]")
    except Exception:
        default_routes = []
    default_routes = sorted(default_routes, key=lambda item: int(item.get("metric") or 0))
    preferred_route = default_routes[0] if default_routes else {}
    default_device = str(preferred_route.get("dev") or "")

    connectivity = run(["nmcli", "-t", "-f", "CONNECTIVITY", "general"], timeout=10, check=False).strip() or "unknown"

    uplinks = []
    for item in devices:
        if item["type"] not in {"ethernet", "wifi"}:
            continue
        is_default = item["name"] == default_device
        # Proxmox commonly supplies the appliance eth0 outside NetworkManager.
        # A real kernel default route is authoritative, so keep that interface
        # as a valid active uplink even when nmcli labels it "unmanaged".
        if item["state"] == "unavailable" or (item["state"] == "unmanaged" and not is_default):
            continue
        uplinks.append({
            **item,
            "active": is_default or (not default_device and item["state"] == "connected"),
            "managed": item["state"] != "unmanaged",
            "kind": "Wi-Fi" if item["type"] == "wifi" else "Ethernet",
        })

    current_uplink = next((item for item in uplinks if item["active"]), None)
    if current_uplink:
        current_uplink = {
            **current_uplink,
            "gateway": preferred_route.get("gateway") or None,
            "metric": preferred_route.get("metric"),
        }

    wifi = []
    wifi_devices = [item for item in devices if item["type"] == "wifi" and item["state"] not in {"unavailable", "unmanaged"}]
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
    if action == "runtime-diagnostics":
        return nested_runtime_diagnostics()
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
