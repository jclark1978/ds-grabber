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

1. If `ds-specs.js` is not in the session working directory, download it with one plain command: `curl -s -o ds-specs.js https://raw.githubusercontent.com/jclark1978/ds-grabber/main/skills/fortiagent/fortigate-head-to-head/ds-specs.js`. Do not read or copy the skill's files into the chat; the helper fetches the report template itself. Only if that download fails, write `ds-specs.js` and `fortigate-head-to-head-template.html` into the working directory from the skill's files of the same name.
2. Run exactly one plain command with the names the user typed, each name as one argument: `node ds-specs.js --report auto 90G 120G`. Quote a name that has spaces: `node ds-specs.js --report auto "FortiWiFi 70G" 90G`. This one command fetches the data, resolves the models, builds the chat table and writes the report.
3. It prints one JSON object: `version`, `source`, `resolved[]`, `unresolved[]` (each with `query` and `candidates`), `table` (the finished markdown table), `datasheet_links[]`, `vm_note` (only when a VM is compared with hardware), and `report` plus `report_path` (the file it wrote). Build everything you print from that output.
4. If the output has no `table` field or `version` is below 3, the `ds-specs.js` in the folder is outdated: run the curl command from item 1 again (it overwrites the file), then rerun the same command.
5. An `{"error": ...}` output means the fetch failed. Report it in one line and stop.

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
- Paste `table` exactly as given. It is already ordered smallest to largest, formatted, with the best value in each row bolded and, for two models, a percent-difference column. Do not rebuild, reorder or reformat it.
- Under the table, 2 to 3 plain sentences on the differences that matter to a customer, for example "The 120G adds about 27% threat protection throughput, doubles firewall policies, and supports 10x the site-to-site tunnels."
- Then each line of `datasheet_links`, and `vm_note` when present.
- Mention once that performance values are "up to" figures with test conditions in each datasheet's footnotes. No other caveats.

## Step 3: Side-by-side report (every run)
The command in Step 0 already wrote it; never build or edit it any other way.
- The helper takes the skill's template `skill:fortigate-head-to-head/fortigate-head-to-head-template.html` (a local copy if one is in the chat folder, otherwise the published copy in the ds-grabber repo) and fills ONLY the JSON inside `<script id="compare-data" type="application/json">` with the full model records. Never edit the template or the generated file by hand, and never paste records yourself.
- File name: `fortigate-head-to-head-<ID1>-vs-<ID2>[-vs-...]-YYYY-MM-DD.html` in the session working directory (`report`), full path in `report_path`.
- The records are embedded, so the report opens with no network access and no GitHub permissions for whoever reads it. It formats every value and adds footnotes, datasheet links, Expand/Collapse, Export CSV and Print / Save PDF.
- After the table and its sentences, add one line: "Side-by-side report: `<report>`".

## Opening the report (every attended run)
End every reply that wrote a report by asking whether to open it, with the `question` tool:
- Question: "Open the full Fortinet-formatted side-by-side report in your browser?"
- Options, each with its description:
  - "Yes, open it" - description: "Every spec, plus hardware, ports, power, test-condition footnotes and datasheet links. Print to PDF or export to CSV."
  - "Not now" - description: "The report stays saved in this chat's folder."
- "Yes, open it": open the report by its file name (`report`; the shell already runs in the chat folder) with the platform's opener in a ```bash block: `open <report>` on macOS, `start "" <report>` on Windows, `xdg-open <report>` on Linux. The shell call may ask for approval; a refusal is final, so report it and give `report_path` as a clickable inline link. Only ever open a local file written by this skill. After it opens, reply only "Opened in your browser."
- "Not now", or the user dismisses the question: reply in one line with the file name so they can open it later. Do not ask again.
- If the question tool is unavailable, end the reply instead with exactly the block below; when the user clicks it, the line is sent verbatim, so treat it like "Yes, open it":

<FollowUp>
📄 Open the full Fortinet report (every spec, footnotes, PDF/CSV)
</FollowUp>

- Never ask or show the button when the run wrote no report (a model is still unresolved, or the fetch failed), or when the reply goes somewhere without interactive elements (a channel send).

## Rules
- Every spec comes from the ds-grabber data through `ds-specs.js`. Never invent or remember a value. If something is not found, say so.
- Always include each model's datasheet link (`source.spec_url`).
- Up to 4 models per comparison.
- One plain shell command per call, all writes inside the session working directory, no commands that print credentials.
- No em dashes. Plain, direct language. Product names exactly: FortiGate, FortiWiFi, FortiSwitch, FortiAP.
