---
name: FortiGate Head-to-Head
description: Side-by-side comparison of 2 to 4 FortiGate, FortiWiFi or FortiGate
  Rugged models (hardware and VM) from official Fortinet datasheet data, shown
  as a table in chat, with an optional HTML report rendered from the skill's own
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
Compare 2 to 4 FortiGate models from Fortinet datasheet data: a table in chat first, then an HTML side-by-side report on request. Everything is read-only. This skill is self-contained: it loads no other skill.

## Data source
All specs come from the ds-grabber project, which extracts them from Fortinet's official datasheets every week. The skill's helper `ds-specs.js` does every fetch and match; never fetch or parse the data any other way.
- Data lives at `https://raw.githubusercontent.com/jclark1978/ds-grabber/main/`. The helper reads the small `data/index.json` plus one `data/models/<id>.json` per model, and falls back to the full `data/models.json` when the index is unavailable.
- If every ds-grabber URL answers 404, the GitHub repository is private. Say so in one line and stop. Never fall back to remembered specs.

Fields in each resolved model: `model`, `model_id`, `form_factor`, `spec_url` (the original Fortinet PDF opened on its spec page), and `specs.<field>` with `value` (normalized: throughput in Mbps, counts as plain numbers), `raw` (as printed in the datasheet) and `notes` (footnote keys).

## Step 0: Set up and fetch, one plain command
The fetch is the purpose of this skill and is expected on every run.

1. If `ds-specs.js` or `fortigate-head-to-head-template.html` is not in the session working directory, write it there from the skill's file of the same name. A write inside the chat's own folder needs no approval.
2. Run exactly one plain command with the names the user typed, in their order, each name as one argument: `node ds-specs.js 90G 120G`. Quote a name that has spaces: `node ds-specs.js "FortiWiFi 70G" 90G`.
3. It prints one JSON object: `source`, `resolved[]` and `unresolved[]` (each with `query` and `candidates`). Build everything you print from that output.
4. An `{"error": ...}` output means the fetch failed. Report it in one line and stop.

If node cannot reach the network but curl can: `curl -s -o ds-models.json https://raw.githubusercontent.com/jclark1978/ds-grabber/main/data/models.json`, then `node ds-specs.js --data ds-models.json 90G 120G`.

Shell rules for this skill, with no exceptions:
- One plain command per call: no `>` redirect, no `$(...)`, no backtick, no variable, no `cd ... && ...`. A line like that cannot be read as plain commands and always raises an approval.
- Write only inside the session working directory. `/tmp` and every other path outside the chat ask for approval on every call, and those can never be granted.
- Never run a command that prints credentials or tokens: `gh auth status`, `env`, `printenv`, `cat` on a key file.

## Step 1: Resolve the models
- The helper matches what the user typed: it strips FortiGate, FortiWiFi, Rugged, FGT, FG-, FWF-, FGR- and spaces, and matches bare codes such as 90G, 51G, 1800F-DC or VM04S. A plain code such as 70G means the FortiGate model unless the user said FortiWiFi or Rugged. Pass names exactly as typed.
- Every entry in `unresolved[]` needs the user: when it has `candidates`, ask which one with the `question` tool, one option per candidate, and wait. With no candidates, say the model is not in the datasheet data. Never guess.
- More than 4 models: ask the user to pick up to 4.

## Step 2: Chat table (every run)
Take the entries from `resolved[]` and post one markdown table.
- Columns: Spec, then one column per model (use `model`), in the order the user named them. With exactly 2 models add a last column "<second> vs <first>" with the percent difference, "Same" when equal, one decimal when under 1%.
- Rows, in this order, only when at least one model has the field:
  Threat Protection Throughput (`threat_protection_throughput_mbps`), NGFW Throughput (`ngfw_throughput_mbps`), IPS Throughput (`ips_throughput_mbps`), SSL Inspection Throughput (`ssl_inspection_throughput_mbps`), Firewall Throughput 1518 B UDP (`fw_throughput_1518_mbps`), Firewall Throughput 64 B UDP (`fw_throughput_64_mbps`), Concurrent Sessions (`concurrent_sessions`), New Sessions/Sec (`new_sessions_per_sec`), Firewall Policies (`firewall_policies`), IPsec VPN Throughput (`ipsec_throughput_mbps`), Site-to-Site IPsec Tunnels (`ipsec_tunnels_g2g`), Client-to-Site IPsec Tunnels (`ipsec_tunnels_c2g`), VDOMs Max (`vdoms_max`), Max FortiSwitches (`max_fortiswitches`), Max FortiAPs (`max_fortiaps_total`).
- Format from `value`: throughput of 1000 Mbps or more as Gbps (28000 becomes "28 Gbps"), otherwise Mbps; counts with thousands separators. When `value` is null, show `raw` ("N/A", "TBA"); when the field is absent, show "not listed".
- Bold the best value in each row (highest, except latency where lowest wins). Bold every tied best value.
- Under the table, 2 to 3 plain sentences on the differences that matter to a customer, for example "The 120G adds about 27% threat protection throughput, doubles firewall policies, and supports 10x the site-to-site tunnels."
- Then one line per model: "<model> datasheet: <spec_url>".
- When a VM is compared with hardware, add: "The FortiGate VM datasheet lists capacity only, not throughput."
- Mention once that performance values are "up to" figures with test conditions in each datasheet's footnotes. No other caveats.

## Offering the report (every attended run)
After the chat table, when the reply lands in a chat that can show a FollowUp section, end the reply with exactly:

<FollowUp>
Build the side-by-side report
</FollowUp>

Omit it when the comparison could not be built.

## Step 3: HTML report (when asked)
Run one plain command with the same names, in display order:
`node ds-specs.js --report fortigate-head-to-head-<ID1>-vs-<ID2>[-vs-...]-YYYY-MM-DD.html 90G 120G`
- File name: each `model_id` with non-alphanumeric characters removed (FG-90G becomes FG90G), today's date. It is written into the session working directory.
- The helper copies the skill's template `skill:fortigate-head-to-head/fortigate-head-to-head-template.html` and fills ONLY the JSON inside `<script id="compare-data" type="application/json">` with the full model records. Never edit the template or the generated file by hand, and never paste records yourself.
- The records are embedded, so the report opens with no network access and no GitHub permissions for whoever reads it. It formats every value and adds footnotes, datasheet links, Expand/Collapse, Export CSV and Print / Save PDF.
- The output's `report` field is the file name written. `report_skipped` means a model is still unresolved: settle it first.

## Chat summary for the report
Alongside the file, post a 1 to 2 line summary: which models it covers and where the file is. The file carries the detail; the chat does not repeat the table.

## Offering to open the report (every attended run)
After the report summary, when the reply lands in a chat that can show a FollowUp section, end the reply with exactly:

<FollowUp>
Open the report in my browser
</FollowUp>

- The line is sent verbatim when the user clicks it. When you receive it, open the HTML file written by this run from its absolute path with the platform's opener in a ```bash block: `open <path>` on macOS, `start "" <path>` on Windows, `xdg-open <path>` on Linux. The shell call may ask for approval; a refusal is final, so report it and give the path again as a clickable inline link. Only ever open a local file written by this skill.
- Omit the FollowUp when the run wrote no file.

## Rules
- Every spec comes from the ds-grabber data through `ds-specs.js`. Never invent or remember a value. If something is not found, say so.
- Always include each model's datasheet link (`source.spec_url`).
- Up to 4 models per comparison.
- One plain shell command per call, all writes inside the session working directory, no commands that print credentials.
- No em dashes. Plain, direct language. Product names exactly: FortiGate, FortiWiFi, FortiSwitch, FortiAP.
