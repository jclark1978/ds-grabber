#!/usr/bin/env python3
"""Turn downloaded datasheets into one normalized models.json (+ CSV).

    python ds_normalize.py                 # reads datasheets/ + manifest.json
    python ds_normalize.py --check         # also print a per-file summary

Outputs:
    data/models.json             one record per model (hardware and VM)
    data/models.csv              flat table of the main comparison fields
    reports/unmapped_labels.txt  labels not in labels.yaml (kept under "other")
    reports/extraction.txt       per-datasheet row counts and problems
"""
from __future__ import annotations

import argparse
import csv
import fnmatch
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import yaml

from ds_extract import extract

ROOT = Path(__file__).parent
SCHEMA_VERSION = "1.0"
NONE_VALUES = {"", "—", "-", "–", "n/a", "n.a.", "na", "none", "not applicable", "not supported", "tba", "tbd"}


# --------------------------------------------------------------------------
# Value parsing
# --------------------------------------------------------------------------
def clean(raw: str) -> str:
    raw = unicodedata.normalize("NFKC", raw)
    raw = "".join(ch for ch in raw if not unicodedata.category(ch).startswith("M"))
    return " ".join(raw.replace("\u0007", "").split())


def is_none(raw: str) -> bool:
    s = clean(raw).strip("* ").lower()
    return s in NONE_VALUES or s.startswith(("tba", "tbd", "n/a ", "n.a. "))


NUM_RE = re.compile(
    r"(\d[\d,\s]*(?:\.\d+)?|\.\d+)\s*(million|mil|m|k|thousand)?\b", re.I)


def to_number(raw: str) -> float | None:
    """'24 Million' -> 24e6, '500 000' -> 500000, '106K' -> 106000, '48*' -> 48."""
    s = clean(raw).replace("*", "")
    m = re.search(r"(\d+(?:[ ,]\d{3})*(?:\.\d+)?)\s*(million|mil\b|m\b|k\b|thousand)?", s, re.I)
    if not m:
        return None
    n = float(re.sub(r"[ ,]", "", m.group(1)))
    mult = (m.group(2) or "").lower()
    if mult in ("million", "mil", "m"):
        n *= 1_000_000
    elif mult in ("k", "thousand"):
        n *= 1_000
    return int(n) if n == int(n) else n


def to_mbps(raw: str, default_unit: str | None = None) -> float | None:
    s = clean(raw)
    m = re.search(r"(\d+(?:[ ,]\d{3})*(?:\.\d+)?)\s*(Tbps|Gbps|Mbps|Kbps)?", s, re.I)
    if not m:
        return None
    n = float(re.sub(r"[ ,]", "", m.group(1)))
    unit = (m.group(2) or default_unit or "").lower()
    factor = {"tbps": 1_000_000, "gbps": 1000, "mbps": 1, "kbps": 0.001}.get(unit)
    if factor is None:
        return None
    v = round(n * factor, 3)
    return int(v) if v == int(v) else v


def parse_value(kind: str, raw: str, label: str):
    """Return {field_suffix_or_None: value}. None key = single value."""
    s = clean(raw)
    if is_none(s):
        return {None: None}
    if kind == "mbps":
        return {None: to_mbps(s)}
    if kind == "mbps_3":
        parts = [p.strip() for p in s.split("/")]
        unit = re.search(r"(Tbps|Gbps|Mbps)", s, re.I)
        unit = unit.group(1) if unit else None
        return {i: to_mbps(p, unit) for i, p in enumerate(parts[:3])}
    if kind == "count":
        return {None: to_number(s)}
    if kind == "pps":
        m = re.search(r"(\d+(?:\.\d+)?)\s*(Mpps|Kpps|pps)?", s, re.I)
        if not m:
            return {None: None}
        mult = {"mpps": 1_000_000, "kpps": 1000}.get((m.group(2) or "").lower(), 1)
        return {None: int(float(m.group(1)) * mult)}
    if kind == "us":
        m = re.search(r"(\d+(?:\.\d+)?)", s)
        return {None: float(m.group(1)) if m else None}
    if kind == "pair":
        parts = [p.strip() for p in s.split("/")]
        return {i: (None if is_none(p) else to_number(p)) for i, p in enumerate(parts[:2])}
    if kind == "list":
        return {None: [p.strip() for p in re.split(r",|;", s) if p.strip()]}
    if kind == "bool":
        low = s.lower()
        if s.startswith("✓") or low.startswith("yes") or low == "supported":
            return {None: True}
        if low.startswith("no"):
            return {None: False}
        return {None: None}
    return {None: s}


# --------------------------------------------------------------------------
# Model names
# --------------------------------------------------------------------------
def model_names(header: str) -> tuple[str, str]:
    """Header as printed -> (display name, model id)."""
    h = clean(header).upper().replace("FORTI GATE", "FORTIGATE").replace("FORTI WIFI", "FORTIWIFI")
    h = re.sub(r"^FORTIGATE[- ]VM", "VM", h)
    if h.startswith("VM"):
        code = h.replace("FORTIGATE", "").strip(" -")
        return f"FortiGate {code}", "FG-" + code.replace("VM-", "VM")
    for prefix, name, sku in (("FORTIGATE RUGGED ", "FortiGate Rugged", "FGR"), ("FGR-", "FortiGate Rugged", "FGR"),
                              ("FORTIWIFI ", "FortiWiFi", "FWF"), ("FWF-", "FortiWiFi", "FWF"),
                              ("FORTIGATE ", "FortiGate", "FG"), ("FORTIGATE-", "FortiGate", "FG"),
                              ("FG-", "FortiGate", "FG"), ("FGT-", "FortiGate", "FG")):
        if h.startswith(prefix):
            code = h[len(prefix):].strip()
            return f"{name} {code}", f"{sku}-{code}"
    return clean(header), clean(header)


# --------------------------------------------------------------------------
# Label mapping
# --------------------------------------------------------------------------
class LabelMap:
    def __init__(self, path: Path):
        cfg = yaml.safe_load(path.read_text())
        self.rules = []
        for group in ("performance", "capacity", "hardware", "vm"):
            for name, spec in (cfg.get(group) or {}).items():
                for pat in spec["patterns"]:
                    self.rules.append((re.compile(pat, re.I), group, name, spec))
        self.iface_sections = [s.lower() for s in cfg.get("interface_sections", [])]
        self.iface_re = re.compile(cfg.get("interface_label_re", r"$^"), re.I)
        self.exclude = cfg.get("exclude_files", [])

    def match(self, label: str):
        for rx, group, name, spec in self.rules:
            if rx.search(label):
                return group, name, spec
        return None

    def excluded(self, filename: str) -> bool:
        return any(fnmatch.fnmatch(filename, pat) for pat in self.exclude)


def split_label(label: str, notes: list[str]) -> tuple[str, list[str]]:
    """Move inline footnote markers ('NGFW Throughput 2, 4', 'Heat ... **') to notes."""
    label = clean(label)
    m = re.search(r"\s+((?:\d{1,2}|\*{1,2})(?:\s*,\s*(?:\d{1,2}|\*{1,2}))*)$", label)
    if m and not re.search(r"\(\s*[^)]*$", label[:m.start()]):
        notes = notes + [n.strip() for n in m.group(1).split(",")]
        label = label[:m.start()]
    if label.endswith("*"):
        notes = notes + ["*" * (len(label) - len(label.rstrip("*")))]
        label = label.rstrip("* ")
    return label, sorted(set(notes), key=notes.index)


# --------------------------------------------------------------------------
# Hardware derived fields
# --------------------------------------------------------------------------
def derive_hardware(hw_raw: dict) -> dict:
    out: dict = {}
    if "dimensions_mm" in hw_raw:
        nums = re.findall(r"\d+(?:\.\d+)?", hw_raw["dimensions_mm"])
        if len(nums) >= 3:
            out["dimensions_mm"] = {"h": float(nums[0]), "w": float(nums[1]), "l": float(nums[2])}
    if "weight" in hw_raw:
        m = re.search(r"(\d+(?:\.\d+)?)\s*kg", hw_raw["weight"], re.I)
        if m:
            out["weight_kg"] = float(m.group(1))
    if "form_factor" in hw_raw:
        m = re.search(r"(\d+)\s*-?\s*RU", hw_raw["form_factor"], re.I)
        out["rack_units"] = int(m.group(1)) if m else None
        out["desktop"] = "desktop" in hw_raw["form_factor"].lower()
    if "heat_dissipation" in hw_raw:
        v = to_number(hw_raw["heat_dissipation"])
        out["heat_btu_h"] = v
    if "redundant_psu" in hw_raw:
        out["redundant_psu"] = hw_raw["redundant_psu"].lower().startswith("yes")
    if "operating_temp" in hw_raw:
        m = re.search(r"\((-?\d+)\s*°?\s*C\s*(?:to|–|-)\s*(-?\d+)\s*°?\s*C\)", hw_raw["operating_temp"])
        if m:
            out["operating_temp_c"] = {"min": int(m.group(1)), "max": int(m.group(2))}
    return out


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
def build(ds_dir: Path, manifest: dict, lm: LabelMap):
    models: dict[str, dict] = {}
    unmapped: dict[str, set] = {}
    report = []
    dups: dict[str, set] = {}

    for pdf in sorted(ds_dir.glob("*.pdf"), key=lambda p: p.name.lower()):
        if lm.excluded(pdf.name):
            continue
        meta = manifest.get(pdf.name, {})
        try:
            ext = extract(pdf)
        except Exception as e:  # keep going; report it
            report.append(f"ERROR  {pdf.name}: {e.__class__.__name__}: {e}")
            continue
        n_rows = sum(len(t["rows"]) for t in ext["tables"])
        file_models: set[str] = set()
        mapped = 0
        url = meta.get("url")
        spec_page = ext["spec_pages"][0] if ext["spec_pages"] else None

        for table in ext["tables"]:
            for row in table["rows"]:
                label, notes = split_label(row["label"], row["notes"])
                hit = lm.match(label)
                iface = (not hit and (row.get("section") or "").lower() in lm.iface_sections
                         and lm.iface_re.search(label))
                if hit or iface:
                    mapped += 1
                for header, raw in row["values"].items():
                    name, mid = model_names(header)
                    file_models.add(mid)
                    rec = models.setdefault(mid, new_record(name, mid, pdf.name, meta, url, spec_page, ext))
                    if rec["source"]["file"] != pdf.name:
                        dups.setdefault(mid, {rec["source"]["file"]}).add(pdf.name)
                        continue  # same model in another datasheet; first one wins (see report)
                    raw_c = clean(raw)
                    if hit:
                        group, field, spec = hit
                        apply(rec, group, field, spec, raw_c, label, notes)
                    elif iface:
                        count = to_number(raw_c) if not is_none(raw_c) else 0
                        rec["hardware"].setdefault("interfaces", []).append(
                            {"type": label, "count": count, "raw": raw_c})
                    else:
                        rec["other"][label] = raw_c
                        unmapped.setdefault(label, set()).add(pdf.name)

        problems = []
        if not ext["spec_pages"]:
            problems.append("no spec page found")
        elif n_rows < 15:
            problems.append(f"only {n_rows} rows extracted")
        pct = f"{100 * mapped // n_rows}%" if n_rows else "-"
        report.append(f"{'OK   ' if not problems else 'CHECK'}  {pdf.name:42} pages={ext['spec_pages']} "
                      f"rows={n_rows:3} mapped={pct:>4} models={len(file_models)}"
                      + (f"  <- {'; '.join(problems)}" if problems else ""))

    if dups:
        report.append("")
        report.append("Models found in more than one datasheet (first file used):")
        for mid, files in sorted(dups.items()):
            report.append(f"  {mid}: {', '.join(sorted(files))}")
    for rec in models.values():
        rec["hardware"].update(derive_hardware(rec.pop("_hw_raw")))
        rec["form_factor"] = "vm" if rec["model_id"].startswith("FG-VM") else "appliance"
        if rec["form_factor"] == "vm":
            rec["hardware"] = None
        else:
            rec["vm"] = None
        used = {n for s in rec["specs"].values() for n in s.get("notes", [])}
        rec["footnotes"] = {k: v for k, v in rec["footnotes"].items() if k in used or k == "note"}
    return models, unmapped, report


def new_record(name, mid, file, meta, url, spec_page, ext):
    return {
        "model": name,
        "model_id": mid,
        "form_factor": None,
        "source": {
            "title": meta.get("title"),
            "url": url,
            "spec_url": f"{url}#page={spec_page}" if url and spec_page else url,
            "file": file,
            "library_last_updated": meta.get("last_updated"),
            "sha256": meta.get("sha256"),
        },
        "specs": {},
        "hardware": {},
        "vm": {},
        "footnotes": dict(ext["footnotes"]),
        "other": {},
        "_hw_raw": {},
    }


def apply(rec, group, field, spec, raw, label, notes):
    kind = spec["parse"]
    parsed = parse_value(kind, raw, label)
    if group in ("performance", "capacity"):
        names = spec.get("fields") or [field]
        for key, val in parsed.items():
            fname = names[0] if key is None else (names[key] if key < len(names) else None)
            if not fname:
                continue
            entry = {"value": val, "raw": raw, "label": label}
            if notes:
                entry["notes"] = notes
            rec["specs"][fname] = entry
    elif group == "hardware":
        if kind == "watts_pair":
            nums = [float(x) for x in re.findall(r"(\d+(?:\.\d+)?)", raw)][:2]
            if len(nums) == 2:
                avg, mx = (nums[1], nums[0]) if re.search(r"Maximum\s*/\s*Average", label, re.I) else nums
                rec["hardware"]["power_avg_w"], rec["hardware"]["power_max_w"] = avg, mx
            rec["hardware"]["power_raw"] = raw
        elif kind == "bool":
            rec["hardware"][field] = parsed[None]
        else:
            rec["_hw_raw"][field] = raw
            rec["hardware"][field + "_raw" if field in ("weight", "dimensions_mm", "heat_dissipation", "operating_temp") else field] = raw
    elif group == "vm":
        if kind == "pair":
            names = spec["fields"]
            for key, val in parsed.items():
                rec["vm"][names[key]] = val
        else:
            rec["vm"][field] = parsed[None] if kind == "bool" else raw


CSV_FIELDS = [
    "ips_throughput_mbps", "ngfw_throughput_mbps", "threat_protection_throughput_mbps",
    "fw_throughput_1518_mbps", "fw_throughput_512_mbps", "fw_throughput_64_mbps",
    "concurrent_sessions", "new_sessions_per_sec", "firewall_policies",
    "ipsec_throughput_mbps", "ipsec_tunnels_g2g", "ipsec_tunnels_c2g",
    "ssl_inspection_throughput_mbps", "app_control_throughput_mbps",
    "vdoms_default", "vdoms_max", "max_fortiswitches", "max_fortiaps_total", "max_fortitokens",
]


def write_outputs(models: dict, unmapped: dict, report: list[str], out_root: Path) -> None:
    data, reports = out_root / "data", out_root / "reports"
    data.mkdir(exist_ok=True)
    reports.mkdir(exist_ok=True)
    recs = sorted(models.values(), key=lambda r: (r["form_factor"], natural_key(r["model_id"])))
    doc = {
        "schema_version": SCHEMA_VERSION,
        "units": {"throughput": "Mbps", "latency": "microseconds", "power": "watts",
                  "weight": "kg", "dimensions": "mm"},
        "count": len(recs),
        "models": recs,
    }
    new = json.dumps(doc, indent=2, ensure_ascii=False) + "\n"
    path = data / "models.json"
    if not path.exists() or path.read_text() != new:  # only touch on real change
        path.write_text(new)

    write_split(recs, data)

    with open(data / "models.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["model_id", "model", "form_factor", "rack_units", "power_max_w"] + CSV_FIELDS + ["source_url"])
        for r in recs:
            hw = r["hardware"] or {}
            w.writerow([r["model_id"], r["model"], r["form_factor"], hw.get("rack_units"), hw.get("power_max_w")]
                       + [(r["specs"].get(k) or {}).get("value") for k in CSV_FIELDS]
                       + [r["source"]["spec_url"]])

    lines = [f"{len(unmapped)} labels not mapped in labels.yaml (kept under 'other').", ""]
    for label, files in sorted(unmapped.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        lines.append(f"{len(files):3}  {label}    [{', '.join(sorted(files)[:3])}{', ...' if len(files) > 3 else ''}]")
    (reports / "unmapped_labels.txt").write_text("\n".join(lines) + "\n")
    (reports / "extraction.txt").write_text("\n".join(report) + "\n")


def model_slug(model_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", model_id).strip("_")


def model_codes(rec: dict) -> list[str]:
    """Bare model codes a user might type, e.g. ['90G'], ['50G', '51G'],
    ['1800F', '1800F-DC'], ['VM04S', 'VM-04S']. Match after stripping
    'FortiGate'/'FortiWiFi'/'FG-'/'FWF-'/'FGR-' and spaces from user input."""
    prefix, _, code = rec["model_id"].partition("-")
    parts = [p.strip() for p in re.split(r"\s*/\s*", code) if p.strip()]
    base = parts[0] if parts else code
    out = []
    for p in parts or [code]:
        full = base + p if p.startswith("-") else p
        full = re.sub(r"^(FG|FWF|FGR)-", "", full)
        out.append(full.upper())
    if prefix == "FG" and code.startswith("VM"):
        out.append(code.replace("VM", "VM-", 1))
    return sorted(set(out), key=out.index)


def write_split(recs: list[dict], data: Path) -> None:
    """Small per-model files + an index, so an agent can fetch only what it needs."""
    mdir = data / "models"
    mdir.mkdir(exist_ok=True)
    keep = set()
    index = []
    for r in recs:
        slug = model_slug(r["model_id"])
        keep.add(f"{slug}.json")
        body = json.dumps(r, indent=2, ensure_ascii=False) + "\n"
        f = mdir / f"{slug}.json"
        if not f.exists() or f.read_text() != body:
            f.write_text(body)
        index.append({
            "model_id": r["model_id"],
            "model": r["model"],
            "form_factor": r["form_factor"],
            "file": f"data/models/{slug}.json",
            "family": {"FG": "FortiGate", "FWF": "FortiWiFi", "FGR": "FortiGate Rugged"}.get(
                r["model_id"].split("-")[0], "FortiGate"),
            "codes": model_codes(r),
            "spec_url": r["source"]["spec_url"],
        })
    for f in mdir.glob("*.json"):
        if f.name not in keep:
            f.unlink()
    body = json.dumps({"schema_version": SCHEMA_VERSION, "count": len(index),
                       "match_rule": "Strip 'FortiGate', 'FortiWiFi', 'Rugged', 'FGT', 'FG', 'FWF', 'FGR', "
                                     "spaces and leading dashes from the user's text, uppercase it, then "
                                     "compare to 'codes'. Use 'family' to tell FortiGate from FortiWiFi.",
                       "models": index}, indent=1, ensure_ascii=False) + "\n"
    f = data / "index.json"
    if not f.exists() or f.read_text() != body:
        f.write_text(body)


def natural_key(s: str):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", s)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--datasheets", default=str(ROOT / "datasheets"))
    ap.add_argument("--manifest", default=str(ROOT / "manifest.json"))
    ap.add_argument("--labels", default=str(ROOT / "labels.yaml"))
    ap.add_argument("--out", default=str(ROOT))
    ap.add_argument("--check", action="store_true", help="print the per-datasheet report")
    args = ap.parse_args()

    manifest = {}
    if Path(args.manifest).exists():
        manifest = json.loads(Path(args.manifest).read_text()).get("datasheets", {})
    lm = LabelMap(Path(args.labels))
    models, unmapped, report = build(Path(args.datasheets), manifest, lm)
    write_outputs(models, unmapped, report, Path(args.out))
    if args.check:
        print("\n".join(report))
    print(f"models.json: {len(models)} models; {len(unmapped)} unmapped labels (see reports/)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
