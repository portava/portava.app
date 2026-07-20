// Portava schema-completeness audit
// Scans the LIVE codebase for every table/column/bucket the code touches,
// probes production Supabase for each, and reports what's missing.
// Run from ~/workspace/artifacts/api-server:  node schema_audit.mjs
// Dry run (no DB, just show what code expects):  node schema_audit.mjs --dry
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');
const ROOTS = (process.env.AUDIT_ROOTS ? process.env.AUDIT_ROOTS.split(':') : ['src', '../../travel-buddy-standalone/src']);
const MIG_DIR = process.env.AUDIT_MIG ?? 'src/migrations';

function walk(d, out = []) {
  let es; try { es = readdirSync(d); } catch { return out; }
  for (const e of es) {
    if (['node_modules', '__tests__', '__mocks__', '__fixtures__', '.git', 'dist'].includes(e)) continue;
    const p = join(d, e);
    let st; try { st = statSync(p); } catch { continue; }
    st.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r)).filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/\.test\.|\.spec\./.test(f));

const tables = new Map();   // name -> { cols: Map(col -> {kinds:Set,file}), files:Set }
const rpcs = new Map();
const buckets = new Map();
const SQL_KEYWORDS = new Set(['select', 'from', 'where', 'order', 'limit', 'true', 'false', 'null', 'not', 'and', 'or', 'in', 'is', 'as', 'on', 'count', 'exact', 'head']);

function tab(t, file) {
  if (!tables.has(t)) tables.set(t, { cols: new Map(), files: new Set() });
  const e = tables.get(t); e.files.add(file); return e;
}
function addCol(e, c, kind, file) {
  if (!c || c === '*') return;
  c = c.trim();
  if (!/^[a-z_][a-z0-9_]*$/.test(c)) return;
  if (SQL_KEYWORDS.has(c)) return;
  if (!e.cols.has(c)) e.cols.set(c, { kinds: new Set(), file });
  e.cols.get(c).kinds.add(kind);
}

for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\.storage\s*\.\s*from\(\s*['"`]([^'"`]+)['"`]/g)) if (!buckets.has(m[1])) buckets.set(m[1], f);
  for (const m of s.matchAll(/\.rpc\(\s*['"`]([^'"`]+)['"`]/g)) if (!rpcs.has(m[1])) rpcs.set(m[1], f);
  for (const m of s.matchAll(/table:\s*['"]([a-z_][a-z0-9_]*)['"]/g)) tab(m[1], f); // realtime channels

  const idxs = [];
  for (const fm of s.matchAll(/\.from\(\s*['"`]([a-z_][a-z0-9_]*)['"`]\s*\)/g)) {
    if (s.slice(Math.max(0, fm.index - 12), fm.index).includes('.storage')) continue;
    idxs.push([fm.index, fm[1]]);
  }
  for (let i = 0; i < idxs.length; i++) {
    const [pos, t] = idxs[i];
    const end = i + 1 < idxs.length ? idxs[i + 1][0] : Math.min(s.length, pos + 1500);
    const win = s.slice(pos, Math.min(end, pos + 1500));
    const e = tab(t, f);
    for (const sm of win.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)) {
      let sel = sm[2], prev;
      do { prev = sel; sel = sel.replace(/[a-zA-Z_][\w]*(?:![\w]+)?\s*\([^()]*\)/g, ''); } while (sel !== prev);
      for (let c of sel.split(',')) {
        c = c.trim(); if (!c) continue;
        if (c.includes(':')) c = c.split(':').pop().trim();
        c = c.replace(/->.*$/, '').replace(/::.*$/, '').trim();
        addCol(e, c, 'read', f);
      }
    }
    for (const cm of win.matchAll(/\.(?:eq|neq|gt|gte|lt|lte|like|ilike|is|in|contains|containedBy|overlaps|order|textSearch|not)\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g)) addCol(e, cm[1], 'filter', f);
    for (const om of win.matchAll(/\.(?:insert|update|upsert)\(\s*\[?\s*\{([\s\S]{0,700}?)\}/g)) {
      const body = om[1];
      const first = body.match(/^\s*["']?([a-z_][a-z0-9_]*)["']?\s*:/);
      if (first) addCol(e, first[1], 'write', f);
      for (const km of body.matchAll(/,\s*\n?\s*["']?([a-z_][a-z0-9_]*)["']?\s*:/g)) addCol(e, km[1], 'write', f);
    }
    for (const oc of win.matchAll(/onConflict:\s*['"]([^'"]+)['"]/g)) oc[1].split(',').forEach((c) => addCol(e, c, 'filter', f));
  }
}

// ── migrations: declared schema (for skipped-migration detection) ────────────
const declared = new Map(); // table -> Map(col -> migfile)
try {
  for (const mf of readdirSync(MIG_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(MIG_DIR, mf), 'utf8');
    for (const cm of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][\w]*)\s*\(([\s\S]*?)\n\)/gi)) {
      const t = cm[1].toLowerCase();
      if (!declared.has(t)) declared.set(t, new Map());
      for (const line of cm[2].split('\n')) {
        const lm = line.match(/^\s*([a-z_][a-z0-9_]*)\s+\w/);
        if (lm && !/^(primary|foreign|unique|check|constraint|references)$/i.test(lm[1])) {
          if (!declared.get(t).has(lm[1])) declared.get(t).set(lm[1], mf);
        }
      }
    }
    for (const am of sql.matchAll(/ALTER TABLE(?:\s+IF EXISTS)?\s+([a-z_][\w]*)([\s\S]*?);/gi)) {
      const t = am[1].toLowerCase();
      for (const ac of am[2].matchAll(/ADD COLUMN(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) {
        if (!declared.has(t)) declared.set(t, new Map());
        if (!declared.get(t).has(ac[1])) declared.get(t).set(ac[1], mf);
      }
    }
  }
} catch (e) { console.log('(migrations dir not readable:', e.message, ')'); }

console.log(`Scanned ${files.length} source files → ${tables.size} tables, ${rpcs.size} RPCs, ${buckets.size} buckets referenced.`);

if (DRY) {
  for (const [t, e] of [...tables].sort()) console.log(`  ${t}: ${e.cols.size} cols (${[...e.cols.keys()].slice(0, 12).join(', ')}${e.cols.size > 12 ? ', …' : ''})`);
  console.log('RPCs:', [...rpcs.keys()].join(', ') || '(none)');
  console.log('Buckets:', [...buckets.keys()].join(', ') || '(none)');
  process.exit(0);
}

// ── probe production ─────────────────────────────────────────────────────────
const { createClient } = await import('@supabase/supabase-js');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.log('ENV MISSING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const sc = createClient(url, key, { auth: { persistSession: false } });

const missingTables = [], colIssues = [], undeclaredButPresent = [], skippedMigrations = [];

for (const [t, e] of [...tables].sort()) {
  const { error: te } = await sc.from(t).select('*').limit(1);
  if (te && (te.code === 'PGRST205' || te.code === '42P01' || /schema cache|does not exist/i.test(te.message ?? ''))) {
    missingTables.push({ t, file: [...e.files][0], declaredIn: declared.has(t) ? [...declared.get(t).values()][0] : null });
    continue;
  }
  let remaining = [...e.cols.keys()];
  const missing = [];
  let guard = 0;
  while (remaining.length && guard++ < 30) {
    const { error } = await sc.from(t).select(remaining.join(',')).limit(1);
    if (!error) break;
    const msg = error.message ?? '';
    let mm = msg.match(/column\s+[\w."]*?([a-z0-9_]+)"?\s+does not exist/i) || msg.match(/'([a-z0-9_]+)'\s+column/i) || msg.match(/find a relationship.*?'([a-z0-9_]+)'/i);
    const bad = mm && remaining.includes(mm[1]) ? mm[1] : null;
    if (!bad) { missing.push(`(unparsed: ${error.code ?? ''} ${msg.slice(0, 110)})`); break; }
    missing.push(bad);
    remaining = remaining.filter((c) => c !== bad);
  }
  if (missing.length) {
    colIssues.push({ t, missing: missing.map((c) => {
      const info = e.cols.get(c);
      const dec = declared.get(t)?.get(c);
      if (dec) skippedMigrations.push(`${t}.${c} — declared in ${dec}`);
      return `${c}${info ? ` [${[...info.kinds].join('/')}] (${info.file})` : ''}${dec ? `  ⚠ declared in ${dec}` : ''}`;
    }) });
  }
}
for (const [t, cols] of declared) {
  if (!tables.has(t)) continue; // only care about tables code actually uses
}

const bucketMissing = [];
for (const [b, f] of buckets) {
  const { data, error } = await sc.storage.getBucket(b);
  if (error || !data) bucketMissing.push(`${b} (${f})`);
}

console.log('\n══ RESULTS ══');
console.log(`\n— Missing TABLES (code references, prod lacks): ${missingTables.length}`);
for (const m of missingTables) console.log(`  ✗ ${m.t}  (used in ${m.file})${m.declaredIn ? `  ⚠ declared in ${m.declaredIn} — migration skipped?` : '  (never declared in migrations — dashboard drift?)'}`);
console.log(`\n— Tables with missing COLUMNS: ${colIssues.length}`);
for (const c of colIssues) { console.log(`  ✗ ${c.t}:`); for (const col of c.missing) console.log(`      ${col}`); }
console.log(`\n— Missing storage BUCKETS: ${bucketMissing.length}`);
for (const b of bucketMissing) console.log(`  ✗ ${b}`);
console.log(`\n— RPC functions referenced in code (verify these exist under Supabase → Database → Functions; not auto-called for safety):`);
for (const [r, f] of rpcs) console.log(`  ? ${r}  (${f})`);
console.log('\nNote: [write]-only columns come from insert/update object keys and can include false positives (nested JSON keys). [read]/[filter] findings are high-confidence.');
