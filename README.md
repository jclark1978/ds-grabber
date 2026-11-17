# ds-grabber

Keeps a current local library of Fortinet datasheets (FortiGate by default), pulled from the official library at <https://www.fortinet.com/resources/data-sheets>.

The library page loads its results with JavaScript and only lists 10 at a time, so ds-grabber drives a headless Chromium browser. It clicks **Load More** until every result is showing, keeps the datasheets whose title matches the filter, and downloads any that are new or have changed.

## What you get

```
datasheets/
  fortigate-700g-series.pdf
  fortigate-vm.pdf
  ...
  INDEX.md          # table: title, Fortinet "last updated" date, file link
  _archive/         # previous versions, renamed with their old date
manifest.json       # url, last_updated, sha256, size, download time per file
```

## Run it locally (Mac)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium

python ds_grabber.py --list-only        # preview the matches
python ds_grabber.py                    # download FortiGate datasheets
```

Options:

| Flag | Purpose |
|---|---|
| `--match REGEX` | Title/filename filter. Default `FortiGate`. Use `FortiSwitch`, `FortiAP`, or `.` for everything |
| `--list-only` | Show the matches without downloading |
| `--force` | Re-download everything |
| `--headed` | Show the browser window (for debugging) |
| `--out DIR` | Output folder (default `datasheets`) |

## How updates are detected

1. If Fortinet's "Last updated" date hasn't changed and the file exists, it is skipped.
2. Otherwise the PDF is downloaded and hashed. An identical hash means nothing changed.
3. A changed file replaces the old one, and the old one moves to `datasheets/_archive/`.

## GitHub Actions

`.github/workflows/grab.yml` runs every Monday and commits any changes. You can also run it by hand from the **Actions** tab, with a custom filter or a forced re-download.

## JSON conversion

`ds_normalize.py` reads every downloaded datasheet and writes one record per model:

| File | What it is |
|---|---|
| `data/models.json` | All models (hardware and VM) in one schema, for comparison tools and AI |
| `data/models.csv` | Flat table of the main comparison fields |
| `reports/extraction.txt` | Per-datasheet rows extracted, % mapped, problems, duplicate models |
| `reports/unmapped_labels.txt` | Spec labels not yet in `labels.yaml` (kept under `other`, never dropped) |

```bash
python ds_normalize.py --check
```

The GitHub Action runs it after every download, and again whenever `labels.yaml` or the parser changes.

### Record layout

```json
{
  "model": "FortiGate 120G",
  "model_id": "FG-120G",
  "form_factor": "appliance",
  "source": {
    "url": "https://www.fortinet.com/.../fortigate-120g-series.pdf",
    "spec_url": "https://www.fortinet.com/.../fortigate-120g-series.pdf#page=8"
  },
  "specs": {
    "ngfw_throughput_mbps": { "value": 3100, "raw": "3.1 Gbps", "label": "NGFW Throughput", "notes": ["2", "4"] }
  },
  "hardware": { "rack_units": 1, "power_max_w": 40.0, "interfaces": [ ... ] },
  "vm": null,
  "footnotes": { "4": "NGFW performance is measured with Firewall, IPS and Application Control enabled." },
  "other": { "Humidity": "20% to 90% non-condensing" }
}
```

- `specs` holds the fields hardware and VMs share. `value` is normalized (throughput in Mbps, counts as plain numbers); `raw` is exactly as printed.
- `notes` point to `footnotes`, the test conditions behind a number.
- `spec_url` opens the original PDF on the spec page.
- `hardware` is `null` for VMs; `vm` is `null` for hardware.

### Maintaining the label map

`labels.yaml` maps each datasheet label wording to a standard field. When Fortinet introduces a new wording it shows up in `reports/unmapped_labels.txt`; add a pattern to `labels.yaml` and push. The Action regenerates the JSON.

### Coverage notes

- **VMs:** capacity only (vCPU, policies, VDOMs, APs, FortiSwitches) from the FortiGate Virtual Appliances datasheet. The per-platform VM datasheets (AWS, Azure, ESXi, ...) are downloaded but excluded from the JSON.
- **Excluded:** service datasheets (FortiGate-as-a-Service, Managed FortiGate, FortiGate Cloud, VMX) and the 1200G file, which is a product brochure with no spec table.
- **Fortinet URL quirks:** the 70F link serves the 71F datasheet, and the 60E link serves the 60F datasheet. `fortigate-7000f-series.pdf` and `fortigate-7121f.pdf` are the same document.
- **FortiWiFi 40F/60F/80F** are not in the current datasheets, so they are not in the JSON.
- **FortiGate 7000E bundle:** only dimensions and power extract; its performance figures are not on the spec page.
- Combined columns such as `FG-50G/51G` or `FG-1800F/-DC` stay as one record, the way the datasheet prints them.

## Known limits

- This scrapes the public library page. If Fortinet changes the page layout, discovery may return 0 results. When that happens the script exits with an error rather than wiping anything.
- Datasheets that are linked only from product pages and not listed in the library won't be picked up.

## FortiGate Head-to-Head skill

`skills/fortigate-head-to-head/` is the Claude version and `skills/fortiagent/fortigate-head-to-head/` the FortiAgent version of an agent skill that answers
"compare the 90G and 120G" with a table in chat and builds a Fortinet-branded side-by-side report.

```bash
python skills/fortigate-head-to-head/scripts/compare.py table 90G 120G
python skills/fortigate-head-to-head/scripts/compare.py report 90G 120G
```

The Action also writes `data/index.json` and `data/models/<id>.json` so the skill fetches only the models it needs.
The report template (`fortigate-head-to-head-template.html`) renders from one JSON block: either model ids (loaded live from this repo) or embedded records (offline snapshot). It also accepts `?models=FG-90G,FG-120G`.

Latest FortiAgent package (rebuilt automatically when the skill changes):
https://github.com/jclark1978/ds-grabber/releases/download/fortigate-head-to-head/fortigate-head-to-head.tgz
