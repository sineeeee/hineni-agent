#!/usr/bin/env python3
"""Choose public sources for one browsing task. Python 3.10+, macOS/Linux."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import random
import tempfile

BASE = Path(__file__).resolve().parent.parent


# Rules shipped with this Skill. Edit here when changing its browsing behavior.
RULES = {'sourceCountMin': 2,
 'sourceCountMax': 3,
 'avoidRecentRolls': 1,
 'itemsPerSource': 4,
 'requestTimeoutSeconds': 10,
 'sources': {'d': {'name': 'Hacker News',
                   'enabled': True,
                   'kind': 'hn',
                   'url': 'https://hacker-news.firebaseio.com/v0/topstories.json'},
             'e': {'name': 'Lobsters',
                   'enabled': True,
                   'kind': 'lobsters',
                   'url': 'https://lobste.rs/hottest.json'},
             'h': {'name': 'V2EX',
                   'enabled': True,
                   'kind': 'v2ex',
                   'url': 'https://www.v2ex.com/api/topics/hot.json'},
             'i': {'name': 'Product Hunt',
                   'enabled': True,
                   'note': '公开Atom订阅',
                   'kind': 'rss',
                   'url': 'https://www.producthunt.com/feed'},
             'm': {'name': 'Bluesky 热门',
                   'enabled': True,
                   'kind': 'bluesky',
                   'url': 'https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=at%3A%2F%2Fdid%3Aplc%3Az72i7hdynmk6r22z27h6tvur%2Fapp.bsky.feed.generator%2Fwhats-hot&limit=20'},
             'n': {'name': 'Tildes',
                   'enabled': True,
                   'note': '公开Atom订阅',
                   'kind': 'rss',
                   'url': 'https://tildes.net/topics.atom'},
             'o': {'name': 'MetaFilter',
                   'enabled': True,
                   'note': '公开RSS订阅',
                   'kind': 'rss',
                   'url': 'https://feeds.feedburner.com/Metafilter'},
             'p': {'name': 'Colossal',
                   'enabled': True,
                   'kind': 'rss',
                   'url': 'https://www.thisiscolossal.com/feed/'},
             'q': {'name': 'Neatorama',
                   'enabled': True,
                   'kind': 'rss',
                   'url': 'https://www.neatorama.com/feed/'}}}


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


def current_state(base):
    file = base / "state.json"
    state = json.loads(file.read_text()) if file.exists() else {}
    recent = state.get("recent_sources", [])
    if not isinstance(recent, list):
        raise ValueError("invalid state.json recent_sources")
    return {"recent_sources": recent, "rolls": state.get("rolls", 0)}


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


def decide(cfg, state, rng):
    keys = choose_sources(cfg, state, rng)
    state["recent_sources"] = (state.get("recent_sources", []) + [keys])[-10:]
    state["rolls"] = state.get("rolls", 0) + 1
    return {"sources": [{"id": key, "name": cfg["sources"][key]["name"]} for key in keys]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["next", "show", "preview"], nargs="?", default="next")
    args = parser.parse_args()
    cfg = RULES
    if args.command == "show":
        output = {"config": cfg, "state": current_state(BASE)}
    elif args.command == "preview":
        output = decide(cfg, current_state(BASE), random.Random())
        output["preview_only"] = True
    else:
        with locked(BASE):
            state = current_state(BASE)
            output = decide(cfg, state, random.Random())
            atomic_json(BASE / "state.json", state)
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
