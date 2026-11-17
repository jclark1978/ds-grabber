#!/usr/bin/env python3
"""FortiGate side-by-side comparison from ds-grabber data.

    python compare.py table  90G 120G                 # markdown table for chat
    python compare.py report 90G 120G -o out.html     # branded HTML report
    python compare.py find   50G                      # show what a name matches

Data comes from https://raw.githubusercontent.com/jclark1978/ds-grabber/main/
or from a local clone with --data /path/to/ds-grabber. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

DATA_BASE = "https://raw.githubusercontent.com/jclark1978/ds-grabber/main/"
HERE = Path(__file__).resolve().parent
TEMPLATE = HERE.parent / "templates" / "report.html"

# (field, label, kind, direction) direction: 1 higher is better, -1 lower is better
TABLE_ROWS = [
    ("threat_protection_throughput_mbps", "Threat Protection Throughput", "mbps", 1),
    ("ngfw_throughput_mbps", "NGFW Throughput", "mbps", 1),
    ("ips_throughput_mbps", "IPS Throughput", "mbps", 1),
    ("ssl_inspection_throughput_mbps", "SSL Inspection Throughput", "mbps", 1),
    ("fw_throughput_1518_mbps", "Firewall Throughput (1518 B UDP)", "mbps", 1),
    ("fw_throughput_64_mbps", "Firewall Throughput (64 B UDP)", "mbps", 1),
    ("concurrent_sessions", "Concurrent Sessions", "count", 1),
    ("new_sessions_per_sec", "New Sessions/Sec", "count", 1),
    ("firewall_policies", "Firewall Policies", "count", 1),
    ("ipsec_throughput_mbps", "IPsec VPN Throughput", "mbps", 1),
    ("ipsec_tunnels_g2g", "Site-to-Site IPsec Tunnels", "count", 1),
    ("ipsec_tunnels_c2g", "Client-to-Site IPsec Tunnels", "count", 1),
    ("vdoms_max", "VDOMs (Max)", "count", 1),
    ("max_fortiswitches", "Max FortiSwitches", "count", 1),
    ("max_fortiaps_total", "Max FortiAPs", "count", 1),
]


# --------------------------------------------------------------------------
def fetch_json(rel: str, data_dir: str | None):
    if data_dir:
        return json.loads((Path(data_dir) / rel).read_text())
    with urllib.request.urlopen(DATA_BASE + rel, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def norm(text: str) -> str:
    t = text.upper()
    t = re.sub(r"FORTI\s*GATE|FORTI\s*WIFI|RUGGED|\bFGT\b", "", t)
    t = re.sub(r"^\s*(FG|FWF|FGR)\s*-?", "", t.strip())
    return re.sub(r"\s+", "", t).lstrip("-")


def family_hint(text: str) -> str | None:
    t = text.upper()
    if "WIFI" in t or t.startswith("FWF"):
        return "FortiWiFi"
    if "RUGGED" in t or t.startswith("FGR"):
        return "FortiGate Rugged"
    return None


def resolve(name: str, index: dict) -> list[dict]:
    """Return candidate index entries for a user-typed model name."""
    exact = [m for m in index["models"] if m["model_id"].upper() == name.strip().upper()]
    if exact:
        return exact
    code, fam = norm(name), family_hint(name)
    hits = [m for m in index["models"] if code in m["codes"]]
    if fam:
        hits = [m for m in hits if m["family"] == fam]
    elif len(hits) > 1:  # plain "70G" means FortiGate unless the user said otherwise
        fg = [m for m in hits if m["family"] == "FortiGate"]
        hits = fg or hits
    return hits


def load(names: list[str], data_dir: str | None) -> tuple[list[dict], list[str]]:
    index = fetch_json("data/index.json", data_dir)
    models, problems = [], []
    for n in names:
        hits = resolve(n, index)
        if not hits:
            code = norm(n)
            near = sorted({c for m in index["models"] for c in m["codes"]
                           if c.startswith(code[:3]) or code[:3] in c})[:10]
            problems.append(f"'{n}': not found in the datasheet index"
                            + (f" (close codes: {', '.join(near)})" if near else ""))
        elif len(hits) > 1:
            problems.append(f"'{n}': ambiguous, matches " + ", ".join(h["model_id"] for h in hits))
        else:
            models.append(fetch_json(hits[0]["file"], data_dir))
    return models, problems


# --------------------------------------------------------------------------
def fmt(v, kind):
    if v is None:
        return None
    if kind == "mbps":
        return f"{v / 1000:,.2f}".rstrip("0").rstrip(".") + " Gbps" if v >= 1000 else f"{v:,g} Mbps"
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, (int, float)):
        return f"{v:,g}" if isinstance(v, float) else f"{v:,}"
    return str(v)


def cell(m: dict, key: str, kind: str) -> tuple[str, float | None]:
    s = (m.get("specs") or {}).get(key)
    if not s:
        return "not listed", None
    txt = fmt(s.get("value"), kind)
    if txt is None:
        txt = s.get("raw") or "n/a"
    return txt, s.get("value") if isinstance(s.get("value"), (int, float)) else None


def table(models: list[dict]) -> str:
    names = [m["model"] for m in models]
    two = len(models) == 2
    hdr = ["Spec"] + names + ([f"{names[1]} vs {names[0]}"] if two else [])
    lines = ["| " + " | ".join(hdr) + " |", "|" + "---|" * len(hdr)]
    for key, label, kind, direction in TABLE_ROWS:
        if not any((m.get("specs") or {}).get(key) for m in models):
            continue
        cells = [cell(m, key, kind) for m in models]
        vals = [v for _, v in cells if v is not None]
        best = None
        if len(vals) > 1 and len(set(vals)) > 1:
            best = max(vals) if direction > 0 else min(vals)
        row = [label] + [f"**{t}**" if best is not None and v == best else t for t, v in cells]
        if two:
            a, b = cells[0][1], cells[1][1]
            if a and b is not None:
                pct = (b - a) / a * 100
                row.append("same" if a == b else (f"{pct:+.1f}%" if abs(pct) < 1 else f"{pct:+.0f}%"))
            else:
                row.append("")
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")
    for m in models:
        lines.append(f"- {m['model']} datasheet: {m['source'].get('spec_url') or m['source'].get('url')}")
    vm = [m for m in models if m.get("form_factor") == "vm"]
    if vm and len(vm) < len(models):
        lines.append("- Note: the FortiGate VM datasheet lists capacity only, not throughput.")
    lines.append("- All performance values are \"up to\" per Fortinet; see each datasheet's footnotes for test conditions.")
    return "\n".join(lines)


def report(models: list[dict], out: Path) -> Path:
    html = TEMPLATE.read_text(encoding="utf-8")
    payload = json.dumps(models, ensure_ascii=False).replace("</", "<\\/")
    marker = '<script id="ds-data" type="application/json">[]</script>'
    if marker not in html:
        raise SystemExit("Template is missing the ds-data placeholder.")
    out.write_text(html.replace(marker, f'<script id="ds-data" type="application/json">{payload}</script>'),
                   encoding="utf-8")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["table", "report", "find", "json"])
    ap.add_argument("models", nargs="+", help="model names, e.g. 90G 'FortiGate 120G' FWF-70G")
    ap.add_argument("-o", "--out", help="report output path")
    ap.add_argument("--data", help="local ds-grabber clone instead of GitHub")
    a = ap.parse_args()

    if a.mode == "find":
        index = fetch_json("data/index.json", a.data)
        for n in a.models:
            hits = resolve(n, index)
            print(f"{n}: " + (", ".join(f"{h['model_id']} ({h['family']})" for h in hits) or "no match"))
        return 0

    if len(a.models) > 4:
        print("Compare up to 4 models at a time.", file=sys.stderr)
        return 2
    models, problems = load(a.models, a.data)
    if problems:
        print("Could not resolve every model:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 3
    if a.mode == "json":
        print(json.dumps(models, indent=1, ensure_ascii=False))
    elif a.mode == "table":
        print(table(models))
    else:
        ids = "-vs-".join(re.sub(r"[^A-Za-z0-9]+", "", m["model_id"]) for m in models)
        out = Path(a.out or f"fortigate-comparison-{ids}.html")
        print(report(models, out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
