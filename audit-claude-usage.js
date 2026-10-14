#!/usr/bin/env node
// Audit Claude Code usage from local session transcripts.
// Usage (PowerShell):
//   node audit-claude-usage.js --projects "$env:USERPROFILE\.claude\projects" --repo C:\DuckhornRepo --n 30 > usage-audit.md
// Prints a compact Markdown summary (a few KB) meant to be pasted back to Claude.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => {
  if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const HOME = os.homedir();
const PROJECTS = args.projects || path.join(HOME, '.claude', 'projects');
const REPO = args.repo || 'C:\\DuckhornRepo';
const N = parseInt(args.n || '30', 10);
const clip = (s, n = 140) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------- 1. Existing config: hooks, statusline, skills, commands ----------
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function listDir(p) { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } }

const out = [];
out.push(`# Claude Code usage audit\nprojects=${PROJECTS} repo=${REPO} generated=${new Date().toISOString()}\n`);
out.push('## Existing config');
const settingsFiles = [
  path.join(HOME, '.claude', 'settings.json'),
  path.join(HOME, '.claude', 'settings.local.json'),
  path.join(REPO, '.claude', 'settings.json'),
  path.join(REPO, '.claude', 'settings.local.json'),
];
for (const f of settingsFiles) {
  const j = readJson(f);
  if (!j) { out.push(`- ${f}: (missing/unreadable)`); continue; }
  out.push(`- ${f}: statusLine=${j.statusLine ? clip(JSON.stringify(j.statusLine), 120) : 'none'}`);
  for (const [evt, groups] of Object.entries(j.hooks || {})) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) {
        out.push(`  - ${evt} matcher=${g.matcher || '*'} type=${h.type} ${clip(h.command || h.prompt, 110)}`);
      }
    }
  }
}
for (const base of [path.join(HOME, '.claude'), path.join(REPO, '.claude')]) {
  for (const d of listDir(path.join(base, 'skills')).filter(d => d.isDirectory())) {
    let desc = '';
    try {
      const md = fs.readFileSync(path.join(base, 'skills', d.name, 'SKILL.md'), 'utf8');
      desc = (md.match(/^description:\s*(.+)$/m) || [])[1] || '';
    } catch {}
    out.push(`- skill ${d.name} (${base}): ${clip(desc, 120)}`);
  }
  const cmds = listDir(path.join(base, 'commands')).filter(d => d.name.endsWith('.md')).map(d => '/' + d.name.slice(0, -3));
  if (cmds.length) out.push(`- commands (${base}): ${cmds.join(', ')}`);
}

// ---------- 2. Collect the N most recent transcripts ----------
function walk(dir, acc) {
  for (const e of listDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.jsonl')) acc.push({ p, mtime: fs.statSync(p).mtimeMs });
  }
  return acc;
}
const files = walk(PROJECTS, []).sort((a, b) => b.mtime - a.mtime).slice(0, N);

// ---------- 3. Parse ----------
const CHECK_RX = {
  tokens: /\btokens?\b|token usage/i,
  context: /context window|\/context\b|context (left|usage|remaining)|how much context/i,
  cost: /\/cost\b|\bcost\b|spend|usage limit|rate limit/i,
  cache: /cache (hit|read|miss)|prompt cach/i,
  compaction: /compact|\/compact\b|summariz(e|ed) (the )?conversation/i,
  qdrant_mcp: /qdrant|bc14-search|\bmcp\b|\/mcp\b|collection|6333|vector (db|index)/i,
};
const CAT_RX = [ // prompt intent categories for ritual detection
  ['git', /\bgit (status|diff|log|pull|stash|branch|checkout)\b/i],
  ['bc14-check', /constraint|try-?catch|continue statement|maxstrlen|copystr|strsubstno|explicit length|option param/i],
  ['reindex', /re-?index|re-?embed|rebuild (the )?index|upsert|qdrant/i],
  ['export', /export|DuckhornRepoTxt|\.txt objects?/i],
  ['al-edit', /\b(codeunit|table|page|report|xmlport|query)\b.*\b(fix|change|add|modify|update|refactor)|\b(fix|change|add|modify|update|refactor)\b.*\b(codeunit|table|page|report|xmlport|procedure|trigger)\b/i],
  ['search', /search|find|where is|which objects?|semantic/i],
  ['review', /review|audit|check (my|the)|verify/i],
  ['test', /\btest|compile|build\b/i],
  ['meta-check', /token|context|\/cost|cache|compact/i],
];
const catOf = t => (CAT_RX.find(([, rx]) => rx.test(t)) || ['other'])[0];
const toolSig = (name, input) => {
  if (name === 'Bash' || name === 'PowerShell') {
    const c = String(input.command || '').trim();
    const m = c.match(/^(git \w+|curl(\.exe)? \S*|npm \w+|node \S+|pwsh|powershell|python \S+|Get-\w+|Select-String|Invoke-\w+|\S+)/i);
    return `${name}:${m ? m[0].slice(0, 50) : c.slice(0, 40)}`;
  }
  if (/^(Edit|Write|MultiEdit|Read)$/.test(name)) return `${name}:${path.extname(input.file_path || '').toLowerCase() || '?'}`;
  return name; // MCP tools, Skill, Grep, etc.
};

const prompts = [];       // {text, date, session, cat}
const slash = {};         // /command -> count
const checks = {};        // kind -> [{date, text}]
const toolCounts = {};
const turnSeqs = [];      // [{cat, tools:[sig]}]
let compactions = 0, usage = { in: 0, cacheRead: 0, cacheWrite: 0, out: 0, msgs: 0 };
const sessionMeta = [];

for (const { p } of files) {
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let curTurn = null, first = null, last = null, nPrompts = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ts = e.timestamp ? e.timestamp.slice(0, 10) : null;
    if (ts) { first = first || ts; last = ts; }
    if (e.isCompactSummary || e.subtype === 'compact_boundary') compactions++;
    const msg = e.message;
    if (!msg) continue;
    if (e.type === 'assistant' && msg.usage) {
      const u = msg.usage; usage.msgs++;
      usage.in += u.input_tokens || 0; usage.out += u.output_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0;
    }
    if (e.type === 'assistant' && Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (c.type !== 'tool_use') continue;
        const sig = toolSig(c.name, c.input || {});
        toolCounts[sig] = (toolCounts[sig] || 0) + 1;
        if (curTurn) curTurn.tools.push(sig);
        const cmd = String((c.input || {}).command || '');
        for (const [k, rx] of Object.entries(CHECK_RX)) {
          if (k !== 'tokens' && k !== 'cost' && rx.test(cmd)) (checks[k + '(cmd)'] = checks[k + '(cmd)'] || []).push({ date: ts, text: clip(cmd, 90) });
        }
      }
    }
    if (e.type === 'user' && !e.isMeta && !e.isCompactSummary) {
      let text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
      if (!text || (Array.isArray(msg.content) && msg.content.some(c => c.type === 'tool_result'))) continue;
      const cm = text.match(/<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/);
      if (cm) {
        const name = cm[1].startsWith('/') ? cm[1] : '/' + cm[1];
        slash[name] = (slash[name] || 0) + 1;
        const argsM = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
        text = `${name} ${argsM ? argsM[1] : ''}`.trim();
      }
      if (/^<(local-command-stdout|local-command-caveat|system-reminder)/.test(text.trim())) continue;
      nPrompts++;
      const cat = catOf(text);
      prompts.push({ text, date: ts, session: path.basename(p, '.jsonl').slice(0, 8), cat });
      for (const [k, rx] of Object.entries(CHECK_RX)) if (rx.test(text)) (checks[k] = checks[k] || []).push({ date: ts, text: clip(text, 90) });
      curTurn = { cat, tools: [] }; turnSeqs.push(curTurn);
    }
  }
  sessionMeta.push(`${path.basename(path.dirname(p))}/${path.basename(p, '.jsonl').slice(0, 8)} ${first}..${last} prompts=${nPrompts}`);
}

// ---------- 4. Cluster prompts (greedy Jaccard on normalized word sets) ----------
const STOP = new Set('the a an and or to of in on for with is are be it this that my me i you can please let lets let\'s do does from at as by we our your all any into then so if not no yes ok now also just use using run'.split(' '));
const norm = t => new Set(t.toLowerCase()
  .replace(/[a-z]:\\[^\s"']+|\/[\w.\/-]{6,}/gi, ' PATH ')
  .replace(/\b\d+\b/g, ' N ')
  .replace(/[^a-z0-9_ ]+/g, ' ')
  .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)).slice(0, 40));
const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i || 1); };
const clusters = [];
for (const pr of prompts) {
  const s = norm(pr.text);
  if (s.size < 2) continue;
  let best = null, bs = 0;
  for (const c of clusters) { const j = jac(s, c.sig); if (j > bs) { bs = j; best = c; } }
  if (best && bs >= 0.45) best.items.push(pr);
  else clusters.push({ sig: s, items: [pr] });
}
const repeated = clusters.filter(c => c.items.length >= 2).sort((a, b) => b.items.length - a.items.length).slice(0, 15);

// ---------- 5. Rituals ----------
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const promptBigrams = {};
for (let i = 1; i < prompts.length; i++) {
  if (prompts[i].session === prompts[i - 1].session && prompts[i].cat !== 'other' && prompts[i - 1].cat !== 'other')
    bump(promptBigrams, `${prompts[i - 1].cat} -> ${prompts[i].cat}`);
}
const firstTools = {}, afterAlEdit = {}, lastTools = {};
const isAlEdit = s => /^(Edit|Write|MultiEdit):\.(al|txt)$/.test(s);
for (const t of turnSeqs) {
  if (!t.tools.length) continue;
  bump(firstTools, `${t.cat}: ${t.tools.slice(0, 2).join(' > ')}`);
  bump(lastTools, `${t.cat}: ${t.tools.slice(-2).join(' > ')}`);
  const k = t.tools.findIndex(isAlEdit);
  if (k >= 0) for (const s of new Set(t.tools.slice(k + 1).filter(x => !isAlEdit(x)))) bump(afterAlEdit, s);
}
const top = (o, n = 12, min = 2) => Object.entries(o).filter(([, v]) => v >= min).sort((a, b) => b[1] - a[1]).slice(0, n);

// ---------- 6. Report ----------
out.push(`\n## Sessions (${files.length})`); sessionMeta.forEach(s => out.push('- ' + s));
const dates = prompts.map(p => p.date).filter(Boolean).sort();
const spanDays = dates.length ? Math.max(1, (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 864e5 + 1) : 1;
out.push(`\nprompts=${prompts.length} spanDays=${spanDays.toFixed(0)} compactions=${compactions}`);
out.push(`usage: msgs=${usage.msgs} input=${usage.in} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} output=${usage.out}` +
  ` cacheHit=${((usage.cacheRead / (usage.in + usage.cacheRead + usage.cacheWrite || 1)) * 100).toFixed(1)}%`);
out.push('\n## Repeated prompt clusters');
for (const c of repeated) {
  const ds = [...new Set(c.items.map(i => i.date))].sort();
  out.push(`- x${c.items.length} [${c.items[0].cat}] sessions=${new Set(c.items.map(i => i.session)).size} dates=${ds[0]}..${ds[ds.length - 1]} e.g. "${clip(c.items[0].text)}"` +
    (c.items[1] ? ` | "${clip(c.items[1].text, 80)}"` : ''));
}
out.push('\n## Manual checks');
for (const [k, v] of Object.entries(checks)) {
  const ds = [...new Set(v.map(x => x.date))].sort();
  out.push(`- ${k}: x${v.length} on ${ds.length} days (${ds.slice(0, 6).join(', ')}${ds.length > 6 ? ', ...' : ''}) e.g. "${v[0].text}"`);
}
out.push('\n## Slash commands'); out.push(top(slash, 20, 1).map(([k, v]) => `${k} x${v}`).join(', ') || '(none)');
out.push('\n## Prompt category transitions (before/after rituals)'); top(promptBigrams).forEach(([k, v]) => out.push(`- ${k}: ${v}`));
out.push('\n## First two tool calls per turn, by category'); top(firstTools).forEach(([k, v]) => out.push(`- ${k}: ${v}`));
out.push('\n## Last two tool calls per turn, by category'); top(lastTools).forEach(([k, v]) => out.push(`- ${k}: ${v}`));
out.push('\n## Tools used after an AL/.txt edit, same turn'); top(afterAlEdit).forEach(([k, v]) => out.push(`- ${k}: ${v}`));
out.push('\n## Top tool signatures'); out.push(top(toolCounts, 25).map(([k, v]) => `${k} x${v}`).join(', '));
process.stdout.write(out.join('\n') + '\n');
