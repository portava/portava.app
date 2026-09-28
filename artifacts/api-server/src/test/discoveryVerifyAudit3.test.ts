/**
 * discoveryVerifyAudit3.test.ts — census-discovery §74 (independent
 * verification lane P32): runnable attacks on the two C verdicts §73 (lane P27)
 * gave DV-20 and B01. Same form as §59's and §66's suites: a DEFECT or LIMIT is
 * pinned so that a fix turns it red and forces the census to be re-read, and a
 * CONTROL shows the probe can see the other outcome. This file changes no code.
 *
 * Cases marked (harness) run only with LOCAL_DB_URL set (scripts/local-db/up.sh)
 * and skip otherwise, as every src/test/db suite does.
 *
 *   V1  CONTROL (DV-20, confirms §73): every spelling of Ǿ (precomposed, Ø plus
 *       a combining acute, O plus a combining solidus and an acute) is one slug;
 *       every letter of Latin Extended Additional slugs as its undecorated
 *       letter; every Latin letter slugs as its other case does.
 *   V2  DEFECT, pinned (DV-20): a Latin letter carrying a combining mark that
 *       Unicode classes as a Diacritic, from the three combining blocks made
 *       for Latin OUTSIDE U+0300–U+036F, is split by the slug. The ALA-LC
 *       romanisation "I︠A︡roslavl" (ligature half marks U+FE20/U+FE21) and
 *       "Iaroslavl" become two canonical Trails for one theme.
 *   V2c CONTROL: the same tie written as U+0361 (inside the stripped range) is
 *       one slug, and the canonicaliser refuses the second as a duplicate.
 *   V3  DEFECT, pinned (DV-20): GET /v1/discovery/trails compares the search
 *       term and the destination as STRINGS. The term is not canonicalised
 *       ("Đà Nẵng" becomes the pattern `---n-ng`), and the destination filter
 *       is raw equality, so two Trails §61 treats as one destination are
 *       listed apart and neither is found by the display spelling.
 *   V3c CONTROL: the ASCII spelling finds the Trail, and the destination key
 *       the creation checks use does equate the two destinations.
 *   B1  CONTROL (B01, confirms §73): NFC and NFD input key alike for every
 *       Latin letter; Latin Extended Additional keys as its base letter.
 *   B2  DEFECT, pinned (B01): the same Diacritic marks change the stored key
 *       and the query key alike: "I︠A︡roslavl" keys `i a roslavl`, and the
 *       Cities reader's pattern for "Iaroslavl" can never match it.
 *   B2c CONTROL: U+0361 folds; the reader's pattern matches that row.
 *   Q4  RECORD: the readings §73 states so they can be overruled (ƻ ɿ ʢ ʨ
 *       deleted; ß æ œ untouched pending owner question 4) are in its text and
 *       in the code's behaviour; the reading goes red if either changes.
 *   H1  (harness) CONTROL (B01): input_normalize_city_key equals searchKey on
 *       every ASSIGNED code point in three positions — not only the 1453
 *       letters K5 covers — and the SQL slug differs from canonicalTrailSlug
 *       on exactly 37 code points, of which only U+A7F1 (§73.7 #2) is a letter.
 *   H2  (harness) DEFECT, pinned (DV-20): through proposeTrail and
 *       trail_propose on the harness, "I︠A︡roslavl …" and "Iaroslavl …" are
 *       both admitted; the U+0361 control is refused.
 *   H3  (harness) DEFECT, pinned (DV-20): through listTrails over the real
 *       tables, the display spelling finds neither Trail and each destination
 *       spelling lists only its own; the ASCII search finds both (control).
 *   H4  (harness) DEFECT, pinned (B01): a registry row named "I︠A︡roslavl"
 *       stores `i a roslavl`, and readCanonicalCitySuggestions("Iaroslavl")
 *       does not reach it; the U+0361 row is reached (control).
 *   H5  (harness) LIMIT, pinned (recorded, not graded): 3441 does not
 *       recompute stored `trails.slug`. A Trail stored under the pre-§73 slug
 *       is outside a re-spelling's comparison set, and both are admitted; the
 *       same Trail stored under the current slug is refused (control).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { searchKey } from "../lib/canonicalLocations.js";
import { readCanonicalCitySuggestions } from "../lib/discoverySearchCanonical.js";
import { canonicalTrailSlug, canonicaliseTrailProposal } from "../lib/discoveryTrailObject.js";
import { trailDestinationKey } from "../lib/discoveryTrailFold.js";
import { listTrails, proposeTrail } from "../services/trails/TrailService.js";
import { HAVE_DB, LOCAL_DB_URL, exec, scalar } from "./db/localDb.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CENSUS = resolve(HERE, "../../../../docs/architecture/census-discovery.md");

/** The combining blocks Unicode made for Latin beyond U+0300–U+036F. */
const LATIN_MARK_BLOCKS: ReadonlyArray<readonly [number, number, string]> = [
  [0x1ab0, 0x1aff, "Combining Diacritical Marks Extended"],
  [0x1dc0, 0x1dff, "Combining Diacritical Marks Supplement"],
  [0xfe20, 0xfe2f, "Combining Half Marks"],
];

/** Every mark in those blocks that Unicode's own Diacritic property names a diacritic. */
function outOfRangeDiacritics(): string[] {
  const out: string[] = [];
  for (const [lo, hi] of LATIN_MARK_BLOCKS) {
    for (let cp = lo; cp <= hi; cp++) {
      const ch = String.fromCodePoint(cp);
      if (/^\p{Mn}$/u.test(ch) && /^\p{Diacritic}$/u.test(ch)) out.push(ch);
    }
  }
  return out;
}

const hex = (s: string) => [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");

/** Every Latin-script letter this runtime knows (Unicode 17 on Node 22: 1453). */
function latinLetters(): string[] {
  const out: string[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp === 0xd800) cp = 0xe000;
    const ch = String.fromCodePoint(cp);
    if (/^(?=\p{Script=Latin})\p{L}$/u.test(ch)) out.push(ch);
  }
  return out;
}

const ALA_LC = "I\uFE20A\uFE21roslavl"; // ALA-LC's tie, written with the half marks MARC data carries
const TIE_0361 = "I\u0361Aroslavl";     // the same tie as one double diacritic inside U+0300–U+036F
const PLAIN = "Iaroslavl";

/** PostgREST `ilike`, in memory: `%` is any run, `_` one character, case-insensitive. */
function ilike(value: string, pattern: string): boolean {
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${re}$`, "is").test(value);
}

/** A supabase-shaped chain that records the filters listTrails sends and answers `[]`. */
function recordingClient() {
  const calls: Array<{ op: string; col: string; val: string }> = [];
  const chain: any = {
    select: () => chain, neq: () => chain, order: () => chain, limit: () => chain,
    eq: (col: string, val: string) => { calls.push({ op: "eq", col, val }); return chain; },
    ilike: (col: string, val: string) => { calls.push({ op: "ilike", col, val }); return chain; },
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  return { sc: { from: () => chain }, calls };
}

/** A stored Trail as proposeTrail writes it: slug from canonicalTrailSlug, destination trimmed and lowercased. */
const stored = (title: string, destination: string) => ({ title, slug: canonicalTrailSlug(title)!, destination: destination.trim().toLowerCase() });

/** Would listTrails' filters, as recorded, return this stored row? */
async function listed(params: { destination?: string; query?: string }, row: { slug: string; destination: string }): Promise<boolean> {
  const { sc, calls } = recordingClient();
  const r = await listTrails(sc, params);
  assert.equal(r.refusal, null);
  return calls.every((c) => (c.op === "eq" ? (row as any)[c.col] === c.val : ilike((row as any)[c.col], c.val)));
}

// ── DV-20 ────────────────────────────────────────────────────────────────────

describe("§74 DV-20 — `02` §19 'Trails are canonical objects, not strings'", () => {
  it("V1. CONTROL (confirms §73): every spelling of Ǿ is one slug; U+1E00–U+1EFF slug as their base; every Latin letter slugs as its other case", () => {
    const forms = ["\u01FEresund cycling", "\u00D8\u0301resund cycling", "O\u0338\u0301resund cycling", "\u01FEresund cycling".normalize("NFD"), "Øresund cycling"];
    assert.deepEqual(new Set(forms.map((f) => canonicalTrailSlug(f))), new Set(["oresund-cycling"]));
    const block: string[] = [];
    for (let cp = 0x1e00; cp <= 0x1eff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/\p{L}/u.test(ch)) continue;
      const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
      if (canonicalTrailSlug(`x${ch}resund`) !== canonicalTrailSlug(`x${base}resund`)) block.push(ch);
    }
    assert.deepEqual(block, []);
    const cases = latinLetters().flatMap((ch) => {
      const other = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      return [...other].length === 1 && other !== ch && /\p{Script=Latin}/u.test(other) ? [[ch, other] as const] : [];
    });
    assert.ok(cases.length > 600, `${cases.length} case pairs`);
    const split = cases.filter(([a, b]) => canonicalTrailSlug(`x${a}resund`) !== canonicalTrailSlug(`x${b}resund`)).map(([a, b]) => `${a}/${b}`);
    assert.deepEqual(split, []);
  });

  it("V2. DEFECT, pinned (DV-20): a Latin letter with a Diacritic mark outside U+0300–U+036F is split; 'I︠A︡roslavl' and 'Iaroslavl' are two canonical Trails", () => {
    const marks = outOfRangeDiacritics();
    assert.equal(marks.length, 91, `${marks.length}: ${hex(marks.join(""))}`);
    const split = marks.filter((m) => canonicalTrailSlug(`zu${m}rich food`) !== canonicalTrailSlug("zurich food"));
    assert.equal(split.length, marks.length, "every one of them splits the word it sits in");
    assert.equal(canonicalTrailSlug(`${ALA_LC} street food`), "i-a-roslavl-street-food");
    assert.equal(canonicalTrailSlug(`${PLAIN} street food`), "iaroslavl-street-food");
    const first = { id: "t1", slug: canonicalTrailSlug(`${ALA_LC} street food`)!, title: `${ALA_LC} street food`, destination: null };
    const second = canonicaliseTrailProposal({ title: `${PLAIN} street food`, destination: null }, [first]);
    assert.equal(second.ok, true, "the second spelling is ADMITTED: two Trails for one theme");
    assert.deepEqual(second.refusals, []);
    // Macron-acute (U+1DC4), a tone mark with no precomposed letter: the sequence is the only way to write it.
    assert.notEqual(canonicalTrailSlug("Zu\u1DC4rich coffee"), canonicalTrailSlug("Zurich coffee"));
  });

  it("V2c. CONTROL: the same tie as U+0361 is one slug, and the second spelling is refused as a duplicate", () => {
    assert.equal(canonicalTrailSlug(`${TIE_0361} street food`), "iaroslavl-street-food");
    const first = { id: "t1", slug: canonicalTrailSlug(`${TIE_0361} street food`)!, title: `${TIE_0361} street food`, destination: null };
    const second = canonicaliseTrailProposal({ title: `${PLAIN} street food`, destination: null }, [first]);
    assert.equal(second.ok, false);
    assert.equal(second.refusals[0]?.check, "duplicate_title_similarity");
  });

  it("V3. DEFECT, pinned (DV-20): listTrails compares the term and the destination as strings", async () => {
    const a = stored("Da Nang Coffee Crawl", "Da Nang");        // `02` §1's own example Trail
    const b = stored("Đà Nẵng Street Food", "Đà Nẵng");
    // The term: lowercased and every non-[a-z0-9-] replaced, never canonicalised.
    const { sc, calls } = recordingClient();
    await listTrails(sc, { query: "Đà Nẵng" });
    assert.deepEqual(calls, [{ op: "ilike", col: "slug", val: "%---n-ng%" }]);
    assert.equal(await listed({ query: "Đà Nẵng" }, a), false, "the display spelling does not find the Da Nang Trail");
    assert.equal(await listed({ query: "Đà Nẵng" }, b), false, "…nor the Trail whose own title it is");
    assert.equal(await listed({ query: "Café" }, stored("Café culture", "Paris")), false, "an ordinary acute breaks it too");
    // The destination: raw equality, although creation treats the two as one destination.
    assert.equal(await listed({ destination: "Đà Nẵng" }, a), false);
    assert.equal(await listed({ destination: "Da Nang" }, b), false);
  });

  it("V3c. CONTROL: the ASCII spelling finds both, each destination spelling finds its own, and the creation key equates them", async () => {
    const a = stored("Da Nang Coffee Crawl", "Da Nang");
    const b = stored("Đà Nẵng Street Food", "Đà Nẵng");
    assert.equal(await listed({ query: "da nang" }, a), true);
    assert.equal(await listed({ query: "da nang" }, b), true);
    assert.equal(await listed({ destination: "Da Nang" }, a), true);
    assert.equal(await listed({ destination: "Đà Nẵng" }, b), true);
    assert.equal(trailDestinationKey(a.destination), trailDestinationKey(b.destination), "§61: one destination whatever its spelling");
    assert.equal(canonicalTrailSlug("Đà Nẵng"), "da-nang", "the canonical form the term is never put through");
  });
});

// ── B01 ──────────────────────────────────────────────────────────────────────

describe("§74 B01 — G57 'Diacritic-insensitive matching while preserving display spelling', the stored side", () => {
  it("B1. CONTROL (confirms §73): NFC and NFD input key alike for every Latin letter; U+1E00–U+1EFF key as their base letter", () => {
    const letters = latinLetters();
    assert.equal(letters.length, 1453);
    const nfd = letters.filter((ch) => searchKey(`x${ch}resund`) !== searchKey(`x${ch}resund`.normalize("NFD")));
    assert.deepEqual(nfd, []);
    const block: string[] = [];
    for (let cp = 0x1e00; cp <= 0x1eff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/\p{L}/u.test(ch)) continue;
      const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
      if (searchKey(`x${ch}resund`) !== searchKey(`x${base}resund`)) block.push(ch);
    }
    assert.deepEqual(block, []);
    for (const f of ["\u01FEresund", "\u00D8\u0301resund", "O\u0338\u0301resund", "\u01FEresund".normalize("NFD")]) assert.equal(searchKey(f), "oresund", hex(f));
  });

  it("B2. DEFECT, pinned (B01): a Diacritic mark outside U+0300–U+036F changes the key; the Cities reader cannot reach 'I︠A︡roslavl' from 'Iaroslavl'", async () => {
    const marks = outOfRangeDiacritics();
    const changed = marks.filter((m) => searchKey(`zu${m}rich`) !== "zurich");
    assert.equal(changed.length, marks.length, "every one of the 91 changes the key of the word it sits in");
    assert.equal(searchKey(ALA_LC), "i a roslavl");
    assert.equal(searchKey("Zu\u1DC4rich"), "zu rich");
    // The reader's own patterns for the plain spelling, against the stored key of the marked one.
    const patterns: string[] = [];
    const sc = { from: () => { const c: any = { select: () => c, ilike: (_: string, p: string) => { patterns.push(p); return c; }, limit: () => Promise.resolve({ data: [], error: null }) }; return c; } };
    await readCanonicalCitySuggestions(sc, PLAIN, 4);
    assert.deepEqual(patterns, ["iaroslavl%", "%iaroslavl%"]);
    assert.equal(patterns.some((p) => ilike(searchKey(ALA_LC), p)), false, "the row is unreachable by its undecorated spelling");
  });

  it("B2c. CONTROL: U+0361 (inside the stripped range) folds, and the reader's pattern matches that row", () => {
    assert.equal(searchKey(TIE_0361), "iaroslavl");
    assert.equal(ilike(searchKey(TIE_0361), "%iaroslavl%"), true);
    assert.equal(searchKey("Zu\u0301rich"), "zurich");
  });

  it("Q4. RECORD: §73's overrulable readings are stated in its text and hold in the code", () => {
    const text = readFileSync(CENSUS, "utf8");
    const s73 = text.slice(text.indexOf("## §73 "), text.indexOf("## §74 ")); // §73 alone
    const reads = (t: string) => ({
      fourStated: /ƻ TWO, ɿ REVERSED R, ʢ REVERSED GLOTTAL STOP, ʨ TC DIGRAPH/.test(t) && /stated so it can be overruled/.test(t),
      q4Stated: /\*\*Q4 stays open \(73\.8\)\.\*\* ß, æ and œ are still deleted/.test(t) && /If the owner answers that G57 covers them, B01 returns to W/.test(t),
    });
    assert.deepEqual(reads(s73), { fourStated: true, q4Stated: true });
    for (const ch of "ƻɿʢʨ") assert.equal(searchKey(`x${ch}x`), "x x", `${ch} is deleted, as stated`);
    assert.deepEqual(["Straße", "Æbeltoft", "Œuf"].map(searchKey), ["stra e", "beltoft", "uf"], "ß æ œ deleted, as stated");
    // Control: the reading sees the statement removed.
    assert.equal(reads(s73.replaceAll("stated so it can be overruled", "decided")).fourStated, false);
  });
});

// ── The harness (controlled evidence: PostgreSQL 16, never production) ─────────

const TAG = `p32${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const createdCanonical: string[] = [];

after(() => {
  if (!HAVE_DB) return;
  exec(`DELETE FROM public.trails WHERE slug LIKE '%${TAG}%' OR destination LIKE '%${TAG}%';`);
  if (createdCanonical.length > 0) exec(`DELETE FROM public.canonical_locations WHERE id IN (${createdCanonical.map((i) => `'${i}'`).join(", ")});`);
});

/** psql with room for a large answer (localDb's spawnSync keeps Node's 1 MB default). */
function bigQuery(sql: string): string[] {
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", LOCAL_DB_URL], { input: sql, encoding: "utf8", timeout: 300_000, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql exited ${r.status}: ${r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0);
}

describe("§74 on the harness (PostgreSQL 16, 3415 + 3440 + 3441 replayed)", { skip: !HAVE_DB }, () => {
  it("H1. CONTROL (B01): SQL key = searchKey on every assigned code point; the SQL slug differs on 37 code points, one a letter (U+A7F1)", { timeout: 600_000 }, () => {
    const ranges: Array<[number, number]> = [];
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp === 0xd800) cp = 0xe000;
      if (!/\P{Cn}/u.test(String.fromCodePoint(cp))) continue;
      const last = ranges[ranges.length - 1];
      if (last && last[1] === cp - 1) last[1] = cp; else ranges.push([cp, cp]);
    }
    const lines = bigQuery(`SELECT cp, public.input_normalize_city_key(chr(cp)), public.input_normalize_city_key('x' || chr(cp) || 'resund'),
                                   coalesce(public.trail_canonical_slug('x' || chr(cp) || 'resund'), '<null>')
                              FROM jsonb_array_elements('${JSON.stringify(ranges)}'::jsonb) r,
                                   generate_series((r ->> 0)::int, (r ->> 1)::int) cp;`);
    const keyDiff: string[] = [], slugDiff: string[] = [];
    for (const l of lines) {
      const [cps, alone, inWord, slug] = l.split("\t");
      const ch = String.fromCodePoint(Number(cps));
      if (searchKey(ch) !== (alone ?? "") || searchKey(`x${ch}resund`) !== (inWord ?? "")) keyDiff.push(hex(ch));
      if ((canonicalTrailSlug(`x${ch}resund`) ?? "<null>") !== slug) slugDiff.push(ch);
    }
    assert.equal(lines.length, 297_333, "every assigned code point in Unicode 17, U+0000 and the surrogates excluded");
    assert.deepEqual(keyDiff, [], "the stored fold and the query fold agree everywhere");
    assert.equal(slugDiff.length, 37, hex(slugDiff.join("")));
    assert.deepEqual(slugDiff.filter((c) => /\p{L}/u.test(c)), ["\uA7F1"], "only U+A7F1 (§73.7 #2) is a letter; U+1CCD6–U+1CCF9 are outlined symbols");
  });

  it("H2. DEFECT, pinned (DV-20): proposeTrail admits 'I︠A︡roslavl …' and 'Iaroslavl …' as two Trails; the U+0361 control is refused", async () => {
    const { makeTrailBridge } = await import("./db/trailPostgrestBridge.js");
    const sc = makeTrailBridge().client;
    const one = await proposeTrail(sc, { title: `${ALA_LC} street food ${TAG}a`, destination: null }, null);
    const two = await proposeTrail(sc, { title: `${PLAIN} street food ${TAG}a`, destination: null }, null);
    assert.ok(one.trail, JSON.stringify(one));
    assert.ok(two.trail, "the second spelling is admitted by trail_propose: two canonical Trails for one theme");
    assert.notEqual(one.trail!.slug, two.trail!.slug);
    const c1 = await proposeTrail(sc, { title: `${TIE_0361} street food ${TAG}b`, destination: null }, null);
    const c2 = await proposeTrail(sc, { title: `${PLAIN} street food ${TAG}b`, destination: null }, null);
    assert.ok(c1.trail);
    assert.equal(c2.trail, null, "control: the in-range tie is one Trail");
    assert.equal(c2.canonicalisation[0]?.check, "duplicate_title_similarity");
  });

  it("H3. DEFECT, pinned (DV-20): listTrails over the real tables — the display spelling finds neither; each destination spelling lists only its own", async () => {
    const { makeTrailBridge } = await import("./db/trailPostgrestBridge.js");
    const sc = makeTrailBridge().client;
    const a = await proposeTrail(sc, { title: `Da Nang Coffee Crawl ${TAG}c`, destination: `Da Nang ${TAG}` }, null);
    const b = await proposeTrail(sc, { title: `Đà Nẵng Street Food ${TAG}c`, destination: `Đà Nẵng ${TAG}` }, null);
    assert.ok(a.trail && b.trail, JSON.stringify([a.canonicalisation, b.canonicalisation]));
    const ids = async (p: { query?: string; destination?: string }) => {
      const r = await listTrails(sc, { ...p, limit: 50 });
      assert.equal(r.refusal, null);
      return new Set(r.trails.map((t: any) => t.id));
    };
    const byDisplay = await ids({ query: "Đà Nẵng" });
    assert.equal(byDisplay.has(a.trail!.id) || byDisplay.has(b.trail!.id), false, "the display spelling finds neither Trail");
    const byDestA = await ids({ destination: `Da Nang ${TAG}` });
    const byDestB = await ids({ destination: `Đà Nẵng ${TAG}` });
    assert.deepEqual([byDestA.has(a.trail!.id), byDestA.has(b.trail!.id)], [true, false]);
    assert.deepEqual([byDestB.has(a.trail!.id), byDestB.has(b.trail!.id)], [false, true]);
    // Control: the ASCII spelling finds both, and the database's own key equates the two destinations.
    const byAscii = await ids({ query: `da nang` });
    assert.deepEqual([byAscii.has(a.trail!.id), byAscii.has(b.trail!.id)], [true, true]);
    assert.equal(scalar(`SELECT public.trail_normalised_destination('đà nẵng ${TAG}') = public.trail_normalised_destination('da nang ${TAG}')`), "t");
  });

  it("H4. DEFECT, pinned (B01): the stored key of 'I︠A︡roslavl' is `i a roslavl` and the Cities reader does not reach it; the U+0361 row is reached", async () => {
    const { psqlReadClient } = await import("./db/discoverySearchPsqlClient.js");
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const put = (name: string) => {
      const id = randomUUID();
      createdCanonical.push(id);
      exec(`INSERT INTO public.canonical_locations (id, kind, name, normalized_name, display_name, country, lat, lng, aliases)
            VALUES ('${id}', 'city', ${q(name)}, ${q(TAG + id.slice(0, 4))}, ${q(name)}, 'Russia', 1, 2, ARRAY[${q(TAG)}]);`);
      return id;
    };
    const marked = put(ALA_LC), tie = put(TIE_0361);
    assert.equal(scalar(`SELECT search_key FROM public.canonical_locations WHERE id = '${marked}'`), "i a roslavl");
    assert.equal(scalar(`SELECT search_key FROM public.canonical_locations WHERE id = '${tie}'`), "iaroslavl");
    const got = new Set((await readCanonicalCitySuggestions(psqlReadClient(), PLAIN, 10)).map((r) => r.id));
    assert.equal(got.has(marked), false, "unreachable by the undecorated spelling");
    assert.equal(got.has(tie), true, "control: the in-range tie is reached");
  });

  it("H5. LIMIT, pinned (recorded, not graded): 3441 recomputes no stored slug — a Trail stored under the pre-§73 slug is not compared", async () => {
    const { makeTrailBridge } = await import("./db/trailPostgrestBridge.js");
    const sc = makeTrailBridge().client;
    const seed = (slug: string, title: string, destination: string) => {
      const id = randomUUID();
      exec(`INSERT INTO public.trails (id, slug, title, destination, lifecycle_status) VALUES ('${id}', '${slug}', '${title}', '${destination}', 'active');`);
      return id;
    };
    // As 3415 (before 3441) slugged "Ǿresundbron …": the Ø inside Ǿ deleted.
    seed(`resundbron${TAG}d`, `Ǿresundbron${TAG}d`, `copenhagen ${TAG}`);
    const stale = await proposeTrail(sc, { title: `Øresundbron${TAG}d`, destination: `malmo ${TAG}` }, null);
    assert.ok(stale.trail, "admitted: the stored slug is outside the comparison set, so no check sees the first Trail");
    // Control: the same Trail stored under the CURRENT slug is found and refused.
    seed(`oresundbron${TAG}e`, `Ǿresundbron${TAG}e`, `copenhagen ${TAG}`);
    const fresh = await proposeTrail(sc, { title: `Øresundbron${TAG}e`, destination: `malmo ${TAG}` }, null);
    assert.equal(fresh.trail, null);
    assert.equal(scalar(`SELECT count(*) FROM public.trails WHERE slug LIKE '%${TAG}%' AND slug <> public.trail_canonical_slug(title)`), "1", "one stored slug disagrees with the current fold; nothing recomputes it");
  });
});
