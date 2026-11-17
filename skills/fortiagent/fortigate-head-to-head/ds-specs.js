#!/usr/bin/env node
/* ds-specs.js - FortiGate Head-to-Head helper (Node 14+, no dependencies).
 *
 * Fetches ds-grabber model data, resolves the model names the user typed, and
 * prints one JSON document. With --report it also writes the HTML report from
 * the skill template, with the full records embedded, so nothing is retyped.
 * Writes only the --report file, in the current folder. Never prints credentials.
 *
 * Usage:
 *   node ds-specs.js 90G 120G
 *   node ds-specs.js --report fortigate-head-to-head-FG90G-vs-FG120G-2026-11-17.html 90G 120G
 *   node ds-specs.js --data ds-models.json 90G 120G      (local file saved by curl -o)
 *
 * Output:
 *   { "source", "resolved": [ { model, model_id, form_factor, spec_url, specs } ],
 *     "unresolved": [ { "query", "candidates": [ "FortiGate 50G/51G (FG-50G/51G)", ... ] } ],
 *     "report": "<file>" (only with --report) }
 *   On failure: { "error": "..." } and exit code 1.
 */
'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');

var BASE = 'https://raw.githubusercontent.com/jclark1978/ds-grabber/main/';
var TEMPLATE = 'fortigate-head-to-head-template.html';
var FIELDS = [
  'threat_protection_throughput_mbps', 'ngfw_throughput_mbps', 'ips_throughput_mbps',
  'ssl_inspection_throughput_mbps', 'fw_throughput_1518_mbps', 'fw_throughput_64_mbps',
  'concurrent_sessions', 'new_sessions_per_sec', 'firewall_policies', 'ipsec_throughput_mbps',
  'ipsec_tunnels_g2g', 'ipsec_tunnels_c2g', 'vdoms_max', 'max_fortiswitches', 'max_fortiaps_total'
];
var FAMILY = { FG: 'FortiGate', FWF: 'FortiWiFi', FGR: 'FortiGate Rugged' };

function get(url, hops) {
  hops = hops || 0;
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'ds-specs' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        return resolve(get(res.headers.location, hops + 1));
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

function writeReport(out, records) {
  var here = path.dirname(process.argv[1]);
  var tpl = [path.join(process.cwd(), TEMPLATE), path.join(here, TEMPLATE)].filter(function (p) {
    return fs.existsSync(p);
  })[0];
  if (!tpl) throw new Error(TEMPLATE + ' not found next to ds-specs.js or in the current folder');
  var html = fs.readFileSync(tpl, 'utf8');
  var re = /<script id="compare-data" type="application\/json">[\s\S]*?<\/script>/;
  if (!re.test(html)) throw new Error('template is missing the compare-data block');
  var payload = JSON.stringify({ models: records.map(function (r) { return r.model_id; }), records: records })
    .replace(/<\//g, '<\\/');
  var block = '<script id="compare-data" type="application/json">' + payload + '</script>';
  fs.writeFileSync(path.basename(out), html.replace(re, function () { return block; }), 'utf8');
  return path.basename(out);
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
  if (report && !/\.html$/i.test(report)) return fail('--report needs a .html file name');

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
      var out = {
        source: src.source,
        resolved: recs.map(function (r) {
          var specs = {};
          FIELDS.forEach(function (f) { if (r.specs && r.specs[f]) specs[f] = r.specs[f]; });
          return { model: r.model, model_id: r.model_id, form_factor: r.form_factor,
                   spec_url: (r.source && (r.source.spec_url || r.source.url)) || null, specs: specs };
        }),
        unresolved: unresolved
      };
      if (report) {
        if (unresolved.length) out.report_skipped = 'resolve every model before building the report';
        else out.report = writeReport(report, recs);
      }
      process.stdout.write(JSON.stringify(out, null, 1) + '\n');
    });
  });
}

try {
  main().catch(function (e) { fail(e && e.message ? e.message : e); });
} catch (e) {
  fail(e && e.message ? e.message : e);
}
