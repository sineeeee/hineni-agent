#!/usr/bin/env python3
"""Read only the selected public sources. No model, login, social writes or messages."""
import concurrent.futures
import datetime as dt
from html import unescape
from html.parser import HTMLParser
import json
import random
import sys
import subprocess
import shutil
import os
import fcntl
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dice import BASE, atomic_json, locked, read_config


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain(text):
    parser = PlainText()
    parser.feed(str(text or ""))
    return " ".join(unescape(" ".join(parser.parts)).split())


def request(url, timeout):
    if not url.startswith(("http://", "https://")):
        raise ValueError("HTTP(S) source required")
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (compatible; HineniPersonalReader/1.0)",
        "Accept": "application/json, application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.5",
    })
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read(2_000_001)
        if len(body) > 2_000_000:
            raise ValueError("Source exceeds 2 MB")
        return body


def normalize(source, title, url, excerpt="", scope="title_only", **extra):
    return {"source": source, "title": plain(title), "url": url,
            "excerpt": plain(excerpt)[:320], "content_scope": scope, **extra}


def parse_feed(source, body):
    root = ET.fromstring(body)
    items = root.findall(".//item")
    out = []
    if items:
        for item in items:
            description = item.findtext("description") or item.findtext("{http://purl.org/rss/1.0/modules/content/}encoded") or ""
            url = (item.findtext("link") or "").strip()
            if url.startswith(("http://", "https://")):
                out.append(normalize(source, item.findtext("title"), url, description,
                                     "feed_excerpt" if plain(description) else "title_only",
                                     published_at=item.findtext("pubDate")))
    else:
        ns = "{http://www.w3.org/2005/Atom}"
        for entry in root.findall(ns + "entry"):
            link = next((e.attrib.get("href", "") for e in entry.findall(ns + "link")
                         if e.attrib.get("rel", "alternate") == "alternate"), "")
            if link.startswith(("http://", "https://")):
                summary = entry.findtext(ns + "summary") or entry.findtext(ns + "content") or ""
                out.append(normalize(source, entry.findtext(ns + "title"), link, summary,
                                     "feed_excerpt" if plain(summary) else "title_only",
                                     published_at=entry.findtext(ns + "published") or entry.findtext(ns + "updated")))
    return out


# Read-only commands only. Credentials stay with OpenCLI's browser profiles.
BROWSER_COMMANDS = {("twitter", "timeline"), ("twitter", "trending"),
                    ("reddit", "popular"), ("xiaohongshu", "feed"), ("instagram", "explore")}


def browser_collect(key, source, count, base=BASE, port=19222):
    pair = (source.get("platform"), source.get("command"))
    if pair not in BROWSER_COMMANDS:
        raise ValueError("No supported read-only browser adapter")
    if not shutil.which("opencli"):
        raise ValueError("Install @jackwener/opencli and its browser extension first")
    # One browser command at a time, including concurrent fetch processes.
    with (base / ".browser.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = subprocess.run(["opencli", *pair, "--limit", str(count), "-f", "json"],
                                env={**os.environ, "OPENCLI_CDP_ENDPOINT": f"http://127.0.0.1:{port}"},
                                capture_output=True, text=True, timeout=min(90, max(5, int(source.get("timeoutSeconds", 60)))))
    if result.returncode:
        raise ValueError(f"OpenCLI exit {result.returncode}: browser unavailable, login required or source failed; run opencli doctor")
    payload = json.loads(result.stdout)
    if isinstance(payload, dict):
        if payload.get("ok") is False:
            raise ValueError("OpenCLI returned failure")
        payload = payload.get("data", payload)
    if isinstance(payload, dict):
        payload = payload.get("items", payload.get("rows"))
    if not isinstance(payload, list):
        raise ValueError("Unexpected OpenCLI result; inspect adapter output")
    out = []
    for row in payload[:count]:
        if not isinstance(row, dict):
            continue
        text = row.get("text") or row.get("caption") or row.get("title") or row.get("topic") or ""
        if not text:
            continue
        # Preserve real signed URLs. Never invent a post URL from a title/user.
        url = row.get("url") or row.get("permalink")
        if url and not str(url).startswith(("http://", "https://")):
            url = None
        if pair == ("twitter", "trending"):
            url = "https://x.com/search?q=" + urllib.parse.quote(str(row["topic"]))
        item = normalize(key, text[:100], url, text, "tool_excerpt", author=row.get("author") or row.get("user"))
        item["note"] = "Only the adapter's text excerpt was read; images/videos were not viewed."
        if pair == ("twitter", "trending"):
            item["note"] = "Trend label only; URL opens topic search, not an individual post."
        out.append(item)
    return out


def collect(key, source, cfg, reader=request, base=BASE):
    if source["kind"] == "opencli":
        return browser_collect(key, source, cfg["itemsPerSource"], base, cfg.get("browser", {}).get("port", 19222))
    timeout = cfg["requestTimeoutSeconds"]
    body = reader(source["url"], timeout)
    kind = source["kind"]
    count = cfg["itemsPerSource"]
    if kind == "rss":
        out = parse_feed(key, body)
    elif kind == "hn":
        ids = json.loads(body)[:30]
        chosen = random.sample(ids, min(count, len(ids)))
        def item(item_id):
            data = json.loads(reader(f"https://hacker-news.firebaseio.com/v0/item/{item_id}.json", timeout))
            if not data or data.get("deleted") or data.get("dead"):
                return None
            comments = f"https://news.ycombinator.com/item?id={item_id}"
            return normalize(key, data.get("title"), data.get("url") or comments, data.get("text", ""),
                             "post_excerpt" if data.get("text") else "title_only", comments_url=comments)
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            out = [x for x in pool.map(item, chosen) if x]
    elif kind == "v2ex":
        out = [normalize(key, x.get("title"), x["url"], x.get("content", ""),
                         "post_excerpt" if x.get("content") else "title_only") for x in json.loads(body)]
    elif kind == "lobsters":
        out = [normalize(key, x.get("title"), x.get("url") or x.get("comments_url"),
                         x.get("description", ""), "post_excerpt" if x.get("description") else "title_only",
                         comments_url=x.get("comments_url")) for x in json.loads(body)]
    elif kind == "bluesky":
        out = []
        for x in json.loads(body).get("feed", []):
            post = x.get("post", {})
            handle = post.get("author", {}).get("handle")
            post_id = post.get("uri", "").split("/")[-1]
            record = post.get("record", {})
            if handle and post_id:
                text = record.get("text", "")
                out.append(normalize(key, text[:90], f"https://bsky.app/profile/{handle}/post/{post_id}", text,
                                     "post_excerpt", published_at=record.get("createdAt")))
    else:
        raise ValueError(f"No verified reader for source {key}: {kind}")
    out = [x for x in out if x.get("title") and str(x.get("url", "")).startswith(("http://", "https://"))]
    return random.sample(out[:20], min(count, len(out[:20])))


def run(keys, base=BASE, reader=request):
    cfg = read_config(base)
    if not keys or len(keys) > 8 or len(set(keys)) != len(keys):
        raise ValueError("Pass 1–8 distinct source codes from dice.py")
    for key in keys:
        if key not in cfg["sources"] or not cfg["sources"][key].get("enabled"):
            raise ValueError(f"Disabled or unknown source: {key}")
    def fetch_one(key):
        try:
            items = collect(key, cfg["sources"][key], cfg, reader, base)
            return {"source": key, "name": cfg["sources"][key]["name"], "status": "ok" if items else "partial", "items": items}
        except Exception as exc:
            return {"source": key, "name": cfg["sources"][key]["name"], "status": "fail", "items": [], "error": str(exc)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        sources = list(pool.map(fetch_one, keys))
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    edition = {"fetched_at": now, "sources": sources,
               "note": "Fetched means read by the script, not shared with the user. Excerpts are not full article reads."}
    with locked(base):
        log_path = base / "fetch-log.jsonl"
        log = log_path.read_text().splitlines() if log_path.exists() else []
        for source in sources:
            prior = [json.loads(line) for line in log if json.loads(line).get("source") == source["source"]]
            streak = 0
            for old in reversed(prior):
                if old.get("status") != "fail":
                    break
                streak += 1
            source["consecutive_failures"] = streak + 1 if source["status"] == "fail" else 0
            log.append(json.dumps({"at": now, "source": source["source"], "status": source["status"],
                                   "items": len(source["items"]), "error": source.get("error", "")}, ensure_ascii=False))
        # Small bounded diagnostics; editions are replaced instead of accumulating forever.
        from tempfile import NamedTemporaryFile
        import os
        with NamedTemporaryFile("w", dir=base, prefix="fetch-log.", suffix=".tmp", delete=False) as file:
            file.write("\n".join(log[-200:]) + "\n")
            temp = file.name
        os.replace(temp, log_path)
        atomic_json(base / "last-edition.json", edition)
    return edition


def main():
    try:
        print(json.dumps(run(sys.argv[1:]), ensure_ascii=False, indent=2))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
