#!/usr/bin/env python3
"""One roll per browsing opportunity; no daily timetable. Python 3.10+, macOS/Linux."""
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import math
import os
from pathlib import Path
import random
import re
import tempfile
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parent.parent


def read_config(base=BASE):
    cfg = json.loads((base / "config.json").read_text())
    if type(cfg.get("dailyOpportunities")) is not int or cfg["dailyOpportunities"] < 0:
        raise ValueError("dailyOpportunities must be a nonnegative integer")
    weights = cfg.get("weights", {})
    if set(weights) != {"moyu", "chat", "quiet"} or any(
        not isinstance(n, (int, float)) or isinstance(n, bool) or not math.isfinite(n) or n < 0
        for n in weights.values()
    ) or not sum(weights.values()):
        raise ValueError("weights must contain moyu/chat/quiet with a positive total")
    for key, low, high in [("sourceCountMin", 1, 8), ("sourceCountMax", 1, 8),
                           ("avoidRecentRolls", 0, 10), ("itemsPerSource", 1, 10),
                           ("requestTimeoutSeconds", 1, 30)]:
        if type(cfg.get(key)) is not int or not low <= cfg[key] <= high:
            raise ValueError(f"invalid {key}")
    if cfg["sourceCountMin"] > cfg["sourceCountMax"]:
        raise ValueError("sourceCountMin exceeds sourceCountMax")
    if not isinstance(cfg.get("sources"), dict):
        raise ValueError("sources must be an object")
    for key, source in cfg["sources"].items():
        if not re.fullmatch(r"[a-z0-9_-]+", key) or not isinstance(source, dict):
            raise ValueError("invalid source key or definition")
        if source.get("kind") not in {"rss", "hn", "lobsters", "v2ex", "bluesky"}:
            raise ValueError(f"unsupported public reader: {key}")
        if not isinstance(source.get("url"), str) or not source["url"].startswith(("http://", "https://")):
            raise ValueError(f"invalid public source URL: {key}")
        if type(source.get("enabled")) is not bool:
            raise ValueError("enabled must be boolean")
    if not any(s.get("enabled") for s in cfg["sources"].values()):
        raise ValueError("enable at least one source")
    return cfg


def atomic_json(file, value):
    descriptor, tmp = tempfile.mkstemp(prefix=file.name + ".", suffix=".tmp", dir=file.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, file)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


@contextlib.contextmanager
def locked(base):
    with (base / ".moyu.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def current_state(base, date):
    file = base / "state.json"
    state = json.loads(file.read_text()) if file.exists() else {}
    if state.get("date") != date:
        return {"date": date, "opportunities": 0, "recent_sources": [], "rolls": 0}
    if not isinstance(state.get("opportunities"), int) or not isinstance(state.get("recent_sources"), list):
        raise ValueError("invalid state.json; repair it before resuming")
    return state


def choose_sources(cfg, state, rng):
    pool = [key for key, source in cfg["sources"].items() if source.get("enabled")]
    count = min(len(pool), rng.randint(cfg["sourceCountMin"], cfg["sourceCountMax"]))
    recent = state.get("recent_sources", [])[-cfg["avoidRecentRolls"]:] if cfg["avoidRecentRolls"] else []
    avoid = {key for group in recent for key in group}
    fresh = [key for key in pool if key not in avoid]
    picked = rng.sample(fresh, min(count, len(fresh)))
    if len(picked) < count:
        picked += rng.sample([key for key in pool if key not in picked], count - len(picked))
    return sorted(picked)


def decide(cfg, state, rng, manual=False):
    if not manual and state["opportunities"] >= cfg["dailyOpportunities"]:
        return {"kind": "quiet", "reason": "daily_limit", "sources": []}
    if not manual:
        state["opportunities"] += 1
    kind = "moyu" if manual else rng.choices(list(cfg["weights"]), weights=list(cfg["weights"].values()))[0]
    sources = []
    if kind == "moyu":
        keys = choose_sources(cfg, state, rng)
        state["recent_sources"] = (state.get("recent_sources", []) + [keys])[-10:]
        state["rolls"] = state.get("rolls", 0) + 1
        sources = [{"id": key, "name": cfg["sources"][key]["name"]} for key in keys]
    return {"kind": kind, "sources": sources, "opportunities": state["opportunities"],
            "daily_limit": cfg["dailyOpportunities"], "manual": manual}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["next", "opportunity", "show", "preview"], nargs="?", default="next")
    args = parser.parse_args()
    cfg = read_config()
    today = dt.datetime.now(ZoneInfo(os.getenv("MOYU_TIMEZONE", "Asia/Shanghai"))).date().isoformat()
    if args.command == "show":
        output = {"config": cfg, "state": current_state(BASE, today)}
    elif args.command == "preview":
        output = decide(cfg, current_state(BASE, today), random.Random())
        output["preview_only"] = True
    else:
        with locked(BASE):
            state = current_state(BASE, today)
            output = decide(cfg, state, random.Random(), manual=args.command == "next")
            atomic_json(BASE / "state.json", state)
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
