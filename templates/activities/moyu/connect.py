#!/usr/bin/env python3
"""One place to inspect, test, enable and disable leisure sources; never imports cookies."""
import argparse
import json
from dice import BASE, read_config, atomic_json, locked
from fetch import collect


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["status", "enable", "disable", "probe"], nargs="?", default="status")
    p.add_argument("source", nargs="?")
    args = p.parse_args()
    cfg = read_config()
    if args.action == "status":
        print(json.dumps(cfg["sources"], ensure_ascii=False, indent=2))
        try:
            import urllib.request
            port = cfg.get("browser", {}).get("port", 19222)
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=3) as response:
                version = json.load(response)
            print(json.dumps({"browser_running": True, "version": version.get("Browser"), "note": "Browser connection is not proof of site login; use probe."}))
        except Exception:
            print("Dedicated browser not running; start browser.py in this folder.")
        return
    if args.source not in cfg["sources"]:
        p.error("Choose an existing source code from status")
    if args.action != "disable":
        items = collect(args.source, cfg["sources"][args.source], cfg)
        if not items:
            raise ValueError("No content returned; source was not enabled")
        print(json.dumps({"source": args.source, "items": items}, ensure_ascii=False, indent=2))
    if args.action in ("enable", "disable"):
        with locked(BASE):
            cfg = read_config()
            cfg["sources"][args.source]["enabled"] = args.action == "enable"
            # Reject a config with no active source before writing.
            if not any(x["enabled"] for x in cfg["sources"].values()):
                raise ValueError("Keep at least one enabled source")
            atomic_json(BASE / "config.json", cfg)
        print("Saved; effective on next roll. No scheduler restart needed.")


if __name__ == "__main__":
    main()
