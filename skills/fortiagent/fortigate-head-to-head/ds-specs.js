#!/usr/bin/env node
/* ds-specs.js v1.1.0 - FortiGate Head-to-Head helper (Node 14+, no dependencies).
 *
 * Fetches datasheet data, resolves the model names the user typed, and prints one
 * JSON document. With --report it also writes the HTML report from the skill
 * template, with the data embedded, so nothing is retyped.
 *
 * Data (all public GitHub repos, refreshed weekly from official datasheets):
 *   FortiGate / FortiWiFi / Rugged   jclark1978/ds-grabber
 *   Palo Alto Networks PA-Series     jclark1978/palo-ds-grabber
 *   Cisco Secure Firewall, Meraki MX jclark1978/cisco-ds-grabber
 *
 * Writes only the --report file (and the template, fetched from GitHub when it is missing), in the current folder. Never prints credentials.
 *
 * Usage:
 *   node ds-specs.js --report auto 90G 120G                 FortiGate only (same as v1.0)
 *   node ds-specs.js --report auto 120G PA-3410 "Firepower 1150"   FortiGate vs named competitors
 *   node ds-specs.js --match auto --report auto 120G        closest Palo Alto, Cisco FTD, Meraki MX
 *   node ds-specs.js --match palo --report auto 120G        one vendor (palo, cisco, ftd, meraki, all)
 *   node ds-specs.js --match auto --report auto PA-3410     competitor -> closest FortiGate
 *   node ds-specs.js --match auto --min-ports 10G:6 --report auto MX450   only models with 6+ ports at 10G or faster
 *   node ds-specs.js --data ds-models.json --palo-data pa-models.json --cisco-data cisco-models.json ...
 *
 * Output (FortiGate only): { source, resolved[], unresolved[], report, report_path }  (v1.0 shape)
 * Output (cross-vendor):   adds mode, cross_vendor, match, table_md, caveats; resolved[] adds vendor, software.
 * On failure: { "error": "..." } and exit code 1.
 */
'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');

var VERSION = '1.2.0';
// Pinned to this version's tag so the template always matches the helper.
var TEMPLATE_URL = 'https://raw.githubusercontent.com/jclark1978/ds-grabber/fortiagent-h2h-v1.2.0/skills/fortiagent/fortigate-head-to-head/fortigate-head-to-head-template.html';
var MIN_PORTS = []; // [{ speed: 10, count: 6, label: '10G' }] from --min-ports 10G:6
var BASES = {
  fortinet: 'https://raw.githubusercontent.com/jclark1978/ds-grabber/main/',
  palo: 'https://raw.githubusercontent.com/jclark1978/palo-ds-grabber/main/',
  cisco: 'https://raw.githubusercontent.com/jclark1978/cisco-ds-grabber/main/'
};
var BASE = BASES.fortinet;
var TEMPLATE = 'fortigate-head-to-head-template.html';
var FIELDS = [
  'threat_protection_throughput_mbps', 'ngfw_throughput_mbps', 'ips_throughput_mbps',
  'ssl_inspection_throughput_mbps', 'fw_throughput_1518_mbps', 'fw_throughput_64_mbps',
  'concurrent_sessions', 'new_sessions_per_sec', 'firewall_policies', 'ipsec_throughput_mbps',
  'ipsec_tunnels_g2g', 'ipsec_tunnels_c2g', 'vdoms_max', 'max_fortiswitches', 'max_fortiaps_total'
];
var FAMILY = { FG: 'FortiGate', FWF: 'FortiWiFi', FGR: 'FortiGate Rugged' };

// Product lines. Cisco records split by software image.
var LINES = {
  fortinet: { vendor: 'Fortinet', label: 'FortiGate', order: 0 },
  palo: { vendor: 'Palo Alto Networks', label: 'Palo Alto PA-Series', order: 1 },
  ftd: { vendor: 'Cisco', label: 'Cisco Secure Firewall (FTD)', order: 2 },
  asa: { vendor: 'Cisco', label: 'Cisco ASA', order: 3 },
  meraki: { vendor: 'Cisco', label: 'Cisco Meraki MX', order: 4 }
};

/* Cross-vendor rows. fg = FortiGate field; per competitor line: [field or [fields], quality].
 * quality: best = same test intent, fair = close, loose = different test, nearest = no
 * equivalent published, closest shown. Rows bold a best value only when every competitor
 * cell in the row is best or fair. */
var CROSS_ROWS = [
  { id: 'threat', label: 'Threat Protection Throughput', kind: 'mbps', fg: 'threat_protection_throughput_mbps',
    palo: ['threat_prevention_throughput_mbps', 'best'], ftd: ['ngfw_throughput_mbps', 'nearest'],
    meraki: ['advanced_security_throughput_mbps', 'fair'] },
  { id: 'ngfw', label: 'NGFW Throughput', kind: 'mbps', fg: 'ngfw_throughput_mbps',
    palo: ['fw_throughput_appmix_mbps', 'loose'], ftd: ['ngfw_throughput_mbps', 'fair'],
    meraki: ['ngfw_throughput_mbps', 'fair'] },
  { id: 'ips', label: 'IPS Throughput', kind: 'mbps', fg: 'ips_throughput_mbps',
    ftd: [['ips_throughput_mbps', 'avc_ips_throughput_mbps'], 'fair'] },
  { id: 'app', label: 'Application Control Throughput', kind: 'mbps', fg: 'app_control_throughput_mbps',
    ftd: ['fw_avc_throughput_mbps', 'loose'] },
  { id: 'ssl', label: 'SSL/TLS Inspection Throughput', kind: 'mbps', fg: 'ssl_inspection_throughput_mbps',
    ftd: ['tls_throughput_mbps', 'loose'] },
  { id: 'fw', label: 'Firewall Throughput', kind: 'mbps', fg: 'fw_throughput_1518_mbps',
    meraki: ['fw_throughput_mbps', 'loose'], asa: ['fw_throughput_mbps', 'fair'] },
  { id: 'ipsec', label: 'IPsec VPN Throughput', kind: 'mbps', fg: 'ipsec_throughput_mbps',
    palo: ['ipsec_throughput_mbps', 'loose'], ftd: ['ipsec_throughput_mbps', 'loose'],
    meraki: ['ipsec_throughput_mbps', 'loose'], asa: ['ipsec_throughput_mbps', 'loose'] },
  { id: 'cs', label: 'Concurrent Sessions', kind: 'count', fg: 'concurrent_sessions',
    palo: ['concurrent_sessions', 'fair'], ftd: ['concurrent_sessions', 'fair'], asa: ['concurrent_sessions', 'fair'] },
  { id: 'cps', label: 'New Sessions per Second', kind: 'count', fg: 'new_sessions_per_sec',
    palo: ['new_sessions_per_sec', 'fair'], ftd: ['new_sessions_per_sec', 'fair'], asa: ['new_sessions_per_sec', 'fair'] },
  { id: 'tunnels', label: 'Site-to-Site VPN Tunnels', kind: 'count', fg: 'ipsec_tunnels_g2g',
    ftd: ['vpn_peers_max', 'loose'], meraki: ['vpn_tunnels_max', 'loose'], asa: ['vpn_peers_max', 'loose'] },
  { id: 'virt', label: 'Virtual Systems (Maximum)', kind: 'count', fg: 'vdoms_max',
    palo: ['vsys_max', 'fair'], ftd: ['instances_max', 'loose'], asa: ['security_contexts.max', 'fair'] },
  { id: 'policies', label: 'Firewall Policies', kind: 'count', fg: 'firewall_policies' },
  { id: 'vcpu', label: 'vCPU', kind: 'count', vmOnly: true }
];

// One line per competitor cell that is loose or nearest, shown under the tables.
var CAVEATS = {
  'ftd|threat': 'Cisco publishes no threat figure that includes anti-malware; the Threat Protection row shows its FW + AVC + IPS figure, the closest it publishes.',
  'palo|ngfw': 'Palo Alto firewall throughput is App-ID with logging (appmix) and has no IPS; FortiGate NGFW includes IPS.',
  'palo|ipsec': 'Palo Alto IPsec uses 64 KB HTTP transactions; FortiGate uses 512 byte packets, the harder test.',
  'ftd|app': 'Cisco FW + AVC is measured with 1024 byte transactions; FortiGate Application Control uses HTTP 64K.',
  'ftd|ssl': 'Cisco and FortiGate TLS inspection figures use different traffic mixes; see each footnote.',
  'ftd|ipsec': 'Cisco IPsec uses 1024 byte TCP with Fastpath; FortiGate uses 512 byte packets.',
  'asa|ipsec': 'Cisco ASA IPsec uses 450 byte UDP; FortiGate uses 512 byte packets.',
  'meraki|ipsec': 'Meraki states no packet size for site-to-site VPN throughput.',
  'meraki|fw': 'Meraki firewall throughput states no packet size; FortiGate uses 1518 byte UDP.',
  'ftd|tunnels': 'Cisco "Maximum VPN peers" counts all VPN peers, not only site-to-site tunnels.',
  'asa|tunnels': 'Cisco "Maximum VPN peers" counts all VPN peers, not only site-to-site tunnels.',
  'meraki|tunnels': 'Meraki measured its tunnel maximum with no client traffic on the tunnels.',
  'ftd|virt': 'Cisco multi-instance is a count of separate FTD instances, not the same as VDOMs.'
};
var MATCH_TARGET = /^(auto|all|competitors|palo|paloalto|pa|pan|cisco|ftd|firepower|securefirewall|sfw|meraki|mx|fortigate|fortinet|fg|fgt)([,+](auto|all|competitors|palo|paloalto|pa|pan|cisco|ftd|firepower|securefirewall|sfw|meraki|mx|fortigate|fortinet|fg|fgt))*$/i;

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
          (res.statusCode === 404 ? ' (if every URL from this repo returns 404, the GitHub repo is private)' : ''));
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

function getText(url, hops) {
  hops = hops || 0;
  return new Promise(function (resolve, reject) {
    https.get(url, { headers: { 'User-Agent': 'ds-specs' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) { res.resume(); return resolve(getText(res.headers.location, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' from ' + url)); }
      var body = ''; res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve(body); });
    }).on('error', reject);
  });
}
// Make sure a v1.1+ template sits in the current folder; download it from GitHub when it is missing or old.
function ensureTemplate() {
  var local = [path.join(process.cwd(), TEMPLATE), path.join(path.dirname(process.argv[1]), TEMPLATE)].filter(function (p) {
    return fs.existsSync(p) && /TEMPLATE v1\.[1-9]/.test(fs.readFileSync(p, 'utf8'));
  })[0];
  if (local) return Promise.resolve(local);
  return getText(TEMPLATE_URL).then(function (html) {
    if (!/compare-data/.test(html) || !/TEMPLATE v1\.[1-9]/.test(html)) throw new Error('downloaded template is not valid: ' + TEMPLATE_URL);
    fs.writeFileSync(TEMPLATE, html, 'utf8');
    return path.resolve(TEMPLATE);
  }, function (e) {
    throw new Error(TEMPLATE + ' is missing and could not be downloaded (' + e.message + '). Write it from the skill file of the same name.');
  });
}

function fail(msg) {
  process.stdout.write(JSON.stringify({ error: String(msg) }) + '\n');
  process.exit(1);
}

/* ---------------- FortiGate resolution (unchanged from v1.0) ---------------- */

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
function resolveFG(query, index) {
  var q = String(query).trim().toUpperCase();
  var exact = index.filter(function (m) { return m.model_id.toUpperCase() === q; });
  if (exact.length) return exact;
  var code = norm(query), fam = familyHint(query);
  var hits = index.filter(function (m) { return (m.codes || []).indexOf(code) >= 0; });
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
function fgCandidates(query, index) {
  var code = norm(query);
  return index.filter(function (m) {
    return (m.codes || []).some(function (c) { return c.indexOf(code.slice(0, 3)) >= 0; });
  }).slice(0, 10);
}

/* ---------------- Competitor resolution ---------------- */

function vendorHint(text) {
  var t = String(text).toUpperCase().trim();
  if (/FORTI|^FG[TRW]?[-\s]|^FWF/.test(t)) return 'fortinet';
  if (/PALO|^PA[-\s]?\d/.test(t)) return 'palo';
  if (/MERAKI|^V?MX\s*-?\d|\bVMX\b|^C?8\d{3}\S*-MX$/.test(t)) return 'cisco';
  if (/CISCO|FIREPOWER|^FPR|^FP\s*-?\d|SECURE\s*FIREWALL|^SF\s*-?\d|\bFTDV?\b|\bTDV\b|THREAT\s*DEFENSE|\bASAV?|ISA\s*-?3000/.test(t)) return 'cisco';
  return null;
}
function alnum(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

function paIndex(models) {
  return models.map(function (m) {
    var code = m.model_id.replace(/^PA-/i, '').toUpperCase();
    return { line: 'palo', model_id: m.model_id, model: m.model, rec: m,
             codes: [code, code.replace(/-/g, ''), alnum(m.model_id)] };
  });
}
function paCode(text) {
  var t = String(text).toUpperCase().replace(/PALO\s*ALTO|NETWORKS/g, '').trim();
  t = t.replace(/^PA\s*-?/, '').replace(/\s+/g, '').replace(/^-+/, '');
  return t;
}
function resolvePA(query, index) {
  var c = paCode(query), ca = alnum(c);
  return index.filter(function (m) { return m.codes.indexOf(c) >= 0 || m.codes.indexOf(ca) >= 0; });
}

function ciscoLine(rec) {
  if ((rec.images || []).indexOf('mx') >= 0) return 'meraki';
  return rec.default_image === 'ftd' ? 'ftd' : 'asa';
}
function ciscoIndex(models) {
  return models.map(function (m) {
    var stripped = m.model.replace(/^(Cisco|Meraki)\s+/i, '').replace(/^(Secure Firewall|Firepower)\s+/i, '');
    var codes = [alnum(m.model_id), alnum(m.model), alnum(stripped)];
    if (/^C8/i.test(stripped)) codes.push(alnum(stripped).replace(/^C/, ''));
    if (m.printed_as) codes.push(alnum(m.printed_as));
    var tokens = (m.model + ' ' + m.model_id + ' ' + (m.series || '')).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    return { line: ciscoLine(m), model_id: m.model_id, model: m.model, rec: m, codes: codes, tokens: tokens };
  });
}
function ciscoCode(text) {
  var t = String(text).toUpperCase();
  t = t.replace(/\bCISCO\b|\bMERAKI\b|SECURE\s*FIREWALL|FIREPOWER/g, ' ');
  t = t.replace(/^\s*(FPR|FP|SF)\s*-?(?=\d)/, '');
  return alnum(t);
}
function resolveCisco(query, index) {
  var c = ciscoCode(query);
  var hits = index.filter(function (m) { return m.codes.indexOf(c) >= 0; });
  if (hits.length) return hits;
  // Token match for virtual names: "TDv 8 vCPU AWS", "ASAv10 Azure".
  var toks = String(query).toUpperCase().replace(/\bF?TDV\b/g, 'THREAT DEFENSE VIRTUAL')
    .replace(/\bCISCO\b|\bMERAKI\b/g, ' ').split(/[^A-Z0-9]+/).filter(Boolean);
  if (!toks.length) return [];
  return index.filter(function (m) {
    return toks.every(function (t) {
      return m.tokens.indexOf(t) >= 0 || m.tokens.some(function (x) { return x === t || (t.length > 3 && x.indexOf(t) === 0); });
    });
  });
}

/* ---------------- Data loading ---------------- */

function loadFG(dataPath, full) {
  if (dataPath) {
    var data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    return Promise.resolve({ source: dataPath, index: indexFromModels(data.models || []) });
  }
  if (full) {
    return get(BASE + 'data/models.json').then(function (data) {
      return { source: BASE + 'data/models.json', index: indexFromModels(data.models || []) };
    });
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
function readOrGet(localPath, url) {
  if (localPath) return Promise.resolve(JSON.parse(fs.readFileSync(localPath, 'utf8')));
  return get(url);
}
function loadPA(p) {
  var url = BASES.palo + 'data/models.json';
  return readOrGet(p, url).then(function (d) { return { source: p || url, index: paIndex(d.models || d) }; });
}
function loadCisco(p) {
  var url = BASES.cisco + 'data/models.json';
  return readOrGet(p, url).then(function (d) { return { source: p || url, index: ciscoIndex(Array.isArray(d) ? d : d.models) }; });
}
function fgRecord(entry) {
  if (entry._rec) return Promise.resolve(entry._rec);
  return get(BASE + entry.file);
}

/* ---------------- Sorting ---------------- */

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

/* ---------------- Per-line accessors ---------------- */

function specsOf(item) {
  var r = item.rec;
  if (item.line === 'fortinet' || item.line === 'palo') return r.specs || {};
  var img = item.line === 'meraki' ? 'mx' : item.line;
  return (r.specs_by_image || {})[img] || {};
}
function getSpec(item, field) {
  var fields = Array.isArray(field) ? field : [field];
  var specs = specsOf(item);
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], sub = null;
    if (f.indexOf('.') > 0) { sub = f.split('.')[1]; f = f.split('.')[0]; }
    var s = specs[f];
    if (!s) continue;
    if (sub) {
      var v = s.value && typeof s.value === 'object' ? s.value[sub] : null;
      return { value: typeof v === 'number' ? v : null, raw: v != null ? String(v) : s.raw, label: s.label, notes: s.notes, src: s };
    }
    return { value: s.value, raw: s.raw, label: s.label, notes: s.notes, src: s };
  }
  return null;
}
function isVirtual(item) { return item.rec.form_factor === 'vm' || item.rec.form_factor === 'virtual'; }
function isRugged(item) {
  var r = item.rec;
  if (item.line === 'fortinet') return /^FGR-/.test(r.model_id);
  if (item.line === 'palo') return / ?R Series$/.test(r.series || '') && /\dR/.test(r.series || '');
  return /ISA/i.test(r.series || '');
}
function softwareOf(item, spec) {
  if (item.line === 'fortinet') return 'FortiOS version not stated in datasheet';
  if (item.line === 'palo') {
    var v = (spec && spec.src && spec.src.pan_os) || (item.rec.test_conditions || {}).pan_os;
    return v ? 'PAN-OS ' + v : 'PAN-OS version not stated';
  }
  if (spec && spec.src && spec.src.software) return spec.src.software;
  var specs = specsOf(item), k = Object.keys(specs)[0];
  return k && specs[k].software ? specs[k].software : LINES[item.line].label;
}
function testText(item, spec) {
  if (!spec || !spec.src) return '';
  var s = spec.src;
  if (item.line === 'fortinet') {
    var fn = item.rec.footnotes || {};
    return (s.notes || []).map(function (k) { return fn[k]; }).filter(Boolean).join(' ');
  }
  if (item.line === 'palo') return (s.test_conditions || []).join(' ');
  return (s.notes || []).join(' ');
}
// Competitor names always carry the vendor: "Palo Alto PA-3410", "Cisco Secure Firewall 3110 (FTD)", "Cisco Meraki MX95".
function displayName(item) {
  var r = item.rec, m = r.model;
  if (item.line === 'palo') return /^Palo Alto/i.test(m) ? m : 'Palo Alto ' + m;
  if (item.line === 'fortinet') return m;
  if (!/^Cisco\b/i.test(m)) m = 'Cisco ' + m;
  if (item.line === 'ftd') return m + ' (FTD)';
  if (item.line === 'asa') return m + ' (ASA)';
  return m;
}
function specUrl(r) { return (r.source && (r.source.spec_url || r.source.url)) || null; }

/* ---------------- Formatting ---------------- */

function num(v) {
  var r = Math.round(v * 100) / 100, p = String(r).split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return p.join('.');
}
function fmt(v, kind) {
  if (v === null || v === undefined || typeof v === 'object') return null;
  if (typeof v !== 'number') return String(v);
  if (kind === 'mbps') return v >= 1000 ? num(v / 1000) + ' Gbps' : num(v) + ' Mbps';
  return num(v);
}
function pct(a, b) {
  if (!a || b == null) return null;
  var p = (b - a) / a * 100;
  return Math.abs(p) < 1 ? Math.round(p * 10) / 10 : Math.round(p);
}

/* ---------------- Matching ---------------- */

// Anchor: threat throughput for hardware, vCPU for virtual.
function anchorOf(item) {
  var r = item.rec;
  if (isVirtual(item)) {
    var vc = item.line === 'fortinet' ? (r.vm || {}).vcpu_max : (item.line === 'ftd' ? (r.vm || {}).vcpu : null);
    return typeof vc === 'number' ? { basis: 'vcpu', value: vc } : null;
  }
  var f = { fortinet: 'threat_protection_throughput_mbps', palo: 'threat_prevention_throughput_mbps',
            ftd: 'ngfw_throughput_mbps', meraki: 'advanced_security_throughput_mbps' }[item.line];
  if (!f) return null;
  var s = getSpec(item, f);
  return s && typeof s.value === 'number' ? { basis: 'threat', value: s.value, field: f, label: s.label } : null;
}
function anchorText(a) { return a.basis === 'vcpu' ? a.value + ' vCPU' : fmt(a.value, 'mbps'); }

var VARIANT = /-(POE|DSL|SFP|5G|3G4G|NEBS|M12|DUAL|II|LTE)\b/i;
function candidatePool(line, pools, rugged, basis) {
  var list = pools[line] || [];
  return list.filter(function (it) {
    var r = it.rec, virt = isVirtual(it);
    if (basis === 'vcpu') {
      if (!virt) return false;
      if (line === 'ftd') return /esxi-kvm-openstack/.test(r.model_id);
      return line === 'fortinet';
    }
    if (virt) return false;
    if (line === 'fortinet') {
      if (/^FWF-/.test(r.model_id)) return false;
      if (rugged !== /^FGR-/.test(r.model_id)) return false;
      if (/^FGR?-\d+E\b/.test(r.model_id)) return false; // E generation: older models, skip for new sizing
      return !VARIANT.test(r.model_id.replace(/\/-DC$/, ''));
    }
    if (line === 'palo' || line === 'ftd') return rugged === isRugged(it);
    return true;
  });
}
function tieKey(it) {
  var id = it.rec.model_id, n = parseInt((id.match(/\d+/) || ['0'])[0], 10);
  if (it.line === 'fortinet') {
    var g = (id.replace(/^FG[RW]?-/, '').match(/^\d+([A-Z])/) || [0, 'A'])[1].charCodeAt(0);
    return [-g, n, id.length];
  }
  if (it.line === 'meraki') return [/^Meraki/.test(it.rec.model) ? 0 : 1, id.length, n];
  return [id.length, n, 0];
}
function cmpKey(a, b) { for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }

function brief(it, a, src) {
  return { model: displayName(it), model_id: it.rec.model_id, anchor: anchorText(a),
           diff_pct: pct(src, a.value), spec_url: specUrl(it.rec) };
}
function matchLine(src, line, pools) {
  var sa = anchorOf(src);
  if (!sa) {
    var r0 = 'the source model has no threat throughput in its datasheet';
    if (isVirtual(src)) r0 = src.line === 'fortinet' ? 'the FortiGate VM datasheet lists no vCPU count for this size'
      : (src.line === 'meraki' ? 'the Meraki vMX datasheet lists no vCPU count, and FortiGate VM datasheets list no throughput, so there is no common basis'
      : 'this virtual model has no vCPU count in its datasheet');
    else if (src.line === 'asa') r0 = 'Cisco publishes only ASA firewall figures for this model, no threat throughput';
    return { skip: true, reason: r0 };
  }
  var noPortData = 0;
  function score(pool) {
    var out = [];
    pool.forEach(function (it) {
      var a = anchorOf(it);
      if (!a || a.basis !== sa.basis || !(a.value > 0)) return;
      if (!passesPorts(it)) { if (portCheck(it).pass === null) noPortData++; return; }
      out.push({ it: it, a: a, d: Math.abs(Math.log(a.value / sa.value)) });
    });
    return out;
  }
  var rugged = isRugged(src), note = null;
  var scored = score(candidatePool(line, pools, rugged, sa.basis));
  // Rugged source: use rugged models only when one is within 2x; otherwise standard models.
  if (rugged && line === 'meraki') note = 'Meraki has no rugged MX, so this is a standard model.';
  else if (rugged && !scored.some(function (s) { return s.d <= Math.log(2); })) {
    var std = score(candidatePool(line, pools, false, sa.basis));
    if (std.length) { scored = std; note = 'No rugged ' + LINES[line].label + ' model within 2x, so this is a standard (non-rugged) model.'; }
  } else if (rugged) note = 'Matched against rugged models.';
  if (!scored.length) {
    var why = sa.basis === 'vcpu'
      ? { palo: 'Palo Alto VM-Series datasheets publish no spec tables', meraki: 'the Meraki vMX datasheet lists no vCPU count',
          fortinet: 'no FortiGate VM size matches' }[line] || 'no virtual models with a vCPU count'
      : 'no ' + LINES[line].label + ' models with a comparable figure' +
        (MIN_PORTS.length ? ' and ' + MIN_PORTS.map(function (r) { return r.count + '+ ports at ' + r.label + ' or faster'; }).join(' and ') : '');
    return { skip: true, reason: why };
  }
  scored.sort(function (x, y) { return (x.d - y.d) || cmpKey(tieKey(x.it), tieKey(y.it)); });
  var best = scored[0];
  var also = scored.filter(function (s) { return s !== best && s.a.value === best.a.value; }).map(function (s) { return displayName(s.it); });
  var other = scored.filter(function (s) {
    return best.a.value >= sa.value ? s.a.value < sa.value : s.a.value > sa.value;
  });
  if (best.a.value === sa.value) other = scored.filter(function (s) { return s.a.value > sa.value; });
  other.sort(function (x, y) { return (x.d - y.d) || cmpKey(tieKey(x.it), tieKey(y.it)); });
  return {
    best: best, alt: other[0] || null,
    out: { line: line, vendor_label: LINES[line].label, basis: sa.basis === 'vcpu' ? 'vCPU count' : 'threat throughput',
           best: brief(best.it, best.a, sa.value), alternative: other[0] ? brief(other[0].it, other[0].a, sa.value) : null,
           also_same_value: also.slice(0, 6),
           note: [note, noPortData ? noPortData + ' model(s) without a port list in the datasheet data were left out by the port filter.' : null].filter(Boolean).join(' ') || null }
  };
}
function parseTargets(spec, srcLine) {
  var s = String(spec || 'auto').toLowerCase(), out = [];
  s.split(/[,+\s]+/).filter(Boolean).forEach(function (t) {
    if (t === 'auto') out = out.concat(srcLine === 'fortinet' ? ['palo', 'ftd', 'meraki'] : ['fortinet']);
    else if (t === 'all' || t === 'competitors') out = out.concat(['palo', 'ftd', 'meraki']);
    else if (/^(palo|paloalto|pa|pan)$/.test(t)) out.push('palo');
    else if (t === 'cisco') out = out.concat(['ftd', 'meraki']);
    else if (/^(ftd|firepower|securefirewall|sfw)$/.test(t)) out.push('ftd');
    else if (/^(meraki|mx)$/.test(t)) out.push('meraki');
    else if (/^(fortigate|fortinet|fg|fgt)$/.test(t)) out.push('fortinet');
    else throw new Error('unknown --match target "' + t + '". Use auto, all, palo, cisco, ftd, meraki or fortigate');
  });
  return out.filter(function (v, i) { return out.indexOf(v) === i; });
}

/* ---------------- Cross-vendor table ---------------- */

function interfacesText(hw) {
  var v = hw.interfaces;
  if (Array.isArray(v)) return v.filter(function (i) { return i.count; }).map(function (i) { return (i.raw || i.count) + ' x ' + i.type; }).join('; ');
  if (typeof v === 'string') return v.split(/\s*\|\s*/).join('; ');
  return null;
}
/* ---------------- Port counts by speed ---------------- */

// Max speed in Gbps named in an interface type: "10/GE SFP/+" -> 10, "25 GE SFP28 / 10 GE SFP+" -> 25,
// "5/2.5/GE RJ45" -> 5, "GE SFP" -> 1, "1G/10G SFP/SFP+" -> 10, "1/10 Gigabit (SFP)" -> 10.
function typeSpeed(t) {
  var s = String(t || '').toUpperCase().replace(/GIGABIT/g, 'GE').replace(/G\s*\/\s*(?=\d)/g, 'G '), best = 0, m;
  // A number chain ending in G: "10G", "10/GE", "25/10 GE", "5/2.5/GE", "1/10/25 GE", "1GBASE-T".
  var re = /(^|[^A-Z0-9.\/])((?:\d+(?:\.\d+)?\s*\/\s*)*\d+(?:\.\d+)?)\s*\/?\s*G(?=E|B|\b|\/|\s)/g;
  while ((m = re.exec(s))) {
    m[2].split('/').forEach(function (x) { var n = parseFloat(x); if (n > best && n <= 800) best = n; });
  }
  if (/QSFP-?DD/.test(s)) best = Math.max(best, 400);
  if (/QSFP28/.test(s)) best = Math.max(best, 100);
  if (/QSFP\+/.test(s)) best = Math.max(best, 40);
  if (/SFP28/.test(s)) best = Math.max(best, 25);
  if (/SFP\+|SFP\/\+/.test(s)) best = Math.max(best, 10);
  if (!best && /\bGE\b|BASE-?[TX]|10\/100\/1000|\bSFP\b|RJ-?45|ETHERNET/.test(s)) best = 1;
  return best;
}
var NOT_DATA_PORT = /USB|CONSOLE|SERIAL|MGMT|MANAGEMENT|\bHA\b|BLUETOOTH|\bBLE\b|MODEM|CELLULAR|\bLTE\b|3G4G|WI-?FI|\bDSL\b/i;
function portList(item) {
  var hw = item.rec.hardware || {}, out = [];
  function addString(str) {
    String(str).split(/\s*[|;]\s*(?=\d+\s*[x×])/).forEach(function (part) {
      var re = /(\d+)\s*[x×]\s*([\s\S]*?)(?=\s*\d+\s*[x×]\s|$)/g, m;
      while ((m = re.exec(part))) {
        if (NOT_DATA_PORT.test(m[2])) continue;
        out.push({ count: parseInt(m[1], 10), speed: typeSpeed(m[2]), type: m[2].trim() });
      }
    });
  }
  [hw.interfaces, item.line === 'meraki' ? hw.wan_interfaces : null].forEach(function (v) {
    if (Array.isArray(v)) v.forEach(function (i) {
      if (!i.count || NOT_DATA_PORT.test(i.type)) return;
      out.push({ count: i.count, speed: typeSpeed(i.type), type: i.type });
    });
    else if (typeof v === 'string') addString(v);
  });
  return out;
}
function portsBySpeed(item) {
  var by = {};
  portList(item).forEach(function (p) { if (p.speed) { var k = p.speed + 'G'; by[k] = (by[k] || 0) + p.count; } });
  return by;
}
function portsAtLeast(item, speed) {
  return portList(item).reduce(function (n, p) { return n + (p.speed >= speed ? p.count : 0); }, 0);
}
function portCheck(item) {
  if (!MIN_PORTS.length || isVirtual(item)) return null;
  if (!portList(item).length) return { pass: null, checks: [], note: 'no port list in the datasheet data' };
  var res = MIN_PORTS.map(function (r) { var have = portsAtLeast(item, r.speed); return { required: r.count + ' x ' + r.label + '+', have: have, pass: have >= r.count }; });
  return { pass: res.every(function (r) { return r.pass; }), checks: res };
}
function passesPorts(item) { var c = portCheck(item); return !c || c.pass === true; }
function portsText(item) {
  var by = portsBySpeed(item), keys = Object.keys(by).sort(function (a, b) { return parseFloat(b) - parseFloat(a); });
  return keys.length ? keys.map(function (k) { return by[k] + ' x ' + k; }).join(', ') : null;
}

function hwRowsFor(item) {
  var hw = item.rec.hardware || {};
  if (!Object.keys(hw).length) return {};
  var d = hw.dimensions_mm, dims = null;
  if (d && typeof d === 'object') dims = [d.h, d.w, d.d != null ? d.d : d.l].filter(function (x) { return x != null; }).join(' x ') + ' mm';
  var pw = [hw.power_avg_w, hw.power_max_w];
  var power = null;
  if (pw[0] != null || pw[1] != null) power = (pw[0] != null ? num(pw[0]) + ' W avg' : '') + (pw[0] != null && pw[1] != null ? ' / ' : '') + (pw[1] != null ? num(pw[1]) + ' W max' : '');
  if (hw.power_idle_w != null && hw.power_avg_w == null) power = num(hw.power_idle_w) + ' W idle / ' + (hw.power_max_w != null ? num(hw.power_max_w) + ' W max' : '');
  var wan = item.line === 'meraki' && hw.wan_interfaces ? 'WAN: ' + String(hw.wan_interfaces).split(/\s*\|\s*/).join('; ') + '. LAN: ' : '';
  var ifs = interfacesText(hw);
  return {
    'Data Ports by Speed': portsText(item),
    'Interfaces': ifs ? wan + ifs : null,
    'Storage': typeof hw.storage === 'string' && !/^[—–-]$/.test(hw.storage) ? hw.storage : (hw.storage ? null : null),
    'Rack Units': hw.rack_units != null ? String(hw.rack_units) : null,
    'Desktop Form Factor': hw.desktop != null ? (hw.desktop ? 'Yes' : 'No') : null,
    'Power': power,
    'Weight': hw.weight_kg != null ? num(hw.weight_kg) + ' kg' : null,
    'Dimensions (H x W x D)': dims
  };
}
var HW_LABELS = ['Data Ports by Speed', 'Interfaces', 'Storage', 'Rack Units', 'Desktop Form Factor', 'Power', 'Weight', 'Dimensions (H x W x D)'];

function crossCell(row, item) {
  if (row.vmOnly) {
    var r = item.rec, vc = item.line === 'fortinet' ? (r.vm || {}).vcpu_max : (r.vm || {}).vcpu;
    if (!isVirtual(item)) return { text: 'Hardware', value: null, missing: true };
    return vc != null ? { text: String(vc), value: vc, quality: item.line === 'fortinet' ? null : 'fair', metric: 'vCPU', software: softwareOf(item) }
                      : { text: 'Not published', value: null, missing: true };
  }
  var map = item.line === 'fortinet' ? [row.fg, null] : row[item.line];
  if (!map) return { text: item.line === 'fortinet' ? 'Not listed' : 'Not published', value: null, missing: true };
  var s = getSpec(item, map[0]);
  if (!s) return { text: item.line === 'fortinet' ? 'Not listed' : 'Not published', value: null, missing: true };
  var t = fmt(s.value, row.kind);
  if (t === null) t = s.raw;
  return { text: t, value: typeof s.value === 'number' ? s.value : null, quality: map[1], metric: s.label || '',
           test: testText(item, s), software: softwareOf(item, s) };
}
function buildCross(items) {
  var anyVM = items.some(isVirtual), rows = [], caveats = [];
  CROSS_ROWS.forEach(function (row) {
    if (row.vmOnly && !anyVM) return;
    var cells = items.map(function (it) { return crossCell(row, it); });
    if (!cells.some(function (c) { return !c.missing; })) return;
    var strict = cells.every(function (c) { return !c.quality || c.quality === 'best' || c.quality === 'fair'; });
    var vals = cells.map(function (c) { return c.value; }).filter(function (v) { return typeof v === 'number'; });
    var uniq = vals.filter(function (v, i) { return vals.indexOf(v) === i; });
    var best = strict && vals.length > 1 && uniq.length > 1 ? Math.max.apply(null, vals) : null;
    cells.forEach(function (c, i) {
      if (best !== null && c.value === best) c.best = true;
      if (c.quality === 'loose' || c.quality === 'nearest') {
        c.flag = true;
        var k = items[i].line + '|' + row.id;
        if (CAVEATS[k] && caveats.indexOf(CAVEATS[k]) < 0) caveats.push(CAVEATS[k]);
      }
    });
    rows.push({ id: row.id, label: row.label, section: 'Performance and Capacity', strict: strict, cells: cells });
  });
  var hw = items.map(hwRowsFor);
  HW_LABELS.forEach(function (lab) {
    if (!hw.some(function (h) { return h[lab]; })) return;
    rows.push({ id: 'hw', label: lab, section: 'Hardware', strict: false, cells: hw.map(function (h, i) {
      if (isVirtual(items[i])) return { text: 'Virtual', value: null, missing: true };
      return h[lab] ? { text: h[lab], value: null } : { text: 'Not listed', value: null, missing: true };
    }) });
  });
  return { rows: rows, caveats: caveats };
}
function tableMd(items, cross) {
  var perf = cross.rows.filter(function (r) { return r.section !== 'Hardware'; });
  if (MIN_PORTS.length) perf = perf.concat(cross.rows.filter(function (r) { return r.label === 'Data Ports by Speed'; }));
  var head = '| Spec | ' + items.map(displayName).join(' | ') + ' |\n|---|' + items.map(function () { return '---|'; }).join('') + '\n';
  return head + perf.map(function (r) {
    return '| ' + r.label + ' | ' + r.cells.map(function (c) {
      var t = String(c.text).replace(/\|/g, '/') + (c.flag ? ' †' : '');
      return c.best ? '**' + t + '**' : t;
    }).join(' | ') + ' |';
  }).join('\n');
}
function displayRecord(it) {
  var r = it.rec, specs = specsOf(it), all = Object.keys(specs).map(function (k) {
    var s = specs[k], v = s.value, raw = s.raw;
    if (raw == null) raw = Array.isArray(v) ? v.join(', ') : (v != null ? String(v) : '');
    return { label: s.label || k, raw: String(raw), test: testText(it, { src: s }) };
  });
  var fn = r.footnotes || {};
  return {
    model: displayName(it), model_id: r.model_id, vendor: LINES[it.line].vendor, line: it.line,
    line_label: LINES[it.line].label, series: r.series || null, form_factor: r.form_factor,
    software: softwareOf(it), source: { title: (r.source || {}).title || 'Datasheet', url: (r.source || {}).url || null,
      spec_url: specUrl(r), library_last_updated: (r.source || {}).library_last_updated || null },
    all_specs: all, footnotes: it.line === 'fortinet' ? fn : {}, vm: r.vm || null
  };
}

/* ---------------- Report ---------------- */

function writeReport(out, payloadObj) {
  var here = path.dirname(process.argv[1]);
  var tpl = [path.join(process.cwd(), TEMPLATE), path.join(here, TEMPLATE)].filter(function (p) {
    return fs.existsSync(p);
  })[0];
  if (!tpl) throw new Error(TEMPLATE + ' not found next to ds-specs.js or in the current folder');
  var html = fs.readFileSync(tpl, 'utf8');
  var re = /<script id="compare-data" type="application\/json">[\s\S]*?<\/script>/;
  if (!re.test(html)) throw new Error('template is missing the compare-data block');
  if (payloadObj.cross && !/TEMPLATE v1\.1/.test(html)) throw new Error('template is older than v1.1; rewrite ' + TEMPLATE + ' from the skill');
  var payload = JSON.stringify(payloadObj).replace(/<\//g, '<\\/');
  var block = '<script id="compare-data" type="application/json">' + payload + '</script>';
  fs.writeFileSync(path.basename(out), html.replace(re, function () { return block; }), 'utf8');
  return path.basename(out);
}
function autoName(ids) {
  var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return 'fortigate-head-to-head-' + ids.map(function (id) {
    return String(id).replace(/^threat-defense-virtual/i, 'tdv').replace(/^secure-firewall/i, 'sfw').replace(/^firepower/i, 'fpr')
      .replace(/-esxi-kvm-openstack$/i, '-esxi').replace(/[^A-Za-z0-9]+/g, '');
  }).join('-vs-') +
    '-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '.html';
}

/* ---------------- Main ---------------- */

function main() {
  var args = process.argv.slice(2), queries = [], dataPath = null, paPath = null, ciscoPath = null, report = null, match = null;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--data' || args[i] === '--file') dataPath = args[++i];
    else if (args[i] === '--palo-data') paPath = args[++i];
    else if (args[i] === '--cisco-data') ciscoPath = args[++i];
    else if (args[i] === '--report') report = args[++i];
    else if (args[i] === '--match') {
      var nx = args[i + 1];
      match = nx && MATCH_TARGET.test(nx) ? args[++i] : 'auto';
    }
    else if (args[i] === '--min-ports') {
      var spec = String(args[++i] || ''), mm = spec.match(/^(\d+(?:\.\d+)?)\s*G?E?\s*[:x]\s*(\d+)$/i);
      if (!mm) return fail('--min-ports needs SPEED:COUNT, for example 10G:6 or 25G:2');
      MIN_PORTS.push({ speed: parseFloat(mm[1]), count: parseInt(mm[2], 10), label: mm[1] + 'G' });
    }
    else if (args[i] === '--version') { process.stdout.write(JSON.stringify({ version: VERSION }) + '\n'); return Promise.resolve(); }
    else if (args[i] === '--records') { /* accepted for compatibility */ }
    else queries.push(args[i]);
  }
  if (!queries.length) return fail('no models given. Usage: node ds-specs.js [--match auto] [--report auto] 90G 120G');
  if (queries.length > 4) return fail('compare up to 4 models at a time');
  if (match && queries.length !== 1) return fail('--match takes exactly one model');
  if (report && report !== 'auto' && !/\.html$/i.test(report)) return fail('--report needs "auto" or a .html file name');

  var hints = queries.map(vendorHint);
  var needComp = !!match || hints.some(function (h) { return h && h !== 'fortinet'; });
  var fgFull = !!match;

  var tplP = report ? ensureTemplate() : Promise.resolve(null);
  return tplP.then(function () { return loadFG(dataPath, fgFull); }).then(function (fg) {
    // First pass: FortiGate resolution exactly as v1.0.
    var fgHits = queries.map(function (q, k) { return hints[k] && hints[k] !== 'fortinet' ? [] : resolveFG(q, fg.index); });
    if (fgHits.some(function (h, k) { return h.length !== 1 && hints[k] !== 'fortinet'; })) needComp = true;
    var compP = needComp ? Promise.all([loadPA(paPath), loadCisco(ciscoPath)]) : Promise.resolve(null);
    return compP.then(function (comp) {
      var resolved = [], unresolved = [];
      queries.forEach(function (q, k) {
        var h = hints[k];
        if (h === 'fortinet' || (!h && fgHits[k].length)) {
          if (fgHits[k].length === 1) return resolved.push({ line: 'fortinet', entry: fgHits[k][0] });
          var c = fgHits[k].length ? fgHits[k] : fgCandidates(q, fg.index);
          return unresolved.push({ query: q, candidates: c.map(function (m) { return m.model + ' (' + m.model_id + ')'; }) });
        }
        var hits = [];
        if (comp && (h === 'palo' || !h)) hits = hits.concat(resolvePA(q, comp[0].index));
        if (comp && (h === 'cisco' || !h)) hits = hits.concat(resolveCisco(q, comp[1].index));
        if (hits.length === 1) return resolved.push({ line: hits[0].line, item: hits[0] });
        var cands = hits;
        if (!cands.length && comp) {
          var pc = alnum(paCode(q)), cc = ciscoCode(q);
          if (h === 'palo' || !h) cands = cands.concat(comp[0].index.filter(function (m) { return pc.length > 1 && m.codes.some(function (x) { return x.indexOf(pc) === 0; }); }));
          if (h === 'cisco' || !h) cands = cands.concat(comp[1].index.filter(function (m) { return cc.length > 1 && m.codes.some(function (x) { return x.indexOf(cc) === 0; }); }));
        }
        if (!cands.length && !h) cands = fgCandidates(q, fg.index).map(function (m) { return { model: m.model, model_id: m.model_id }; });
        unresolved.push({ query: q, candidates: cands.slice(0, 10).map(function (m) {
          return (m.rec ? displayName(m) : m.model) + ' (' + m.model_id + ')';
        }) });
      });

      return Promise.all(resolved.map(function (r) {
        if (r.line !== 'fortinet') return Promise.resolve(r.item);
        return fgRecord(r.entry).then(function (rec) { return { line: 'fortinet', model_id: rec.model_id, model: rec.model, rec: rec }; });
      })).then(function (items) {
        var crossVendor = !!match || items.some(function (it) { return it.line !== 'fortinet'; });
        if (!crossVendor) return finishFG(fg, items, unresolved, report);
        return finishCross(fg, comp, items, unresolved, report, match);
      });
    });
  });
}

// FortiGate only: identical output to v1.0.
function finishFG(fg, items, unresolved, report) {
  var recs = items.map(function (it) { return it.rec; }).sort(bySize);
  var out = {
    source: fg.source,
    resolved: recs.map(function (r) {
      var specs = {};
      FIELDS.forEach(function (f) { if (r.specs && r.specs[f]) specs[f] = r.specs[f]; });
      var it = { line: 'fortinet', rec: r }, o = { model: r.model, model_id: r.model_id, form_factor: r.form_factor, spec_url: specUrl(r), specs: specs };
      if (r.form_factor !== 'vm') o.ports = portsText(it);
      var pc = portCheck(it); if (pc) o.port_check = pc;
      return o;
    }),
    unresolved: unresolved
  };
  if (report) {
    if (unresolved.length) out.report_skipped = 'resolve every model before building the report';
    else {
      var name = report === 'auto' ? autoName(recs.map(function (r) { return r.model_id; })) : report;
      out.report = writeReport(name, { models: recs.map(function (r) { return r.model_id; }), records: recs });
      out.report_path = path.resolve(out.report);
    }
  }
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}

function orderItems(items) {
  return items.slice().sort(function (a, b) {
    var x = LINES[a.line].order - LINES[b.line].order;
    if (x) return x;
    if (a.line === 'fortinet') return bySize(a.rec, b.rec);
    var aa = anchorOf(a), bb = anchorOf(b);
    return ((aa && aa.value) || 0) - ((bb && bb.value) || 0);
  });
}

function finishCross(fg, comp, items, unresolved, report, match) {
  var out = { version: VERSION, mode: match ? 'match' : 'compare', cross_vendor: true,
              source: { fortinet: fg.source, palo: comp ? comp[0].source : null, cisco: comp ? comp[1].source : null } };
  var matchOut = null;
  if (match && items.length === 1) {
    var src = items[0], targets;
    try { targets = parseTargets(match, src.line); } catch (e) { return fail(e.message); }
    if (src.line === 'fortinet' && targets.indexOf('fortinet') >= 0) return fail('the source is already a FortiGate; match against palo, cisco, ftd or meraki');
    if (src.line !== 'fortinet' && targets.some(function (t) { return t !== 'fortinet'; }))
      return fail('matching runs FortiGate to competitor or competitor to FortiGate, not competitor to competitor');
    var pools = { fortinet: fg.index.map(function (e) { return { line: 'fortinet', model_id: e.model_id, model: e.model, rec: e._rec }; }).filter(function (p) { return p.rec; }) };
    if (comp) {
      pools.palo = comp[0].index;
      pools.ftd = comp[1].index.filter(function (c) { return c.line === 'ftd'; });
      pools.meraki = comp[1].index.filter(function (c) { return c.line === 'meraki'; });
    }
    var sa = anchorOf(src);
    matchOut = { source_model: displayName(src), source_model_id: src.rec.model_id, port_filter: MIN_PORTS.length ? MIN_PORTS.map(function (r) { return r.count + ' x ' + r.label + '+'; }).join(', ') : null,
                 anchor: sa ? { basis: sa.basis === 'vcpu' ? 'vCPU count' : 'threat throughput', metric: sa.label || 'vCPU', value: anchorText(sa) } : null,
                 results: [], skipped: [] };
    var picked = [src];
    targets.forEach(function (t) {
      var m = matchLine(src, t, pools);
      if (m.skip) return matchOut.skipped.push({ line: t, vendor_label: LINES[t].label, reason: m.reason });
      matchOut.results.push(m.out);
      picked.push(m.best.it);
    });
    items = picked;
    out.match = matchOut;
  }
  items = orderItems(items);
  out.resolved = items.map(function (it) {
    var a = anchorOf(it);
    return { model: displayName(it), model_id: it.rec.model_id, vendor: LINES[it.line].vendor, line: it.line,
             form_factor: it.rec.form_factor, software: softwareOf(it, a && a.field ? getSpec(it, a.field) : null), spec_url: specUrl(it.rec),
             ports: isVirtual(it) ? null : portsText(it), port_check: portCheck(it) || undefined };
  });
  out.unresolved = unresolved;
  if (unresolved.length) {
    if (report) out.report_skipped = 'resolve every model before building the report';
    process.stdout.write(JSON.stringify(out, null, 1) + '\n');
    return;
  }
  if (items.length < 2) {
    out.report_skipped = 'no comparable model found';
    process.stdout.write(JSON.stringify(out, null, 1) + '\n');
    return;
  }
  var cross = buildCross(items);
  out.table_md = tableMd(items, cross);
  out.caveats = cross.caveats;
  if (report) {
    var name = report === 'auto' ? autoName(items.map(function (it) { return it.rec.model_id; })) : report;
    out.report = writeReport(name, { version: VERSION, cross: { columns: items.map(displayRecord), rows: cross.rows, caveats: cross.caveats, match: matchOut } });
    out.report_path = path.resolve(out.report);
  }
  process.stdout.write(JSON.stringify(out, null, 1) + '\n');
}

try {
  var p = main();
  if (p && p.catch) p.catch(function (e) { fail(e && e.message ? e.message : e); });
} catch (e) {
  fail(e && e.message ? e.message : e);
}
