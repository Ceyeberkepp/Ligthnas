#!/usr/bin/env python3
"""LightNAS Proxmox host bridge launcher with authenticated noVNC streaming.

The main host-agent implementation is installed beside this launcher. This
wrapper authenticates to ``qm vncproxy`` on the Proxmox host, then presents a
VNC security-type ``None`` stream only across LightNAS's private authenticated
Unix-socket bridge. No Proxmox or VNC credential is sent to browser JavaScript.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pty
import secrets
import subprocess
import threading
from pathlib import Path

BASE_PATH = Path(os.environ.get(
    "LIGHTNAS_PVE_AGENT_BASE",
    "/usr/local/libexec/lightnas-proxmox-agent-base.py",
))
spec = importlib.util.spec_from_file_location("lightnas_pve_agent_base", BASE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Unable to load LightNAS host-agent base from {BASE_PATH}")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def read_exact(stream, size: int) -> bytes:
    output = bytearray()
    while len(output) < size:
        chunk = stream.read(size - len(output))
        if not chunk:
            raise RuntimeError("VNC proxy closed during protocol negotiation")
        output.extend(chunk)
    return bytes(output)


def recv_exact(connection, size: int) -> bytes:
    output = bytearray()
    while len(output) < size:
        chunk = connection.recv(size - len(output))
        if not chunk:
            raise ConnectionError("browser console disconnected during VNC negotiation")
        output.extend(chunk)
    return bytes(output)


def reverse_bits(value: int) -> int:
    result = 0
    for _ in range(8):
        result = (result << 1) | (value & 1)
        value >>= 1
    return result


def vnc_challenge_response(password: str, challenge: bytes) -> bytes:
    if len(challenge) != 16:
        raise RuntimeError("VNC server returned an invalid authentication challenge")
    password_bytes = password.encode("latin-1", "ignore")[:8].ljust(8, b"\0")
    des_key = bytes(reverse_bits(value) for value in password_bytes)
    # EDE3 with K1 == K2 == K3 is equivalent to single DES and remains
    # available on modern OpenSSL builds where the single-DES alias may not be.
    key24 = des_key * 3
    result = subprocess.run(
        ["openssl", "enc", "-des-ede3", "-K", key24.hex(), "-nopad", "-nosalt"],
        input=challenge,
        capture_output=True,
        check=True,
        timeout=10,
    )
    if len(result.stdout) != 16:
        raise RuntimeError("Unable to calculate the VNC authentication response")
    return result.stdout


def read_security_result(process) -> None:
    result = int.from_bytes(read_exact(process.stdout, 4), "big")
    if result == 0:
        return
    reason = "VNC authentication was rejected"
    try:
        length = int.from_bytes(read_exact(process.stdout, 4), "big")
        if 0 < length <= 4096:
            reason = read_exact(process.stdout, length).decode("utf-8", "replace")
    except Exception:
        pass
    raise RuntimeError(reason)


def authenticate_vnc_proxy(process, password: str) -> None:
    if not process.stdin or not process.stdout:
        raise RuntimeError("VNC proxy pipes are unavailable")
    version = read_exact(process.stdout, 12)
    if not version.startswith(b"RFB 003.") or not version.endswith(b"\n"):
        raise RuntimeError("Proxmox VNC proxy returned an invalid RFB version")
    process.stdin.write(version)
    process.stdin.flush()

    try:
        minor = int(version[8:11])
    except ValueError as exc:
        raise RuntimeError("Unable to parse Proxmox RFB version") from exc

    if minor <= 3:
        security_type = int.from_bytes(read_exact(process.stdout, 4), "big")
        if security_type == 0:
            length = int.from_bytes(read_exact(process.stdout, 4), "big")
            reason = read_exact(process.stdout, min(length, 4096)).decode("utf-8", "replace") if length else "VNC server rejected the connection"
            raise RuntimeError(reason)
        if security_type == 1:
            return
        if security_type != 2:
            raise RuntimeError(f"Unsupported Proxmox VNC security type {security_type}")
        challenge = read_exact(process.stdout, 16)
        process.stdin.write(vnc_challenge_response(password, challenge))
        process.stdin.flush()
        read_security_result(process)
        return

    count = read_exact(process.stdout, 1)[0]
    if count == 0:
        length = int.from_bytes(read_exact(process.stdout, 4), "big")
        reason = read_exact(process.stdout, min(length, 4096)).decode("utf-8", "replace") if length else "VNC server offered no security types"
        raise RuntimeError(reason)
    types = read_exact(process.stdout, count)
    if 2 in types:
        process.stdin.write(b"\x02")
        process.stdin.flush()
        challenge = read_exact(process.stdout, 16)
        process.stdin.write(vnc_challenge_response(password, challenge))
        process.stdin.flush()
        read_security_result(process)
        return
    if 1 in types:
        process.stdin.write(b"\x01")
        process.stdin.flush()
        # RFB 3.8 sends SecurityResult even for the None security type.
        if minor >= 8:
            read_security_result(process)
        return
    raise RuntimeError("Proxmox VNC proxy did not offer a supported security type")


def negotiate_browser_no_auth(connection) -> None:
    # The outer LightNAS WebSocket and host bridge have already authenticated
    # the user and the appliance. Expose a passwordless RFB session only inside
    # that tunnel so no VNC/Proxmox credential is disclosed to the browser.
    connection.sendall(b"RFB 003.008\n")
    version = recv_exact(connection, 12)
    if not version.startswith(b"RFB 003.") or not version.endswith(b"\n"):
        raise ConnectionError("browser sent an invalid RFB version")
    connection.sendall(b"\x01\x01")  # one security type: None
    if recv_exact(connection, 1) != b"\x01":
        raise ConnectionError("browser rejected the LightNAS VNC security mode")
    connection.sendall(b"\x00\x00\x00\x00")  # SecurityResult: OK



class Handler(base.Handler):
    def handle(self):
        raw = self.rfile.readline(base.MAX_REQUEST + 1)
        if len(raw) > base.MAX_REQUEST:
            self._reply(False, error="request is too large")
            return
        try:
            request = json.loads(raw.decode("utf-8"))
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            action = request.get("action")
            if action == "vm-console":
                base.authenticate(request)
                self._stream_vm_console(request.get("data"))
                return
            if action == "container-console":
                client = base.authenticate(request)
                self._stream_container_console(request.get("data"), client)
                return
            data = base.dispatch(request)
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

    def _stream_container_console(self, data, client_id):
        if not isinstance(data, dict):
            raise ValueError("missing container console request")
        try:
            vmid = int(data.get("vmid"))
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid container ID") from exc
        if vmid < 100 or vmid > 999999:
            raise ValueError("invalid container ID")
        if str(vmid) == str(client_id):
            raise PermissionError("LightNAS will not open a root host console into its own appliance container")
        state = base.run(["pct", "status", str(vmid)], timeout=15)
        if "running" not in state:
            raise ValueError("start the container before opening its terminal")

        master_fd, slave_fd = pty.openpty()
        environment = os.environ.copy()
        environment["TERM"] = "xterm-256color"
        process = subprocess.Popen(
            ["pct", "exec", str(vmid), "--", "/bin/sh", "-l"],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            env=environment,
        )
        os.close(slave_fd)
        self._reply(True, data={"mode": "pty", "vmid": vmid, "user": "root"})
        self.wfile.flush()

        def socket_to_terminal():
            try:
                while process.poll() is None:
                    chunk = self.connection.recv(65536)
                    if not chunk:
                        break
                    os.write(master_fd, chunk)
            except (BrokenPipeError, ConnectionError, OSError):
                pass
            finally:
                try:
                    os.write(master_fd, b"exit\n")
                except OSError:
                    pass

        feeder = threading.Thread(target=socket_to_terminal, daemon=True)
        feeder.start()
        try:
            while process.poll() is None:
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.connection.sendall(chunk)
        except (BrokenPipeError, ConnectionError, OSError):
            pass
        finally:
            try:
                os.close(master_fd)
            except OSError:
                pass
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
            feeder.join(timeout=1)

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

        # This ticket exists only inside this short-lived process and is used
        # solely to authenticate the host bridge to qm vncproxy.
        vnc_password = secrets.token_hex(4)
        environment = os.environ.copy()
        environment["LC_PVE_TICKET"] = vnc_password
        process = subprocess.Popen(
            ["qm", "vncproxy", str(vmid)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            env=environment,
        )

        try:
            authenticate_vnc_proxy(process, vnc_password)
            self._reply(True, data={"mode": "raw-vnc", "vmid": vmid, "authentication": "terminated-by-host-bridge"})
            self.wfile.flush()
            negotiate_browser_no_auth(self.connection)
        except Exception:
            if process.poll() is None:
                process.terminate()
            raise

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
