#!/usr/bin/env python3
"""Apply the optional settings transferred with a clean USB installation."""

import json
import os
import re
import subprocess
import tempfile
import uuid
from pathlib import Path

seed = Path(".starpilot-offline")
with (seed / "access").open() as access:
    if access.readline().strip() != "STARPILOT_CONFIG":
        raise SystemExit(0)
    config = json.loads(access.read())

if ssh := config.get("ssh"):
    name = ssh["username"]
    keys = ssh["keys"]
    if not re.fullmatch(r"(?=.{1,39}$)[a-z0-9]+(?:-[a-z0-9]+)*", name) or not keys or not all(
        re.fullmatch(r"(?:ssh|ecdsa|sk)-[\w@.-]+ [A-Za-z0-9+/=]+", key) for key in keys
    ):
        raise SystemExit("Invalid offline SSH settings")
    params = Path("params")
    (params / "recovery").mkdir(parents=True, exist_ok=True)
    values = params / "d"
    if not values.is_dir():
        values.symlink_to("recovery")
    for key, value in (("GithubSshKeys", "\n".join(keys) + "\n"), ("GithubUsername", name), ("SshEnabled", "1")):
        with tempfile.NamedTemporaryFile(mode="w", dir=params, delete=False) as temp:
            temp.write(value)
        os.replace(temp.name, values / key)

if wifi := config.get("wifi"):
    ssid, psk = wifi["ssid"], wifi["psk"]
    if not 1 <= len(ssid) <= 32 or not all(type(byte) is int and 0 <= byte < 256 for byte in ssid) or not re.fullmatch(r"[a-f0-9]{64}", psk):
        raise SystemExit("Invalid offline Wi-Fi settings")
    ident = uuid.uuid5(uuid.NAMESPACE_OID, bytes(ssid).hex())
    keyfile = (
        f"[connection]\nid=StarPilot Wi-Fi\nuuid={ident}\ntype=wifi\nautoconnect=true\n\n"
        f"[wifi]\nmode=infrastructure\nssid={';'.join(map(str, ssid))};\n\n"
        f"[wifi-security]\nkey-mgmt=wpa-psk\npsk={psk}\n\n[ipv4]\nmethod=auto\n\n[ipv6]\nmethod=auto\n"
    )
    directory = Path("etc/NetworkManager/system-connections")
    with tempfile.NamedTemporaryFile(mode="w") as temp:
        temp.write(keyfile)
        temp.flush()
        subprocess.run(["sudo", "-n", "install", "-d", str(directory)], check=True)
        subprocess.run(["sudo", "-n", "install", "-m", "600", temp.name, str(directory / f"starpilot-{ident}.nmconnection")], check=True)
    subprocess.run(["sudo", "-n", "nmcli", "connection", "reload"], check=False, timeout=10)
