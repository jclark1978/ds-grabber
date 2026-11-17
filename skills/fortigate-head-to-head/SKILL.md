---
name: fortigate-head-to-head
description: Side-by-side comparison of FortiGate models (hardware and VM) from official Fortinet datasheet data, with a Fortinet-branded side-by-side report every time. Use when asked to compare FortiGate, FortiWiFi or FortiGate Rugged models, e.g. "compare the 90G and 120G", "90G vs 120G", "side-by-side of the 400F and 700G", "which has more threat protection throughput".
---

# FortiGate Head-to-Head

Compares 2 to 4 FortiGate models using spec data extracted from Fortinet's
official datasheets by the ds-grabber project, shows the comparison as a table
in chat, and always delivers a Fortinet-branded side-by-side report with it.

## Rules

- **Every spec comes from the ds-grabber data. Never fill a value from memory.**
  If a field is missing for a model, say "not listed in the datasheet".
- Always include the datasheet link (`source.spec_url`) for each model. It opens
  the original Fortinet PDF on the spec page.
- Performance numbers are "up to" values with test conditions in the footnotes
  (for example, NGFW is measured with Firewall, IPS and Application Control
  enabled). Mention this once; don't bury the table in caveats.
- The FortiGate VM datasheet lists capacity only (vCPU, policies, VDOMs,
  FortiAPs, FortiSwitches), not throughput. Say so when a VM is compared with
  hardware.
- No em dashes in your text.

## Data

Base URL: `https://raw.githubusercontent.com/jclark1978/ds-grabber/main/`

| File | Contents |
|---|---|
| `data/index.json` | Every model: `model_id`, `family`, `codes` (bare model codes), `file`, `spec_url` |
| `data/models/<id>.json` | Full record for one model (about 8 KB) |

Bundled files (`scripts/compare.py`, `fortigate-head-to-head-template.html`) sit next to this
SKILL.md. If they are missing, download them from the same base URL under
`skills/fortigate-head-to-head/`. If raw GitHub is blocked in your environment,
clone the public repo `jclark1978/ds-grabber` and pass `--data <clone path>`
to the script.

Record fields that matter: `model`, `model_id`, `form_factor` (appliance or vm),
`source.spec_url`, `specs.<field>.value` (normalized: throughput in Mbps),
`specs.<field>.raw` (as printed), `specs.<field>.notes` (footnote keys),
`footnotes`, `hardware`, `vm`.

## Workflow

### 1. Resolve the models

Preferred, if you can run code:

```bash
python scripts/compare.py find 90G 120G
```

Without code: fetch `data/index.json`, strip "FortiGate", "FortiWiFi", "Rugged",
"FGT", "FG-", "FWF-", "FGR-" and spaces from what the user typed, uppercase it,
and match against each model's `codes`. A plain code like "70G" means the
FortiGate model unless the user said FortiWiFi or Rugged.

If a name matches nothing, say so and list close codes from the index. If it
matches more than one model (for example "50G" covers several 50G variants),
ask which one before going on.

### 2. Show the comparison in chat

Preferred:

```bash
python scripts/compare.py table 90G 120G
```

Paste its markdown output. Without code: fetch each model's file and build the
same table yourself from `specs.<field>.value`, using these rows when present:
Threat Protection, NGFW, IPS, SSL Inspection throughput; Firewall throughput
(1518 and 64 byte); Concurrent Sessions; New Sessions/Sec; Firewall Policies;
IPsec throughput and tunnels; VDOMs (max); Max FortiSwitches; Max FortiAPs.
Show throughput in Gbps when 1000 Mbps or more. Bold the better value. For two
models, add a column with the percent difference of the second vs the first.

Under the table, add two or three plain sentences on the differences that
matter to a customer (for example, "the 120G has about 27% more threat
protection throughput and twice the firewall policies"). Then list each
model's datasheet link.

Then build the report (step 3) in the same turn, every time.

### 3. Build and deliver the report (every run)

Preferred:

```bash
python scripts/compare.py report 90G 120G
```

Without code: copy `fortigate-head-to-head-template.html` and change ONLY the JSON
inside `<script id="compare-data" type="application/json">` to
`{"models": ["FG-90G", "FG-120G"], "records": []}` (resolved `model_id` values).
The page loads the records itself when opened. The script instead embeds the
full records as an offline snapshot.

Deliver the HTML file with the table (send it as a file, rendered where the
interface allows) and add one line naming it. It has Fortinet branding, every spec section, the
footnotes with test conditions, datasheet links, Print / Save PDF and CSV
export.

If the data can't be fetched (network blocked), say so plainly. Do not fall
back to remembered specs.
