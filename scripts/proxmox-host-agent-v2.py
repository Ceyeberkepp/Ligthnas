#!/usr/bin/env python3
"""LightNAS Proxmox host bridge launcher with authenticated raw VNC streaming.

The main host-agent implementation is installed beside this launcher as
lightnas-proxmox-agent-base. This wrapper overrides only VM console streaming so
Proxmox's required LC_PVE_TICKET remains short-lived and VM-specific.
"""

from __future__ import annotations

import importlib.util
import os
import secrets
import subprocess
import threading
from pathlib import Path

BASE_PATH = Path(os.environ.get("LIGHTNAS_PVE_AGENT_BASE", "/usr/local/libexec/lightnas-proxmox-agent-base"))
spec = importlib.util.spec_from_file_location("lightnas_pve_agent_base", BASE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Unable to load LightNAS host-agent base from {BASE_PATH}")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


class Handler(base.Handler):
    def _stream_vm_console(self, data):
        if not isinstance(data, dict):
            raise ValueError("missing VM console request")
        try:
            vmid = int(data.get("vmid"))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid VM ID") from exc
        if vmid < 100 or vmid > 999999:
            raise ValueError("invalid VM ID")
        state = base.run(["qm", "status", str(vmid)], timeout=15)
        if "running" not in state:
            raise ValueError("VM must be running before opening the console")

        # qm vncproxy requires LC_PVE_TICKET. Keep this credential narrowly
        # scoped: random, VM-specific, sent only over the private Unix socket,
        # and Proxmox itself expires the VNC password shortly after setup.
        vnc_password = secrets.token_hex(4)
        environment = os.environ.copy()
        environment["LC_PVE_TICKET"] = vnc_password
        process = subprocess.Popen(
            ["qm", "vncproxy", str(vmid)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
            env=environment,
        )
        self._reply(True, data={"mode": "raw-vnc", "vmid": vmid, "password": vnc_password})
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


class Server(base.Server):
    pass


if __name__ == "__main__":
    base.CLIENT_DIR.mkdir(parents=True, exist_ok=True)
    base.SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        base.SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    server = Server(str(base.SOCKET_PATH), Handler)
    os.chmod(base.SOCKET_PATH, 0o666)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            base.SOCKET_PATH.unlink()
        except FileNotFoundError:
            pass
