#!/usr/bin/env node
/* ds-specs.js - FortiGate Head-to-Head helper (Node 14+, no dependencies).
 *
 * Fetches ds-grabber model data, resolves the model names the user typed, sorts
 * them smallest to largest (hardware by model number, then VMs), and
 * prints one JSON document. With --report it also writes the HTML report from
 * the skill template (local copy, or downloaded from the repo), with the full
 * records embedded, so nothing is retyped.
 * Writes only the --report file, in the current folder. Never prints credentials.
 *
 * Usage:
 *   node ds-specs.js 90G 120G
 *   node ds-specs.js --report auto 90G 120G      (names the file from the models and today's date)
 *   node ds-specs.js --report fortigate-head-to-head-FG90G-vs-FG120G-2026-11-17.html 90G 120G
 *   node ds-specs.js --data ds-models.json 90G 120G      (local file saved by curl -o)
 *
 * Output:
 *   { "version", "source", "resolved": [ { model, model_id, form_factor, spec_url, specs } ],
 *     "table": "<markdown table for chat>", "datasheet_links": [ ... ], "vm_note"?,
 *     "unresolved": [ { "query", "candidates": [ "FortiGate 50G/51G (FG-50G/51G)", ... ] } ],
 *     "report": "<file name>", "report_path": "<absolute path>" (only with --report) }
 *   On failure: { "error": "..." } and exit code 1.
 */
'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');

var BASE = 'https://raw.githubusercontent.com/jclark1978/ds-grabber/main/';
var VERSION = 3;
var TEMPLATE = 'fortigate-head-to-head-template.html';
var TEMPLATE_URL = BASE + 'skills/fortiagent/fortigate-head-to-head/' + TEMPLATE;
var FIELDS = [
  'threat_protection_throughput_mbps', 'ngfw_throughput_mbps', 'ips_throughput_mbps',
  'ssl_inspection_throughput_mbps', 'fw_throughput_1518_mbps', 'fw_throughput_64_mbps',
  'concurrent_sessions', 'new_sessions_per_sec', 'firewall_policies', 'ipsec_throughput_mbps',
  'ipsec_tunnels_g2g', 'ipsec_tunnels_c2g', 'vdoms_max', 'max_fortiswitches', 'max_fortiaps_total'
];
var FAMILY = { FG: 'FortiGate', FWF: 'FortiWiFi', FGR: 'FortiGate Rugged' };

function get(url, hops, asText) {
  hops = hops || 0;
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'ds-specs' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        return resolve(get(res.headers.location, hops + 1, asText));
      }
      if (res.statusCode !== 200) {
        res.resume();
        var e = new Error('HTTP ' + res.statusCode + ' from ' + url +
          (res.statusCode === 404 ? ' (if every ds-grabber URL returns 404, the GitHub repo is private)' : ''));
        e.status = res.statusCode;
        return reject(e);
      }
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        if (asText) return resolve(body);
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('not JSON: ' + url)); }
      });
    }).on('error', reject);
  });
}

function fail(msg) {
  process.stdout.write(JSON.stringify({ error: String(msg) }) + '\n');
  process.exit(1);
}

// User text -> bare code, matching ds-grabber index "codes".
function norm(text) {
  var t = String(text).toUpperCase();
  t = t.replace(/FORTI\s*GATE|FORTI\s*WIFI|RUGGED|\bFGT\b/g, '').trim();
  t = t.replace(/^(FG|FWF|FGR)\s*-?/, '');
  return t.replace(/\s+/g, '').replace(/^-+/, '');
}
function familyHint(text) {
  var t = String(text).toUpperCase();
  if (t.indexOf('WIFI') >= 0 || /^FWF/.test(t)) return 'FortiWiFi';
  if (t.indexOf('RUGGED') >= 0 || /^FGR/.test(t)) return 'FortiGate Rugged';
  return null;
}
// Build index-style entries from a full models.json when the index is unavailable.
function codesFor(modelId) {
  var parts = modelId.split('-'), prefix = parts.shift(), code = parts.join('-');
  var pieces = code.split(/\s*\/\s*/).filter(Boolean), base = pieces[0] || code, out = [];
  (pieces.length ? pieces : [code]).forEach(function (p) {
    var full = p.charAt(0) === '-' ? base + p : p;
    out.push(full.replace(/^(FG|FWF|FGR)-/, '').toUpperCase());
  });
  if (prefix === 'FG' && /^VM/.test(code)) out.push(code.replace('VM', 'VM-'));
  return out;
}
function indexFromModels(models) {
  return models.map(function (m) {
    return { model_id: m.model_id, model: m.model, form_factor: m.form_factor,
             family: FAMILY[m.model_id.split('-')[0]] || 'FortiGate', codes: codesFor(m.model_id), _rec: m };
  });
}

function resolve(query, index) {
  var q = String(query).trim().toUpperCase();
  var exact = index.filter(function (m) { return m.model_id.toUpperCase() === q; });
  if (exact.length) return exact;
  var code = norm(query), fam = familyHint(query);
  var hits = index.filter(function (m) { return (m.codes || []).indexOf(code) >= 0; });
  // "VM04", "VM-04", "FG-VM04" -> VM04S (the datasheet lists the S-series sizes).
  if (!hits.length && /^VM-?(\d+|UL)$/.test(code)) {
    var vm = code.replace('-', '') + 'S';
    hits = index.filter(function (m) { return (m.codes || []).indexOf(vm) >= 0; });
  }
  if (fam) hits = hits.filter(function (m) { return m.family === fam; });
  else if (hits.length > 1) {
    var fg = hits.filter(function (m) { return m.family === 'FortiGate'; });
    if (fg.length) hits = fg;
  }
  return hits;
}

function loadSource(dataPath) {
  if (dataPath) {
    var data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    return Promise.resolve({ source: dataPath, index: indexFromModels(data.models || []) });
  }
  return get(BASE + 'data/index.json').then(function (ix) {
    return { source: BASE + 'data/index.json', index: ix.models };
  }, function (err) {
    if (err.status !== 404) throw err;
    return get(BASE + 'data/models.json').then(function (data) {
      return { source: BASE + 'data/models.json', index: indexFromModels(data.models || []) };
    });
  });
}

function record(entry) {
  if (entry._rec) return Promise.resolve(entry._rec);
  return get(BASE + entry.file);
}

// Smallest to largest: hardware by model number (50G < 70G < 120G < 1800F),
// generation letter as tiebreak, then VMs by size (VM01 ... VMUL).
function sizeKey(r) {
  var id = String(r.model_id || ''), parts = id.split('-'), prefix = parts.shift(), code = parts.join('-');
  var famRank = { FG: 0, FWF: 1, FGR: 2 }[prefix];
  if (/^VM/i.test(code)) {
    var n = /UL/i.test(code) ? 99999 : parseInt((code.match(/\d+/) || ['0'])[0], 10);
    return [1, n, 0, 0];
  }
  var m = code.match(/(\d+)([A-Z]?)/i) || [0, '0', ''];
  return [0, parseInt(m[1], 10), (m[2] || '').toUpperCase().charCodeAt(0) || 0, famRank == null ? 9 : famRank];
}
function bySize(a, b) {
  var x = sizeKey(a), y = sizeKey(b);
  for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// Template: a local copy (chat folder, then next to this script) or, if none,
// the published copy in the ds-grabber repo. Nothing is written except the report.
function loadTemplate() {
  var here = path.dirname(process.argv[1]);
  var local = [path.join(process.cwd(), TEMPLATE), path.join(here, TEMPLATE)].filter(function (p) {
    return fs.existsSync(p);
  })[0];
  if (local) return Promise.resolve(fs.readFileSync(local, 'utf8'));
  return get(TEMPLATE_URL, 0, true);
}

function writeReport(out, records, html) {
  var re = /<script id="compare-data" type="application\/json">[\s\S]*?<\/script>/;
  if (!re.test(html)) throw new Error('template is missing the compare-data block');
  var payload = JSON.stringify({ models: records.map(function (r) { return r.model_id; }), records: records })
    .replace(/<\//g, '<\\/');
  var block = '<script id="compare-data" type="application/json">' + payload + '</script>';
  fs.writeFileSync(path.basename(out), html.replace(re, function () { return block; }), 'utf8');
  return path.basename(out);
}

// Chat table, built here so the agent pastes it instead of formatting 60 values.
var ROWS = [
  ['threat_protection_throughput_mbps', 'Threat Protection Throughput', 'mbps', 1],
  ['ngfw_throughput_mbps', 'NGFW Throughput', 'mbps', 1],
  ['ips_throughput_mbps', 'IPS Throughput', 'mbps', 1],
  ['ssl_inspection_throughput_mbps', 'SSL Inspection Throughput', 'mbps', 1],
  ['fw_throughput_1518_mbps', 'Firewall Throughput 1518 B UDP', 'mbps', 1],
  ['fw_throughput_64_mbps', 'Firewall Throughput 64 B UDP', 'mbps', 1],
  ['concurrent_sessions', 'Concurrent Sessions', 'count', 1],
  ['new_sessions_per_sec', 'New Sessions/Sec', 'count', 1],
  ['firewall_policies', 'Firewall Policies', 'count', 1],
  ['ipsec_throughput_mbps', 'IPsec VPN Throughput', 'mbps', 1],
  ['ipsec_tunnels_g2g', 'Site-to-Site IPsec Tunnels', 'count', 1],
  ['ipsec_tunnels_c2g', 'Client-to-Site IPsec Tunnels', 'count', 1],
  ['vdoms_max', 'VDOMs Max', 'count', 1],
  ['max_fortiswitches', 'Max FortiSwitches', 'count', 1],
  ['max_fortiaps_total', 'Max FortiAPs', 'count', 1]
];
function fmtNum(v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
function fmtVal(v, kind) {
  if (kind === 'mbps') return v >= 1000 ? fmtNum(v / 1000) + ' Gbps' : fmtNum(v) + ' Mbps';
  return fmtNum(v);
}
function shortName(r) { return String(r.model).replace(/^FortiGate\s+Rugged\s+/, 'Rugged ').replace(/^FortiGate\s+/, ''); }
function buildTable(recs) {
  var two = recs.length === 2;
  var head = ['Spec'].concat(recs.map(function (r) { return r.model; }));
  if (two) head.push(shortName(recs[1]) + ' vs ' + shortName(recs[0]));
  var lines = ['| ' + head.join(' | ') + ' |', '|' + head.map(function () { return '---|'; }).join('')];
  ROWS.forEach(function (row) {
    var key = row[0], label = row[1], kind = row[2], dir = row[3];
    if (!recs.some(function (r) { return r.specs && r.specs[key]; })) return;
    var cells = recs.map(function (r) {
      var sp = r.specs && r.specs[key];
      if (!sp) return { t: 'not listed', v: null };
      if (typeof sp.value !== 'number') return { t: sp.raw || 'N/A', v: null };
      return { t: fmtVal(sp.value, kind), v: sp.value };
    });
    var vals = cells.map(function (c) { return c.v; }).filter(function (v) { return v !== null; });
    var distinct = vals.filter(function (v, i) { return vals.indexOf(v) === i; });
    var best = vals.length > 1 && distinct.length > 1 ? (dir > 0 ? Math.max.apply(null, vals) : Math.min.apply(null, vals)) : null;
    var out = [label].concat(cells.map(function (c) { return best !== null && c.v === best ? '**' + c.t + '**' : c.t; }));
    if (two) {
      var a = cells[0].v, b = cells[1].v, d = '';
      if (a !== null && b !== null && a !== 0) {
        var pct = (b - a) / a * 100;
        d = a === b ? 'Same' : (b > a ? '+' : '') + (Math.abs(pct) < 1 ? pct.toFixed(1) : Math.round(pct)) + '%';
      }
      out.push(d);
    }
    lines.push('| ' + out.join(' | ') + ' |');
  });
  return lines.join('\n');
}

function main() {
  var args = process.argv.slice(2), queries = [], dataPath = null, report = null;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--data' || args[i] === '--file') dataPath = args[++i];
    else if (args[i] === '--report') report = args[++i];
    else if (args[i] === '--records') { /* accepted for compatibility; --report embeds records */ }
    else queries.push(args[i]);
  }
  if (!queries.length) return fail('no models given. Usage: node ds-specs.js [--report <file.html>] 90G 120G');
  if (queries.length > 4) return fail('compare up to 4 models at a time');
  if (report && report !== 'auto' && !/\.html$/i.test(report)) return fail('--report needs "auto" or a .html file name');

  return loadSource(dataPath).then(function (src) {
    var resolved = [], unresolved = [];
    queries.forEach(function (q) {
      var hits = resolve(q, src.index);
      if (hits.length === 1) return resolved.push(hits[0]);
      var code = norm(q);
      var cands = hits.length ? hits : src.index.filter(function (m) {
        return (m.codes || []).some(function (c) { return c.indexOf(code.slice(0, 3)) >= 0; });
      }).slice(0, 10);
      unresolved.push({ query: q, candidates: cands.map(function (m) { return m.model + ' (' + m.model_id + ')'; }) });
    });
    return Promise.all(resolved.map(record)).then(function (recs) {
      recs.sort(bySize);
      var out = {
        version: VERSION,
        source: src.source,
        resolved: recs.map(function (r) {
          var specs = {};
          FIELDS.forEach(function (f) { if (r.specs && r.specs[f]) specs[f] = r.specs[f]; });
          return { model: r.model, model_id: r.model_id, form_factor: r.form_factor,
                   spec_url: (r.source && (r.source.spec_url || r.source.url)) || null, specs: specs };
        }),
        unresolved: unresolved
      };
      if (recs.length) {
        out.table = buildTable(recs);
        out.datasheet_links = recs.map(function (r) {
          return r.model + ' datasheet: ' + ((r.source && (r.source.spec_url || r.source.url)) || 'not listed');
        });
        if (recs.some(function (r) { return r.form_factor === 'vm'; }) && recs.some(function (r) { return r.form_factor !== 'vm'; })) {
          out.vm_note = 'The FortiGate VM datasheet lists capacity only, not throughput.';
        }
      }
      if (!report) { process.stdout.write(JSON.stringify(out, null, 1) + '\n'); return; }
      if (unresolved.length) {
        out.report_skipped = 'resolve every model before building the report';
        process.stdout.write(JSON.stringify(out, null, 1) + '\n');
        return;
      }
      return loadTemplate().then(function (html) {
          if (report === 'auto') {
            var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
            report = 'fortigate-head-to-head-' + recs.map(function (r) {
              return String(r.model_id).replace(/[^A-Za-z0-9]+/g, '');
            }).join('-vs-') + '-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.html';
          }
          out.report = writeReport(report, recs, html);
          out.report_path = path.resolve(out.report);
        process.stdout.write(JSON.stringify(out, null, 1) + '\n');
      });
    });
  });
}

try {
  main().catch(function (e) { fail(e && e.message ? e.message : e); });
} catch (e) {
  fail(e && e.message ? e.message : e);
}
