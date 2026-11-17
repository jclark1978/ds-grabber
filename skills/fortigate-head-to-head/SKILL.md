---
name: fortigate-head-to-head
description: Side-by-side comparison of 2 to 4 FortiGate, FortiWiFi or FortiGate Rugged models (hardware and VM) from official Fortinet datasheet data, or a FortiGate against Palo Alto PA-Series, Cisco Secure Firewall (FTD) and Cisco Meraki MX models from their own datasheets. Finds the closest competitor model for a FortiGate, or the closest FortiGate for a competitor model, optionally with a port requirement. Shows a table in chat plus a Fortinet-branded HTML side-by-side report every time. Use for "compare the 90G and 120G", "120G vs PA-3410", "what's comparable to a 120G from Palo Alto", "what FortiGate replaces a Firepower 1150", "comparable to an MX450 with at least 6 x 10G ports", or which model has more of a given spec or enough ports.
---

# FortiGate Head-to-Head (v1.1.0, Claude)

Compare FortiGate models with each other or with Palo Alto, Cisco Secure Firewall (FTD) and Meraki MX models from datasheet data. Every run posts a table in chat and delivers an HTML side-by-side report. Everything is read-only.

## Data source
All specs come from three public projects that extract them from official datasheets every week. The bundled helper `scripts/ds-specs.js` does every fetch, match and size pick; never fetch or parse the data any other way.

| Vendor | Repository | Data |
|---|---|---|
| Fortinet FortiGate, FortiWiFi, FortiGate Rugged | `jclark1978/ds-grabber` | hardware and VM |
| Palo Alto Networks PA-Series | `jclark1978/palo-ds-grabber` | hardware only (VM-Series datasheets have no spec tables) |
| Cisco Secure Firewall / Firepower (FTD and ASA), Meraki MX, Cisco 8000 (MX), Threat Defense Virtual, ASAv | `jclark1978/cisco-ds-grabber` | hardware and virtual |

- If every URL from a repository answers 404, that GitHub repository is private. Say so in one line and stop. If the network blocks GitHub, say so plainly. Never fall back to remembered specs.

## Step 0: Run the helper
1. The helper and its template are bundled in this skill's `scripts/` folder. Run it with Node from the folder where you keep output files (the report is written to the current folder), giving the helper's full path: `node <skill folder>/scripts/ds-specs.js --report auto 90G 120G`.
2. Only if the bundled files are missing, download the helper first: `curl -s -o ds-specs.js https://raw.githubusercontent.com/jclark1978/ds-grabber/fortiagent-h2h-v1.2.0/skills/fortiagent/fortigate-head-to-head/ds-specs.js`, then run `node ds-specs.js ...`. It downloads the template itself.
3. Do not search for, retype or rebuild the files.
4. Pick the command from the request. Pass each model name exactly as typed, as one argument; quote names with spaces. Below, `ds-specs.js` means the helper's path.

| The user asks for | Command |
|---|---|
| FortiGates only: "compare the 90G and 120G" | `node ds-specs.js --report auto 90G 120G` |
| Named models across vendors: "120G vs PA-3410 vs Firepower 1150" | `node ds-specs.js --report auto 120G PA-3410 "Firepower 1150"` |
| Comparable competitors for a FortiGate, no vendor named | `node ds-specs.js --match auto --report auto 120G` |
| One vendor: "what's comparable to a 120G from Palo Alto" | `node ds-specs.js --match palo --report auto 120G` |
| "from Cisco" | `node ds-specs.js --match cisco --report auto 120G` (returns both the closest FTD and the closest Meraki MX) |
| Only FTD, or only Meraki | `--match ftd` or `--match meraki` |
| Two vendors | `--match palo,meraki` |
| A FortiGate to replace a competitor: "what FortiGate replaces a PA-3410" | `node ds-specs.js --match auto --report auto PA-3410` |
| A port requirement: "comparable to an MX450 with at least 6 x 10G ports" | `node ds-specs.js --match auto --min-ports 10G:6 --report auto MX450` |
| Ports on named models: "does the 200G have 6 x 10G" | `node ds-specs.js --min-ports 10G:6 --report auto 200G` |

`--min-ports SPEED:COUNT` counts fixed data ports at that speed or faster (10G:6 means six ports that run at 10G or more; 25G ports count toward 10G). It can be repeated. In match mode only models that pass are picked. Management, HA, console, USB and modular expansion slots are not counted.

5. It prints one JSON object. Build everything you write from that output.
   - FortiGate only: `source`, `resolved[]`, `unresolved[]` (each with `query` and `candidates`), `report`, `report_path`.
   - Cross-vendor (any competitor, or `--match`): also `cross_vendor: true`, `mode` ("compare" or "match"), `match` (match mode only), `table_md` (the chat table, ready to post), `caveats[]`, and `resolved[]` entries with `vendor`, `line` and `software`.
   - Every hardware entry in `resolved[]` has `ports` (data ports by speed, for example "8 x 10G, 8 x 5G, 12 x 1G"). With `--min-ports` it also has `port_check` (`pass`, and `have` against `required`). Answer port questions from these fields only.
6. An `{"error": ...}` output means the fetch failed or the request is not supported. Report it in one line and stop.

Everything the answer needs comes from the helper's JSON output. Do not fetch the data repositories yourself, do not parse the report HTML, and do not web search to confirm a spec. If the user asks for something the helper does not output, say it is not in the datasheet data.

## Step 1: Resolve the models
- FortiGate names: the helper strips FortiGate, FortiWiFi, Rugged, FGT, FG-, FWF-, FGR- and spaces, and matches bare codes such as 90G, 51G, 1800F-DC or VM04S. A plain code such as 70G means the FortiGate model unless the user said FortiWiFi or Rugged.
- Competitor names: PA-3410, 3410, "Palo Alto 3410"; "Firepower 1150", FPR-1150, 1150, "Secure Firewall 3110", 3110; MX85, "Meraki MX85", C8111-G2-MX, "vMX Small"; "TDv 8 vCPU AWS", "ASAv10 Azure". A bare code tries FortiGate first, then Palo Alto and Cisco.
- Every entry in `unresolved[]` needs the user (no report is written while any remain; the output shows `report_skipped`): when it has `candidates`, ask the user which one (with the multiple-choice question tool when available, one option per candidate) and wait. With no candidates, say the model is not in the datasheet data. Never guess. Then run the same command again with the settled names.
- More than 4 models: ask the user to pick up to 4.

## Step 2a: Chat table, FortiGate only 
Take the entries from `resolved[]` and post one markdown table.
- Columns: Spec, then one column per model (use `model`), in the order of `resolved[]`: the helper sorts them smallest to largest (hardware by model number, then VMs by size), whatever order the user typed. Keep that order. With exactly 2 models add a last column "<second> vs <first>" with the percent difference, "Same" when equal, one decimal when under 1%.
- Rows, in this order, only when at least one model has the field:
  Threat Protection Throughput (`threat_protection_throughput_mbps`), NGFW Throughput (`ngfw_throughput_mbps`), IPS Throughput (`ips_throughput_mbps`), SSL Inspection Throughput (`ssl_inspection_throughput_mbps`), Firewall Throughput 1518 B UDP (`fw_throughput_1518_mbps`), Firewall Throughput 64 B UDP (`fw_throughput_64_mbps`), Concurrent Sessions (`concurrent_sessions`), New Sessions/Sec (`new_sessions_per_sec`), Firewall Policies (`firewall_policies`), IPsec VPN Throughput (`ipsec_throughput_mbps`), Site-to-Site IPsec Tunnels (`ipsec_tunnels_g2g`), Client-to-Site IPsec Tunnels (`ipsec_tunnels_c2g`), VDOMs Max (`vdoms_max`), Max FortiSwitches (`max_fortiswitches`), Max FortiAPs (`max_fortiaps_total`).
- Format from `value`: throughput of 1000 Mbps or more as Gbps (28000 becomes "28 Gbps"), otherwise Mbps; counts with thousands separators. When `value` is null, show `raw` ("N/A", "TBA"); when the field is absent, show "not listed".
- Bold the best value in each row (highest, except latency where lowest wins). Bold every tied best value.
- When the run used `--min-ports`, add a last row "Data Ports" from `ports`, with "(meets)" or "(below N x 10G)" from `port_check`.
- Under the table, 2 to 3 plain sentences on the differences that matter to a customer, for example "The 120G adds about 27% threat protection throughput, doubles firewall policies, and supports 10x the site-to-site tunnels."
- Then one line per model: "<model> datasheet: <spec_url>".
- When a VM is compared with hardware, add: "The FortiGate VM datasheet lists capacity only, not throughput."
- Mention once that performance values are "up to" figures with test conditions in each datasheet's footnotes. No other caveats.

## Step 2b: Chat output, cross-vendor
Vendors test differently, so numbers are not like-for-like. Every cross-vendor reply says so and shows the software each competitor figure was measured on.

1. Match mode only, first: one short table from `match`, columns Vendor, Closest model, Figure, Difference, Next size. Fill it from `match.results[]`: `vendor_label`, `best.model`, `best.anchor`, `best.diff_pct` (as "+7%", "-12%", "Same" when 0), and `alternative.model` with its `anchor` ("None" when null). Above it, one line: "Matched on <match.anchor.basis>: <match.source_model> is <match.anchor.value> (<match.anchor.metric>)." Add each result's `note` when present. For each entry in `match.skipped[]`, one line: "<vendor_label>: no match, <reason>."
   - Matching rules, for your explanation if asked: threat throughput for hardware (FortiGate Threat Protection, Palo Alto Threat Prevention, Cisco FTD FW + AVC + IPS because Cisco publishes no figure with anti-malware, Meraki Advanced Security), vCPU count for virtual. Hardware matches only hardware. Rugged matches rugged when one is within 2x. Older E-generation FortiGates and variant models (POE, DSL, 5G and so on) are left out of FortiGate picks.
2. Post `table_md` exactly as printed. With `--min-ports` it already ends with a "Data Ports by Speed" row; add one line saying which models meet the requirement, from `port_check`, and the `match.port_filter` used. It is already in the right order (FortiGate first, then Palo Alto, Cisco FTD, Meraki), formatted, with best values in bold only on rows where every vendor's metric is a close match. Do not rebuild it, reorder it or add bold.
3. Under it: "† Different test method, or the closest figure the vendor publishes." Then each line from `caveats[]` as a short bullet list.
4. One line with each model's software from `resolved[].software`, for example "Measured on: Palo Alto PA-460 PAN-OS 12.1; Cisco Secure Firewall 240P Threat Defense (FTD); FortiGate FortiOS version not stated in datasheet."
5. 2 to 3 plain sentences on what matters to the customer, based only on rows without a †. Never claim a win on a † row.
6. One line per model: "<model> datasheet: <spec_url>".
7. Mention once that performance values are "up to" figures.

When `report_skipped` says "no comparable model found" (for example a Palo Alto request for a FortiGate VM, or an ASAv source), say why from `match.skipped[]` and stop; there is no table or report.

## Step 3: Deliver the side-by-side report (every run that resolved its models)
The command in Step 0 already wrote it; never build or edit it any other way.
- The helper fills ONLY the JSON inside the template's `<script id="compare-data" type="application/json">` block. Never edit the template or the generated file by hand.
- FortiGate only: the classic layout. Cross-vendor: the competitive layout, with vendor cards, how the match was chosen, every value with the vendor's metric name and a Loose or Nearest tag where the tests differ, hardware and ports, comparison notes, all published specs per model, and test conditions per vendor.
- File name: `fortigate-head-to-head-<ID1>-vs-<ID2>[-vs-...]-YYYY-MM-DD.html` (`report`), full path in `report_path`. The data is embedded, so it opens offline for anyone. It has datasheet links, Expand/Collapse, Export CSV and Print / Save PDF.
- Send the HTML file to the user with your file-sharing tool (rendered where the interface allows), with the table and sentences in the same reply, and one line naming the file. Do not ask whether to open it.
- Never send a report when the run wrote none (a model is still unresolved, no comparable model, or the fetch failed).

## Rules
- Every spec comes from the datasheet data through `ds-specs.js`. Never invent or remember a value, for any vendor. If something is not found, say so.
- Always include each model's datasheet link.
- Up to 4 models per comparison. A match is one model in, the closest per vendor out.
- Matching runs FortiGate to competitors or a competitor to FortiGate, never competitor to competitor.
- Competitor model names always carry their vendor, exactly as the helper prints them in `model`: "Palo Alto PA-3410", "Cisco Secure Firewall 3110 (FTD)", "Cisco Firepower 1150 (FTD)", "Cisco Meraki MX95". Never shorten them to a bare model number in chat, sentences or tables.
- Cross-vendor replies always say figures are not like-for-like, show the software version, and never claim a FortiGate win on a † row.
- Use "Not published" for a competitor field its datasheet does not list. Never say "not disclosed".
- Write only the report, in the folder where you keep output files. Never run commands that print credentials.
- No em dashes. Plain, direct language. Product names exactly: FortiGate, FortiWiFi, FortiSwitch, FortiAP; Palo Alto Networks, PAN-OS; Cisco Secure Firewall, Firepower, Threat Defense (FTD), Meraki MX.
