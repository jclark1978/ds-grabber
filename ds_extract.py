#!/usr/bin/env python3
"""Extract the raw specification tables from Fortinet datasheet PDFs.

Fortinet spec tables are not ruled tables, so generic table extractors miss
them. This module reads word positions instead:

* the model header line (e.g. "FORTIGATE 120G  FORTIGATE 121G", "FG-70G ...")
  defines the value columns; one or two tables can sit side by side;
* labels sit in the left column of each table and may wrap onto extra lines
  (wrapped lines are ~6.5pt apart, new rows ~11.8pt);
* footnote markers are small superscripts after the label;
* a value shared by several models is printed once, centered across their
  columns, so values are mapped to contiguous column ranges by position.

Output is lossless: every label and value exactly as printed, plus page,
section, footnote markers and footnote text.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pymupdf

MODEL_RE = re.compile(r"^(FORTI\s?GATE|FORTI\s?WIFI|FORTIGATE-|FG-|FGR-|FWF-|FGT-|VM-?\d|VM-?UL)", re.I)
FOOTNOTE_START_RE = re.compile(r"^(Note:|\*{1,2}\s)")
PUA_RE = re.compile(r"[-]")  # icon-font glyphs used as check marks

SUPERSCRIPT_MAX_SIZE = 5.0
SAME_LINE_TOL = 1.6
LABEL_WRAP_MAX_GAP = 9.0


class Span:
    __slots__ = ("x0", "x1", "y", "size", "text")

    def __init__(self, s):
        self.x0, y0, self.x1, _ = s["bbox"]
        self.y = round(y0, 1)
        self.size = s["size"]
        self.text = PUA_RE.sub("✓", s["text"]).strip()

    @property
    def cx(self):
        return (self.x0 + self.x1) / 2


def page_spans(page) -> list[Span]:
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                sp = Span(s)
                if sp.text:
                    out.append(sp)
    return out


def group_lines(spans: list[Span]) -> list[list[Span]]:
    lines: list[list[Span]] = []
    for s in sorted(spans, key=lambda s: (s.y, s.x0)):
        if lines and abs(lines[-1][0].y - s.y) <= SAME_LINE_TOL:
            lines[-1].append(s)
        else:
            lines.append([s])
    return [sorted(l, key=lambda s: s.x0) for l in lines]


def merge_groups(spans: list[Span], gap: float = 3.5) -> list[dict]:
    """Merge horizontally adjacent spans into value groups."""
    groups: list[dict] = []
    for s in sorted(spans, key=lambda s: s.x0):
        if groups and s.x0 - groups[-1]["x1"] <= gap:
            groups[-1]["text"] += " " + s.text
            groups[-1]["x1"] = s.x1
        else:
            groups.append({"x0": s.x0, "x1": s.x1, "text": s.text})
    for g in groups:
        g["cx"] = (g["x0"] + g["x1"]) / 2
        g["text"] = " ".join(g["text"].split())
    return groups


def assign_columns(groups: list[dict], centers: list[float]) -> list[tuple[int, int, str]]:
    """Map value groups to contiguous column ranges (DP over partitions)."""
    groups = [dict(g) for g in groups]
    n = len(centers)
    while len(groups) > n:  # more groups than columns: merge the closest pair
        i = min(range(len(groups) - 1), key=lambda i: groups[i + 1]["x0"] - groups[i]["x1"])
        a, b = groups[i], groups.pop(i + 1)
        a["text"] += " " + b["text"]
        a["x1"] = b["x1"]
        a["cx"] = (a["x0"] + a["x1"]) / 2
    k = len(groups)
    INF = float("inf")
    # best[i][j] = min cost placing first i groups over first j columns
    best = [[INF] * (n + 1) for _ in range(k + 1)]
    back = [[0] * (n + 1) for _ in range(k + 1)]
    best[0][0] = 0
    for i in range(1, k + 1):
        for j in range(i, n + 1):
            for s in range(i - 1, j):
                c = best[i - 1][s]
                if c == INF:
                    continue
                cost = c + abs(groups[i - 1]["cx"] - (centers[s] + centers[j - 1]) / 2)
                if cost < best[i][j]:
                    best[i][j], back[i][j] = cost, s
    out, j = [], n
    for i in range(k, 0, -1):
        s = back[i][j]
        out.append((s, j - 1, groups[i - 1]["text"]))
        j = s
    return out[::-1]


def append_wrapped(cur: dict, value_sp: list, models: list[str]) -> None:
    """Wrapped value text: append to the nearest value group's models."""
    for g in merge_groups(value_sp):
        if cur["_groups"]:
            _, a, b = min(cur["_groups"], key=lambda t: abs(t[0] - g["cx"]))
        else:
            a, b = 0, len(models) - 1
        for m in models[a:b + 1]:
            cur["values"][m] = (cur["values"].get(m, "") + " " + g["text"]).strip()


def find_spec_pages(doc) -> list[int]:
    pages = []
    for i, p in enumerate(doc):
        txt = p.get_text()
        if re.search(r"^\s*Specifications\s*$", txt, re.M | re.I) and any(MODEL_RE.match(l.strip()) for l in txt.splitlines()):
            pages.append(i)
    return pages


BARE_MODEL_RE = re.compile(r"^\d{2,4}[A-Za-z]")
PREFIX_RE = re.compile(r"^FORTI\s?(GATE|WIFI)$", re.I)


def header_models(line: list[Span]) -> list[Span] | None:
    """Return the model-column spans if this line is a model header.

    Handles 'FORTIGATE 120G  FORTIGATE 121G', 'FG-70G  FG-71G', and the split
    form where 'FORTIGATE' sits in the label column above bare '4400F/-DC'."""
    normal = [s for s in line if s.size > SUPERSCRIPT_MAX_SIZE]
    if not normal:
        return None
    if normal[0].x0 > 120 and all(MODEL_RE.match(s.text) for s in normal):
        return normal
    cols, prefix = [], None
    for s in normal:
        if PREFIX_RE.match(s.text) and s.x0 < 120 + (normal[0].x0 if prefix is None else 0):
            prefix = s.text
            continue
        if PREFIX_RE.match(s.text):  # repeated prefix for a second side-by-side table
            prefix = s.text
            continue
        if prefix and BARE_MODEL_RE.match(s.text):
            sp = Span.__new__(Span)
            sp.x0, sp.x1, sp.y, sp.size = s.x0, s.x1, s.y, s.size
            sp.text = f"{prefix.upper()} {s.text.upper()}"
            cols.append(sp)
        else:
            return None
    return cols or None


def header_line(lines: list[list[Span]]) -> int | None:
    for idx, l in enumerate(lines):
        if header_models(l):
            return idx
    return None


def clean_model(name: str) -> str:
    return " ".join(name.replace("\n", " ").split()).rstrip("*").strip()


def extract_page(page, page_no: int) -> dict:
    spans = page_spans(page)
    lines = group_lines(spans)
    hi = header_line(lines)
    if hi is None:
        return {"page": page_no, "tables": [], "footnotes": {}}
    header = header_models(lines[hi])

    # Cluster header spans into side-by-side tables (big gap = new table).
    tables_hdr = [[header[0]]]
    for s in header[1:]:
        if s.x0 - tables_hdr[-1][-1].x1 > 100:
            tables_hdr.append([s])
        else:
            tables_hdr[-1].append(s)
    width = page.rect.width
    header_y0 = lines[hi][0].y
    # Only treat a gap as a second table if that side has its own label column
    # (several lines starting at the same x, left of its first model column).
    note_y = min((sp.y for sp in spans if sp.text.startswith("Note:")), default=1e9)
    merged = [tables_hdr[0]]
    for grp in tables_hdr[1:]:
        lo_x = merged[-1][-1].x1 + 5
        starts = [round(sp.x0) for sp in spans
                  if header_y0 + 2 < sp.y < note_y and lo_x <= sp.x0 < grp[0].x0 - 60 and sp.size > SUPERSCRIPT_MAX_SIZE
                  and sp.text[:1].isalpha() and sp.x1 - sp.x0 > 25]
        common = max((starts.count(x) + starts.count(x + 1) + starts.count(x - 1) for x in set(starts)), default=0)
        if common >= 3:
            merged.append(grp)
        else:
            merged[-1] = merged[-1] + grp
    tables_hdr = merged
    # Single-model pages may print the model header only once, over the left
    # table, with a second label/value table on the right half.
    if len(tables_hdr) == 1 and len(tables_hdr[0]) == 1:
        mid = width / 2
        starts = [round(sp.x0) for sp in spans
                  if header_y0 + 2 < sp.y < note_y and mid <= sp.x0 < mid + 40
                  and sp.size > SUPERSCRIPT_MAX_SIZE and sp.text[:1].isalpha() and sp.x1 - sp.x0 > 25]
        common = max((starts.count(x) + starts.count(x + 1) + starts.count(x - 1) for x in set(starts)), default=0)
        if common >= 3:
            twin = Span.__new__(Span)
            h = tables_hdr[0][0]
            twin.x0, twin.x1, twin.y, twin.size, twin.text = h.x0 + mid, h.x1 + mid, h.y, h.size, h.text
            tables_hdr.append([twin])
    n_tab = len(tables_hdr)
    bounds = [(width * t / n_tab, width * (t + 1) / n_tab) for t in range(n_tab)]
    if n_tab == 1:
        bounds = [(0, width)]

    header_y = lines[hi][0].y
    body = [s for s in spans if s.y > header_y + SAME_LINE_TOL]
    tables, foot_spans = [], []

    for (lo, hi_x), hdr in zip(bounds, tables_hdr):
        region = [s for s in body if lo <= s.x0 < hi_x]
        if not region:
            continue
        models = [clean_model(s.text) for s in hdr]
        centers = [s.cx for s in hdr]
        label_left = min(s.x0 for s in region if s.size > SUPERSCRIPT_MAX_SIZE)
        rows, section, cur, last_label_y = [], None, None, -99.0
        in_foot = False

        for line in group_lines(region):
            normal = [s for s in line if s.size > SUPERSCRIPT_MAX_SIZE]
            marks = [s for s in line if s.size <= SUPERSCRIPT_MAX_SIZE]
            label_sp = [s for s in normal if s.x0 < label_left + 10]
            label_text = " ".join(s.text for s in label_sp)
            value_free = all(s in label_sp for s in normal)
            key_first = bool(marks) and normal and marks[0].x0 < normal[0].x0 and marks[0].x0 <= label_left + 2
            if in_foot or (value_free and label_sp and (FOOTNOTE_START_RE.match(label_text) or key_first)):
                in_foot = True
                foot_spans.extend(line)
                continue
            # A new model header inside the region (stacked tables).
            hdr2 = header_models(line)
            if hdr2 and (hdr2[0].x0 > label_left + 60):
                models = [clean_model(s.text) for s in hdr2]
                centers = [s.cx for s in hdr2]
                cur = None
                continue
            value_sp = [s for s in normal if s not in label_sp]
            mark_txt = [m.text for m in marks]
            y = line[0].y

            if label_sp and value_sp and cur is not None and y - last_label_y < LABEL_WRAP_MAX_GAP:
                # Label and value both wrapped onto this line.
                cur["label"] += " " + label_text
                cur["notes"] += mark_txt
                last_label_y = y
                append_wrapped(cur, value_sp, models)
            elif label_sp and value_sp:
                cur = {"section": section, "label": label_text, "notes": mark_txt,
                       "values": {}, "_groups": []}
                groups = merge_groups(value_sp)
                for a, b, txt in assign_columns(groups, centers):
                    for m in models[a:b + 1]:
                        cur["values"][m] = txt
                cur["_groups"] = [(g["cx"], a, b) for g, (a, b, _) in zip(groups, assign_columns(groups, centers))] \
                    if len(groups) <= len(centers) else []
                rows.append(cur)
                last_label_y = y
            elif label_sp:
                if cur is not None and y - last_label_y < LABEL_WRAP_MAX_GAP:
                    cur["label"] += " " + label_text
                    cur["notes"] += mark_txt
                    last_label_y = y
                else:
                    section, cur = label_text, None
                    last_label_y = y
            elif value_sp and cur is not None:
                append_wrapped(cur, value_sp, models)
            elif marks and cur is not None:
                cur["notes"] += mark_txt

        for r in rows:
            r.pop("_groups", None)
            r["notes"] = [n.strip() for t in r["notes"] for n in t.split(",") if n.strip()]
        tables.append({"models": models, "rows": rows})

    return {"page": page_no, "tables": tables,
            "footnotes": parse_footnote_spans(foot_spans, width / 2)}


def parse_footnote_spans(spans: list[Span], mid: float) -> dict[str, str]:
    """Footnotes are two columns; each starts with a superscript key (1, 2, *)
    or 'Note:' / '* ' text. Following lines without a key continue it."""
    notes: dict[str, str] = {}
    spans = [s for s in spans if s.size < 7.5]  # drop page numbers / headers
    for half in (False, True):
        cur = None
        for line in group_lines([s for s in spans if (s.x0 >= mid) == half]):
            keys = [s for s in line if s.size <= SUPERSCRIPT_MAX_SIZE]
            texts = [s for s in line if s.size > SUPERSCRIPT_MAX_SIZE]
            if not texts:
                continue
            if keys and keys[0].x0 <= texts[0].x0 + 1:
                for i, k in enumerate(keys):
                    nxt = keys[i + 1].x0 if i + 1 < len(keys) else 1e9
                    body = " ".join(t.text for t in texts if k.x0 <= t.x0 < nxt)
                    cur = k.text.strip()
                    notes[cur] = (notes.get(cur, "") + " " + body).strip()
                continue
            text = " ".join(t.text for t in texts)
            m = re.match(r"^(Note:|\*{1,2})\s*(.*)", text)
            if m:
                cur = "note" if m.group(1) == "Note:" else m.group(1)
                notes[cur] = (notes.get(cur, "") + " " + m.group(2)).strip()
            elif cur:
                notes[cur] += " " + text
    return {k: " ".join(v.split()) for k, v in notes.items()}


def extract(pdf_path: str | Path) -> dict:
    doc = pymupdf.open(str(pdf_path))
    pages = find_spec_pages(doc)
    out = {"file": Path(pdf_path).name, "spec_pages": [p + 1 for p in pages], "tables": [], "footnotes": {}}
    for p in pages:
        res = extract_page(doc[p], p + 1)
        for t in res["tables"]:
            t["page"] = p + 1
            out["tables"].append(t)
        for k, v in res["footnotes"].items():
            out["footnotes"].setdefault(k, v)
    return out


if __name__ == "__main__":
    import json
    for f in sys.argv[1:]:
        print(json.dumps(extract(f), indent=1, ensure_ascii=False))
