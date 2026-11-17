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
All specs come from the ds-grabber project, which extracts them from Fortinet's official datasheets every week.
- Base URL: `https://raw.githubusercontent.com/jclark1978/ds-grabber/main/`
- `data/index.json`: every model with `model_id`, `model`, `family` (FortiGate, FortiWiFi, FortiGate Rugged), `form_factor` (appliance or vm), `codes` (bare model codes such as "90G", "1800F-DC", "VM04S"), `file`, `spec_url`.
- `data/models/<id>.json`: the full record for one model (path is the index entry's `file`).

Fetch with the platform's web fetch tool when it returns the raw JSON, otherwise `curl -s <url>` in a ```bash block. Use the JSON exactly as returned. If the data cannot be fetched, say so in one line and stop. Never fall back to remembered specs.

Record fields used:
- `model`, `model_id`, `form_factor`
- `source.spec_url`: the original Fortinet PDF opened on its spec page
- `specs.<field>.value`: normalized number (throughput in Mbps, counts as plain numbers)
- `specs.<field>.raw`: the value exactly as printed in the datasheet
- `specs.<field>.notes`: footnote keys, explained in `footnotes`

## Step 1: Resolve the models
- Fetch `data/index.json`.
- For each model the user named: strip "FortiGate", "FortiWiFi", "Rugged", "FGT", "FG-", "FWF-", "FGR-" and spaces, uppercase it, and match it against each entry's `codes`. An exact `model_id` match wins.
- A plain code such as "70G" means the FortiGate model unless the user said FortiWiFi or Rugged.
- More than 4 models: ask the user to pick up to 4.
- A name that matches more than one model (for example "50G" covers several 50G variants): ask which one with the `question` tool, one option per match using the index `model` as the label. If the question tool is unavailable, ask in one line and wait.
- A name that matches nothing: say so and list up to 10 nearby codes from the index. Never guess.

## Step 2: Chat table (every run)
Fetch each resolved model's `file` and post one markdown table.
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
Copy the skill's own template `skill:fortigate-head-to-head/fortigate-head-to-head-template.html` and modify ONLY the JSON inside `<script id="compare-data" type="application/json">`. Never edit the template's HTML, CSS, or JavaScript; same layout every run.
- Replace the sample JSON entirely with: `{"models": ["<model_id>", "<model_id>"], "records": []}` using the resolved `model_id` values in display order. Keep the field names exactly.
- The page loads each model's record from the ds-grabber data when it opens, formats every value, and adds footnotes, datasheet links, Expand/Collapse, Export CSV and Print / Save PDF. Opening it needs internet access.
- Output file name: `fortigate-head-to-head-<ID1>-vs-<ID2>[-vs-...]-YYYY-MM-DD.html` with non-alphanumeric characters removed from each id (FG-90G becomes FG90G). Write it into the session working directory.

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
- Every spec comes from the ds-grabber data. Never invent or remember a value. If something is not found, say so.
- Always include each model's datasheet link (`source.spec_url`).
- Up to 4 models per comparison.
- No em dashes. Plain, direct language. Product names exactly: FortiGate, FortiWiFi, FortiSwitch, FortiAP.
