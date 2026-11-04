#!/usr/bin/env python3
"""Dedicated Hineni browser, foreground lifecycle; profile stays inside this folder."""
import argparse
import os
from pathlib import Path
import shutil
import socket
import signal
import subprocess
import sys
from dice import BASE, read_config


def executable(cfg):
    custom = cfg.get("browser", {}).get("executable") or os.getenv("CHROME_BIN")
    if custom:
        candidate = shutil.which(custom) or custom
        if not Path(candidate).is_file():
            raise ValueError("Browser executable not found")
        return candidate
    for candidate in ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                      "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]:
        found = shutil.which(candidate)
        if found:
            return found
    raise ValueError("Install Chrome/Chromium on this OS, or set browser.executable")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--headless", action="store_true", help="Server mode after login; no display required")
    p.add_argument("--check", action="store_true", help="Check paths only; do not launch or log in")
    args = p.parse_args()
    cfg = read_config()
    binary = executable(cfg)
    port = cfg.get("browser", {}).get("port", 19222)
    profile = BASE / "browser" / ".profile"
    if args.check:
        print(f"Browser: {binary}\nProfile: {profile}\nLocal port: {port}")
        return
    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            raise ValueError("Browser port is already in use; inspect the running browser or change browser.port")
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(profile, 0o700)
    command = [binary, f"--user-data-dir={profile}", f"--remote-debugging-port={port}",
               "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check"]
    if args.headless:
        command.append("--headless=new")
    command.append("about:blank")
    print("Dedicated browser running. Log into websites manually in this window; Ctrl+C stops it.", flush=True)
    child = subprocess.Popen(command)
    signal.signal(signal.SIGTERM, lambda *_: child.terminate())
    try:
        code = child.wait()
    except KeyboardInterrupt:
        child.terminate()
        try:
            code = child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait()
    raise SystemExit(code)


if __name__ == "__main__":
    main()
