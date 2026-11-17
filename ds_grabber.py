#!/usr/bin/env python3
"""ds-grabber: keep a local, current library of Fortinet datasheets.

Loads the Fortinet datasheet library (JavaScript-rendered) in headless
Chromium, clicks "Load More" until every result is listed, keeps the
datasheets whose title matches the filter (default: FortiGate), downloads
new or changed PDFs, and records everything in manifest.json.

Usage:
    python ds_grabber.py                     # FortiGate datasheets
    python ds_grabber.py --match FortiSwitch # any keyword (regex, case-insensitive)
    python ds_grabber.py --match .           # every datasheet in the library
    python ds_grabber.py --list-only         # show what would be downloaded
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests

LIBRARY_URL = "https://www.fortinet.com/resources/data-sheets"
BASE = "https://www.fortinet.com"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
DATE_RE = re.compile(r"(\d{1,2}/\d{1,2}/\d{4})")


# --------------------------------------------------------------------------
# Discovery
# --------------------------------------------------------------------------
# Runs in the page: collect every PDF link plus the text of its card so we
# can pull out the title and the "Last updated" date.
COLLECT_JS = r"""
() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!/\.pdf(\?|#|$)/i.test(href)) continue;
    if (!/data-?sheet/i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    // Walk up to the nearest container that also holds the date text.
    let card = a;
    for (let i = 0; i < 6 && card.parentElement; i++) {
      card = card.parentElement;
      if (/Last updated/i.test(card.innerText || '')) break;
    }
    out.push({
      href,
      link_text: (a.innerText || a.getAttribute('title') || '').trim(),
      card_text: (card.innerText || '').trim().slice(0, 600),
    });
  }
  return out;
}
"""


def discover(headless: bool = True, max_clicks: int = 100) -> list[dict]:
    """Return every datasheet listed in the library."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page(user_agent=USER_AGENT)
        page.goto(LIBRARY_URL, wait_until="networkidle", timeout=90_000)

        # Dismiss the cookie banner if present; it can block clicks.
        for label in ("Accept All", "Accept all", "Accept", "I Accept"):
            btn = page.get_by_role("button", name=label)
            if btn.count():
                try:
                    btn.first.click(timeout=3_000)
                    break
                except Exception:
                    pass

        # Click "Load More" until it disappears or stops adding results.
        last = -1
        for clicks in range(max_clicks):
            count = len(page.evaluate(COLLECT_JS))
            if count == last:
                break
            last = count
            more = page.locator("a, button").filter(has_text=re.compile(r"load\s+\d*\s*more", re.I))
            if not more.count() or not more.first.is_visible():
                break
            try:
                more.first.scroll_into_view_if_needed(timeout=5_000)
                more.first.click(timeout=10_000)
                page.wait_for_load_state("networkidle", timeout=30_000)
            except Exception:
                time.sleep(2)
        raw = page.evaluate(COLLECT_JS)
        browser.close()

    print(f"Library: {len(raw)} datasheet PDFs found after {clicks} 'Load More' clicks")
    return [parse_card(r) for r in raw]


def parse_card(r: dict) -> dict:
    lines = [l.strip() for l in r["card_text"].splitlines() if l.strip()]
    title = r["link_text"] or next((l for l in lines if "data" in l.lower()), "")
    if not title:
        title = Path(urlparse(r["href"]).path).stem.replace("-", " ").title()
    m = DATE_RE.search(r["card_text"])
    updated = None
    if m:
        try:
            updated = datetime.strptime(m.group(1), "%m/%d/%Y").date().isoformat()
        except ValueError:
            pass
    return {"title": " ".join(title.split()), "url": urljoin(BASE, r["href"]), "last_updated": updated}


# --------------------------------------------------------------------------
# Download + manifest
# --------------------------------------------------------------------------
def load_manifest(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text())
    return {"generated": None, "source": LIBRARY_URL, "datasheets": {}}


def filename_for(url: str) -> str:
    return Path(urlparse(url).path).name


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sync(items: list[dict], out_dir: Path, manifest_path: Path, force: bool = False) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / "_archive"
    manifest = load_manifest(manifest_path)
    entries = manifest["datasheets"]
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    stats = {"new": [], "updated": [], "unchanged": [], "failed": []}

    for item in sorted(items, key=lambda i: i["title"].lower()):
        name = filename_for(item["url"])
        prev = entries.get(name)
        dest = out_dir / name

        # Skip the download when the library date hasn't moved and we have the file.
        if (not force and prev and dest.exists()
                and item["last_updated"] and prev.get("last_updated") == item["last_updated"]):
            stats["unchanged"].append(name)
            continue

        try:
            resp = session.get(item["url"], timeout=60)
            resp.raise_for_status()
            data = resp.content
            if not data.startswith(b"%PDF"):
                raise ValueError("response is not a PDF")
        except Exception as e:
            print(f"  FAILED  {name}: {e}", file=sys.stderr)
            stats["failed"].append(name)
            continue

        digest = sha256(data)
        if prev and prev.get("sha256") == digest and dest.exists():
            prev["last_updated"] = item["last_updated"]
            stats["unchanged"].append(name)
            continue

        if prev and dest.exists():
            archive.mkdir(exist_ok=True)
            stamp = prev.get("last_updated") or prev.get("downloaded", "old")[:10]
            dest.rename(archive / f"{dest.stem}_{stamp}{dest.suffix}")
            stats["updated"].append(name)
            print(f"  UPDATED {name}")
        else:
            stats["new"].append(name)
            print(f"  NEW     {name}")

        dest.write_bytes(data)
        entries[name] = {
            "title": item["title"],
            "url": item["url"],
            "last_updated": item["last_updated"],
            "downloaded": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sha256": digest,
            "bytes": len(data),
        }

    manifest["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    write_index(entries, out_dir / "INDEX.md")
    return stats


def write_index(entries: dict, path: Path) -> None:
    rows = sorted(entries.items(), key=lambda kv: kv[1]["title"].lower())
    lines = [
        "# Datasheet index",
        "",
        f"{len(rows)} datasheets. Generated by ds-grabber from {LIBRARY_URL}.",
        "",
        "| Datasheet | Last updated (Fortinet) | File |",
        "|---|---|---|",
    ]
    for name, e in rows:
        lines.append(f"| [{e['title']}]({e['url']}) | {e.get('last_updated') or 'n/a'} | [{name}]({name}) |")
    path.write_text("\n".join(lines) + "\n")


# --------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--match", default="FortiGate", help="regex matched against title and filename (default: FortiGate)")
    ap.add_argument("--out", default="datasheets", help="output folder (default: datasheets)")
    ap.add_argument("--manifest", default="manifest.json")
    ap.add_argument("--list-only", action="store_true", help="list matches without downloading")
    ap.add_argument("--force", action="store_true", help="re-download everything")
    ap.add_argument("--headed", action="store_true", help="show the browser (debugging)")
    args = ap.parse_args()

    pattern = re.compile(args.match, re.I)
    items = discover(headless=not args.headed)
    matches = [i for i in items if pattern.search(i["title"]) or pattern.search(filename_for(i["url"]))]
    print(f"Matched '{args.match}': {len(matches)} datasheets")

    if not items:
        print("ERROR: no datasheets found; the library page layout may have changed.", file=sys.stderr)
        return 2

    if args.list_only:
        for i in sorted(matches, key=lambda i: i["title"].lower()):
            print(f"  {i['last_updated'] or '----------'}  {i['title']}\n      {i['url']}")
        return 0

    stats = sync(matches, Path(args.out), Path(args.manifest), force=args.force)
    print(
        f"Done: {len(stats['new'])} new, {len(stats['updated'])} updated, "
        f"{len(stats['unchanged'])} unchanged, {len(stats['failed'])} failed"
    )
    return 1 if stats["failed"] and not (stats["new"] or stats["updated"] or stats["unchanged"]) else 0


if __name__ == "__main__":
    sys.exit(main())
