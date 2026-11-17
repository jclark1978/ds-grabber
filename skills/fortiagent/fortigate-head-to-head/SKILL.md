---
name: FortiGate Head-to-Head
description: Side-by-side comparison of 2 to 4 FortiGate, FortiWiFi or FortiGate
  Rugged models (hardware and VM) from official Fortinet datasheet data, shown
  as a table in chat plus an HTML side-by-side report rendered from the skill's own
  fortigate-head-to-head-template.html. Use when the user says "compare the 90G and
  120G", "90G vs 120G", "show me a side-by-side of the 400F and 700G", or asks
  which FortiGate model has more of a given spec.
ftnt-ai-agent:
  format: 3
  autoLoad: true
  uses: []
  tags:
    - fortigate
    - datasheet
    - compare
    - sizing
    - html
---
Compare 2 to 4 FortiGate models from Fortinet datasheet data: every run posts a table in chat and writes an HTML side-by-side report with a button to open it. Everything is read-only. This skill is self-contained: it loads no other skill.

## Data source
All specs come from the ds-grabber project, which extracts them from Fortinet's official datasheets every week. The skill's helper `ds-specs.js` does every fetch and match; never fetch or parse the data any other way.
- Data lives at `https://raw.githubusercontent.com/jclark1978/ds-grabber/main/`. The helper reads the small `data/index.json` plus one `data/models/<id>.json` per model, and falls back to the full `data/models.json` when the index is unavailable.
- If every ds-grabber URL answers 404, the GitHub repository is private. Say so in one line and stop. Never fall back to remembered specs.

Fields in each resolved model: `model`, `model_id`, `form_factor`, `spec_url` (the original Fortinet PDF opened on its spec page), and `specs.<field>` with `value` (normalized: throughput in Mbps, counts as plain numbers), `raw` (as printed in the datasheet) and `notes` (footnote keys).

## Step 0: Set up and fetch, one plain command
The fetch is the purpose of this skill and is expected on every run.

1. If `ds-specs.js` or `fortigate-head-to-head-template.html` is not in the session working directory, write it there from the skill's file of the same name. A write inside the chat's own folder needs no approval.
2. Run exactly one plain command with the names the user typed, each name as one argument: `node ds-specs.js --report auto 90G 120G`. Quote a name that has spaces: `node ds-specs.js --report auto "FortiWiFi 70G" 90G`. This one command fetches the data, resolves the models and writes the report.
3. It prints one JSON object: `source`, `resolved[]`, `unresolved[]` (each with `query` and `candidates`), and `report` plus `report_path` (the file it wrote). Build everything you print from that output.
4. An `{"error": ...}` output means the fetch failed. Report it in one line and stop.

If node cannot reach the network but curl can: `curl -s -o ds-models.json https://raw.githubusercontent.com/jclark1978/ds-grabber/main/data/models.json`, then `node ds-specs.js --data ds-models.json --report auto 90G 120G`.

Shell rules for this skill, with no exceptions:
- One plain command per call: no `>` redirect, no `$(...)`, no backtick, no variable, no `cd ... && ...`. A line like that cannot be read as plain commands and always raises an approval.
- Write only inside the session working directory. `/tmp` and every other path outside the chat ask for approval on every call, and those can never be granted.
- Never run a command that prints credentials or tokens: `gh auth status`, `env`, `printenv`, `cat` on a key file.

## Step 1: Resolve the models
- The helper matches what the user typed: it strips FortiGate, FortiWiFi, Rugged, FGT, FG-, FWF-, FGR- and spaces, and matches bare codes such as 90G, 51G, 1800F-DC or VM04S. A plain code such as 70G means the FortiGate model unless the user said FortiWiFi or Rugged. Pass names exactly as typed.
- Every entry in `unresolved[]` needs the user (no report is written while any remain; the output shows `report_skipped`): when it has `candidates`, ask which one with the `question` tool, one option per candidate, and wait. With no candidates, say the model is not in the datasheet data. Never guess. Then run the same command again with the settled names.
- More than 4 models: ask the user to pick up to 4.

## Step 2: Chat table (every run)
Take the entries from `resolved[]` and post one markdown table.
- Columns: Spec, then one column per model (use `model`), in the order of `resolved[]`: the helper sorts them smallest to largest (hardware by model number, then VMs by size), whatever order the user typed. Keep that order. With exactly 2 models add a last column "<second> vs <first>" with the percent difference, "Same" when equal, one decimal when under 1%.
- Rows, in this order, only when at least one model has the field:
  Threat Protection Throughput (`threat_protection_throughput_mbps`), NGFW Throughput (`ngfw_throughput_mbps`), IPS Throughput (`ips_throughput_mbps`), SSL Inspection Throughput (`ssl_inspection_throughput_mbps`), Firewall Throughput 1518 B UDP (`fw_throughput_1518_mbps`), Firewall Throughput 64 B UDP (`fw_throughput_64_mbps`), Concurrent Sessions (`concurrent_sessions`), New Sessions/Sec (`new_sessions_per_sec`), Firewall Policies (`firewall_policies`), IPsec VPN Throughput (`ipsec_throughput_mbps`), Site-to-Site IPsec Tunnels (`ipsec_tunnels_g2g`), Client-to-Site IPsec Tunnels (`ipsec_tunnels_c2g`), VDOMs Max (`vdoms_max`), Max FortiSwitches (`max_fortiswitches`), Max FortiAPs (`max_fortiaps_total`).
- Format from `value`: throughput of 1000 Mbps or more as Gbps (28000 becomes "28 Gbps"), otherwise Mbps; counts with thousands separators. When `value` is null, show `raw` ("N/A", "TBA"); when the field is absent, show "not listed".
- Bold the best value in each row (highest, except latency where lowest wins). Bold every tied best value.
- Under the table, 2 to 3 plain sentences on the differences that matter to a customer, for example "The 120G adds about 27% threat protection throughput, doubles firewall policies, and supports 10x the site-to-site tunnels."
- Then one line per model: "<model> datasheet: <spec_url>".
- When a VM is compared with hardware, add: "The FortiGate VM datasheet lists capacity only, not throughput."
- Mention once that performance values are "up to" figures with test conditions in each datasheet's footnotes. No other caveats.

## Step 3: Side-by-side report (every run)
The command in Step 0 already wrote it; never build or edit it any other way.
- The helper copies the skill's template `skill:fortigate-head-to-head/fortigate-head-to-head-template.html` and fills ONLY the JSON inside `<script id="compare-data" type="application/json">` with the full model records. Never edit the template or the generated file by hand, and never paste records yourself.
- File name: `fortigate-head-to-head-<ID1>-vs-<ID2>[-vs-...]-YYYY-MM-DD.html` in the session working directory (`report`), full path in `report_path`.
- The records are embedded, so the report opens with no network access and no GitHub permissions for whoever reads it. It formats every value and adds footnotes, datasheet links, Expand/Collapse, Export CSV and Print / Save PDF.
- After the table and its sentences, add one line: "Side-by-side report: `<report>`".

## Opening the report (every attended run)
End every reply that wrote a report by asking whether to open it, with the `question` tool:
- Question: "Open the Fortinet-formatted side-by-side report in your browser?"
- Options: "Yes, open it" and "Not now".
- "Yes, open it": open `report_path` from this run with the platform's opener in a ```bash block: `open <path>` on macOS, `start "" <path>` on Windows, `xdg-open <path>` on Linux. The shell call may ask for approval; a refusal is final, so report it and give the path again as a clickable inline link. Only ever open a local file written by this skill.
- "Not now", or the user dismisses the question: reply in one line with the file name so they can open it later. Do not ask again.
- If the question tool is unavailable, end the reply instead with exactly the block below; when the user clicks it, the line is sent verbatim, so treat it like "Yes, open it":

<FollowUp>
📄 Open the Fortinet report in my browser
</FollowUp>

- Never ask or show the button when the run wrote no report (a model is still unresolved, or the fetch failed), or when the reply goes somewhere without interactive elements (a channel send).

## Rules
- Every spec comes from the ds-grabber data through `ds-specs.js`. Never invent or remember a value. If something is not found, say so.
- Always include each model's datasheet link (`source.spec_url`).
- Up to 4 models per comparison.
- One plain shell command per call, all writes inside the session working directory, no commands that print credentials.
- No em dashes. Plain, direct language. Product names exactly: FortiGate, FortiWiFi, FortiSwitch, FortiAP.
