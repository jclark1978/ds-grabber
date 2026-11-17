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

## Known limits

- This scrapes the public library page. If Fortinet changes the page layout, discovery may return 0 results. When that happens the script exits with an error rather than wiping anything.
- Datasheets that are linked only from product pages and not listed in the library won't be picked up.
