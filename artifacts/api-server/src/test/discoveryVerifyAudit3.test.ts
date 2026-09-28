/**
 * discoveryVerifyAudit3.test.ts — census-discovery §74 (independent
 * verification lane P32): runnable attacks on the two C verdicts §73 (lane P27)
 * gave DV-20 and B01. Same form as §59's and §66's suites: a DEFECT or LIMIT is
 * pinned so that a fix turns it red and forces the census to be re-read, and a
 * CONTROL shows the probe can see the other outcome. §77 (lane P35) made the
 * fix and flipped each DEFECT to FIXED, keeping its intent and every control.
 *
 * Cases marked (harness) run only with LOCAL_DB_URL set (scripts/local-db/up.sh)
 * and skip otherwise, as every src/test/db suite does.
 *
 *   V1  CONTROL (DV-20, confirms §73): every spelling of Ǿ (precomposed, Ø plus
 *       a combining acute, O plus a combining solidus and an acute) is one slug;
 *       every letter of Latin Extended Additional slugs as its undecorated
 *       letter; every Latin letter slugs as its other case does.
 *   V2  FIXED by §77 (lane P35; was DEFECT, pinned, DV-20): a Latin letter
 *       carrying a combining mark that Unicode classes as a Diacritic, from the
 *       three combining blocks made for Latin OUTSIDE U+0300–U+036F, slugs as
 *       its letter. The ALA-LC romanisation "I︠A︡roslavl" (ligature half marks
 *       U+FE20/U+FE21) and "Iaroslavl" are one canonical Trail.
 *   V2c CONTROL: the same tie written as U+0361 (inside the stripped range) is
 *       one slug, and the canonicaliser refuses the second as a duplicate.
 *   V3  FIXED by §77 (was DEFECT, pinned, DV-20): GET /v1/discovery/trails
 *       canonicalises the search term with canonicalTrailSlug ("Đà Nẵng"
 *       searches `da-nang`, not `---n-ng`) and filters the destination by 3441's
 *       stored key, so the Trails §61 treats as one destination list together.
 *   V3c CONTROL: the ASCII spelling finds the Trail, and the destination key
 *       the creation checks use does equate the two destinations.
 *   V3d the edges §77 chose: a term with no slug finds nothing; a destination
 *       the fold deletes keeps equality; 3441 absent is 503, never a string match.
 *   B1  CONTROL (B01, confirms §73): NFC and NFD input key alike for every
 *       Latin letter; Latin Extended Additional keys as its base letter.
 *   B2  FIXED by §77 (was DEFECT, pinned, B01): the same Diacritic marks leave
 *       the key as the letter's: "I︠A︡roslavl" keys `iaroslavl`, and the Cities
 *       reader's pattern for "Iaroslavl" matches it.
 *   B2c CONTROL: U+0361 folds; the reader's pattern matches that row.
 *   Q4  RECORD: the readings §73 states so they can be overruled (ƻ ɿ ʢ ʨ
 *       deleted; ß æ œ untouched pending owner question 4) are in its text and
 *       in the code's behaviour; the reading goes red if either changes.
 *   H1  (harness) CONTROL (B01, DV-20): input_normalize_city_key equals
 *       searchKey, and trail_normalised_destination equals trailDestinationKey,
 *       on every ASSIGNED code point; the SQL slug differs from
 *       canonicalTrailSlug on exactly the 37 code points §74.4 #1 lists
 *       (PostgreSQL 16's older Unicode), alone and inside a word.
 *   H2  (harness) FIXED by §77 (was DEFECT, pinned, DV-20): through proposeTrail
 *       and trail_propose, "Iaroslavl …" is refused beside "I︠A︡roslavl …", as
 *       the U+0361 control is.
 *   H3  (harness) FIXED by §77 (was DEFECT, pinned, DV-20): through listTrails
 *       over the real tables, the display spelling finds both Trails and each
 *       destination spelling lists both; the ASCII search finds both (control).
 *   H4  (harness) FIXED by §77 (was DEFECT, pinned, B01): a registry row named
 *       "I︠A︡roslavl" stores `iaroslavl`, and readCanonicalCitySuggestions
 *       ("Iaroslavl") reaches it; the U+0361 row stores the same key, and the
 *       reader, which keeps one row per key, returns one of the two (control).
 *   H5  (harness) FIXED by §77 (was LIMIT, pinned, §74.4 #2): 3441 recomputes
 *       stored `trails.slug`. A Trail stored under an older fold is re-slugged
 *       when 3441 runs, and a re-spelling is then refused.
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

/** A supabase-shaped chain that records the filters listTrails sends and answers `[]` (or `answer`), noting whether it was sent. */
function recordingClient(answer: { data: unknown; error: unknown } = { data: [], error: null }) {
  const calls: Array<{ op: string; col: string; val: string }> = [];
  let sent = false;
  const chain: any = {
    select: () => chain, neq: () => chain, order: () => chain, limit: () => chain,
    eq: (col: string, val: string) => { calls.push({ op: "eq", col, val }); return chain; },
    ilike: (col: string, val: string) => { calls.push({ op: "ilike", col, val }); return chain; },
    then: (res: (v: unknown) => unknown) => { sent = true; return Promise.resolve(answer).then(res); },
  };
  return { sc: { from: () => chain }, calls, sent: () => sent };
}

/** A stored Trail as proposeTrail writes it: slug from canonicalTrailSlug, destination trimmed and lowercased. */
const stored = (title: string, destination: string) => ({ title, slug: canonicalTrailSlug(title)!, destination: destination.trim().toLowerCase(),
  destination_key: trailDestinationKey(destination.trim().toLowerCase()) || null }); // 3441's generated trail_normalised_destination(destination); parity: H1b

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

  it("V2. FIXED (DV-20, §77): a Latin letter with a Diacritic mark outside U+0300–U+036F slugs as its letter; 'I︠A︡roslavl' and 'Iaroslavl' are one canonical Trail", () => {
    const marks = outOfRangeDiacritics();
    assert.equal(marks.length, 91, `${marks.length}: ${hex(marks.join(""))}`);
    const split = marks.filter((m) => canonicalTrailSlug(`zu${m}rich food`) !== canonicalTrailSlug("zurich food"));
    assert.deepEqual(split.map(hex), [], "none of the 91 splits the word it sits in");
    assert.equal(canonicalTrailSlug(`${ALA_LC} street food`), "iaroslavl-street-food");
    assert.equal(canonicalTrailSlug(`${PLAIN} street food`), "iaroslavl-street-food");
    const first = { id: "t1", slug: canonicalTrailSlug(`${ALA_LC} street food`)!, title: `${ALA_LC} street food`, destination: null };
    const second = canonicaliseTrailProposal({ title: `${PLAIN} street food`, destination: null }, [first]);
    assert.equal(second.ok, false, "the second spelling is REFUSED: one Trail for one theme");
    assert.equal(second.refusals[0]?.check, "duplicate_title_similarity");
    // Macron-acute (U+1DC4), a tone mark with no precomposed letter: the sequence is the only way to write it.
    assert.equal(canonicalTrailSlug("Zu\u1DC4rich coffee"), canonicalTrailSlug("Zurich coffee"));
    assert.equal(trailDestinationKey(ALA_LC), trailDestinationKey(PLAIN), "…and one destination");
  });

  it("V2c. CONTROL: the same tie as U+0361 is one slug, and the second spelling is refused as a duplicate", () => {
    assert.equal(canonicalTrailSlug(`${TIE_0361} street food`), "iaroslavl-street-food");
    const first = { id: "t1", slug: canonicalTrailSlug(`${TIE_0361} street food`)!, title: `${TIE_0361} street food`, destination: null };
    const second = canonicaliseTrailProposal({ title: `${PLAIN} street food`, destination: null }, [first]);
    assert.equal(second.ok, false);
    assert.equal(second.refusals[0]?.check, "duplicate_title_similarity");
  });

  it("V3. FIXED (DV-20, §77): listTrails compares the term and the destination by their canonical keys", async () => {
    const a = stored("Da Nang Coffee Crawl", "Da Nang");        // `02` §1's own example Trail
    const b = stored("Đà Nẵng Street Food", "Đà Nẵng");
    // The term: put through canonicalTrailSlug, the fold the stored slug was made by.
    const { sc, calls } = recordingClient();
    await listTrails(sc, { query: "Đà Nẵng" });
    assert.deepEqual(calls, [{ op: "ilike", col: "slug", val: "%da-nang%" }]);
    assert.equal(await listed({ query: "Đà Nẵng" }, a), true, "the display spelling finds the Da Nang Trail");
    assert.equal(await listed({ query: "Đà Nẵng" }, b), true, "…and the Trail whose own title it is");
    assert.equal(await listed({ query: "Café" }, stored("Café culture", "Paris")), true, "an ordinary acute no longer breaks it");
    assert.equal(await listed({ query: `${ALA_LC}` }, stored(`${PLAIN} street food`, "Yaroslavl")), true, "nor a half-mark tie");
    // The destination: by 3441's stored key, the one creation compares, not by raw equality.
    const d = recordingClient();
    await listTrails(d.sc, { destination: "  Đà Nẵng " });
    assert.deepEqual(d.calls, [{ op: "eq", col: "destination_key", val: "da nang" }]);
    assert.equal(await listed({ destination: "Đà Nẵng" }, a), true);
    assert.equal(await listed({ destination: "Da Nang" }, b), true);
    assert.equal(await listed({ destination: "Hoi An" }, b), false, "control: another place is another destination");
  });

  it("V3d. the edges: a term with no slug-able character finds nothing and sends no request; a destination the fold deletes keeps equality; a missing key column is 503, not a string match", async () => {
    const idle = recordingClient();
    const r = await listTrails(idle.sc, { query: "🍜" });
    assert.deepEqual([r.refusal, r.trails, idle.sent()], [null, [], false], "no Trail slug can contain a term that has no slug, so nothing is sent");
    const { sc, calls } = recordingClient();
    await listTrails(sc, { destination: "東京" });
    assert.deepEqual(calls, [{ op: "eq", col: "destination", val: "東京" }], "no key to compare: the stored spelling, as before");
    const missing = recordingClient({ data: null, error: { code: "42703", message: "column trails.destination_key does not exist" } });
    assert.equal((await listTrails(missing.sc, { destination: "Da Nang" })).refusal, "trails_unavailable", "3441 absent: refuse, never fall back to the string compare");
  });

  it("V3c. CONTROL: the ASCII spelling finds both, each destination spelling finds its own, and the creation key equates them", async () => {
    const a = stored("Da Nang Coffee Crawl", "Da Nang");
    const b = stored("Đà Nẵng Street Food", "Đà Nẵng");
    assert.equal(await listed({ query: "da nang" }, a), true);
    assert.equal(await listed({ query: "da nang" }, b), true);
    assert.equal(await listed({ destination: "Da Nang" }, a), true);
    assert.equal(await listed({ destination: "Đà Nẵng" }, b), true);
    assert.equal(trailDestinationKey(a.destination), trailDestinationKey(b.destination), "§61: one destination whatever its spelling");
    assert.equal(canonicalTrailSlug("Đà Nẵng"), "da-nang", "the canonical form the term is now put through");
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

  it("B2. FIXED (B01, §77): a Diacritic mark outside U+0300–U+036F keys as its letter; the Cities reader reaches 'I︠A︡roslavl' from 'Iaroslavl'", async () => {
    const marks = outOfRangeDiacritics();
    const changed = marks.filter((m) => searchKey(`zu${m}rich`) !== "zurich");
    assert.deepEqual(changed.map(hex), [], "none of the 91 changes the key of the word it sits in");
    assert.equal(searchKey(ALA_LC), "iaroslavl");
    assert.equal(searchKey("Zu\u1DC4rich"), "zurich");
    // The reader's own patterns for the plain spelling, against the stored key of the marked one.
    const patterns: string[] = [];
    const sc = { from: () => { const c: any = { select: () => c, ilike: (_: string, p: string) => { patterns.push(p); return c; }, limit: () => Promise.resolve({ data: [], error: null }) }; return c; } };
    await readCanonicalCitySuggestions(sc, PLAIN, 4);
    assert.deepEqual(patterns, ["iaroslavl%", "%iaroslavl%"]);
    assert.equal(patterns.some((p) => ilike(searchKey(ALA_LC), p)), true, "the row is reachable by its undecorated spelling");
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
  it("H1. CONTROL (B01, DV-20): SQL key = searchKey and SQL destination key = trailDestinationKey on every assigned code point; the SQL slug differs on exactly the 37 §74.4 #1 lists", { timeout: 600_000 }, () => {
    const ranges: Array<[number, number]> = [];
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp === 0xd800) cp = 0xe000;
      if (!/\P{Cn}/u.test(String.fromCodePoint(cp))) continue;
      const last = ranges[ranges.length - 1];
      if (last && last[1] === cp - 1) last[1] = cp; else ranges.push([cp, cp]);
    }
    const lines = bigQuery(`SELECT cp, public.input_normalize_city_key(chr(cp)), public.input_normalize_city_key('x' || chr(cp) || 'resund'),
                                   coalesce(public.trail_canonical_slug('x' || chr(cp) || 'resund'), '<null>'),
                                   coalesce(public.trail_canonical_slug(chr(cp)), '<null>'),
                                   coalesce(public.trail_normalised_destination(chr(cp)), '<null>'),
                                   coalesce(public.trail_normalised_destination('x' || chr(cp) || 'resund'), '<null>')
                              FROM jsonb_array_elements('${JSON.stringify(ranges)}'::jsonb) r,
                                   generate_series((r ->> 0)::int, (r ->> 1)::int) cp;`);
    const keyDiff: string[] = [], slugDiff: string[] = [], slugAloneDiff: string[] = [], destDiff: string[] = [];
    for (const l of lines) {
      const [cps, alone, inWord, slug, slugAlone, dest, destInWord] = l.split("\t");
      const ch = String.fromCodePoint(Number(cps));
      if (searchKey(ch) !== (alone ?? "") || searchKey(`x${ch}resund`) !== (inWord ?? "")) keyDiff.push(hex(ch));
      if ((canonicalTrailSlug(`x${ch}resund`) ?? "<null>") !== slug) slugDiff.push(ch);
      if ((canonicalTrailSlug(ch) ?? "<null>") !== slugAlone) slugAloneDiff.push(ch);
      if ((trailDestinationKey(ch) || "<null>") !== dest || (trailDestinationKey(`x${ch}resund`) || "<null>") !== destInWord) destDiff.push(hex(ch));
    }
    assert.equal(lines.length, 297_333, "every assigned code point in Unicode 17, U+0000 and the surrogates excluded");
    assert.deepEqual(keyDiff, [], "the stored fold and the query fold agree everywhere");
    assert.deepEqual(destDiff, [], "the SQL destination key (listTrails' stored destination_key) and trailDestinationKey agree everywhere");
    // §74.4 #1, recorded exactly and not hidden: PostgreSQL 16's normalize() is Unicode 15.1, Node 22's is 17.0. U+A7F1
    // MODIFIER LETTER CAPITAL S (Unicode 17) and U+1CCD6–U+1CCF9, OUTLINED LATIN CAPITAL LETTER A–Z and OUTLINED DIGIT
    // 0–9 (Unicode 16), have compatibility decompositions this PostgreSQL does not know: TypeScript spells them, SQL deletes them.
    const expected = ["\uA7F1", ...Array.from({ length: 0x1ccf9 - 0x1ccd6 + 1 }, (_, i) => String.fromCodePoint(0x1ccd6 + i))];
    assert.deepEqual(slugDiff.map(hex), expected.map(hex), "inside a word");
    assert.deepEqual(slugAloneDiff.map(hex), expected.map(hex), "alone");
    assert.deepEqual(slugDiff.filter((c) => /\p{L}/u.test(c)), ["\uA7F1"], "only U+A7F1 (§73.7 #2) is a letter; U+1CCD6–U+1CCF9 are outlined symbols");
  });

  it("H2. FIXED (DV-20, §77): proposeTrail refuses 'Iaroslavl …' beside 'I︠A︡roslavl …', as it refuses the U+0361 control", async () => {
    const { makeTrailBridge } = await import("./db/trailPostgrestBridge.js");
    const sc = makeTrailBridge().client;
    const one = await proposeTrail(sc, { title: `${ALA_LC} street food ${TAG}a`, destination: null }, null);
    const two = await proposeTrail(sc, { title: `${PLAIN} street food ${TAG}a`, destination: null }, null);
    assert.ok(one.trail, JSON.stringify(one));
    assert.equal(one.trail!.slug, `iaroslavl-street-food-${TAG}a`, "trail_propose's own slug folds the half marks");
    assert.equal(two.trail, null, "the second spelling is refused by trail_propose: one canonical Trail for one theme");
    assert.ok(two.canonicalisation.some((c) => c.check === "duplicate_title_similarity" && c.conflictsWith === one.trail!.id), JSON.stringify(two.canonicalisation));
    const c1 = await proposeTrail(sc, { title: `${TIE_0361} street food ${TAG}b`, destination: null }, null);
    const c2 = await proposeTrail(sc, { title: `${PLAIN} street food ${TAG}b`, destination: null }, null);
    assert.ok(c1.trail);
    assert.equal(c2.trail, null, "control: the in-range tie is one Trail");
    assert.equal(c2.canonicalisation[0]?.check, "duplicate_title_similarity");
  });

  it("H3. FIXED (DV-20, §77): listTrails over the real tables — the display spelling finds both; each destination spelling lists both", async () => {
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
    assert.deepEqual([byDisplay.has(a.trail!.id), byDisplay.has(b.trail!.id)], [true, true], "the display spelling finds both Trails");
    const byDestA = await ids({ destination: `Da Nang ${TAG}` });
    const byDestB = await ids({ destination: `Đà Nẵng ${TAG}` });
    assert.deepEqual([byDestA.has(a.trail!.id), byDestA.has(b.trail!.id)], [true, true]);
    assert.deepEqual([byDestB.has(a.trail!.id), byDestB.has(b.trail!.id)], [true, true]);
    assert.equal((await ids({ destination: `Hoi An ${TAG}` })).size, 0, "control: another place lists neither");
    assert.equal(scalar(`SELECT destination_key FROM public.trails WHERE id = '${b.trail!.id}'`), trailDestinationKey(`đà nẵng ${TAG}`), "the stored key is the TypeScript key");
    // Control: the ASCII spelling finds both, and the database's own key equates the two destinations.
    const byAscii = await ids({ query: `da nang` });
    assert.deepEqual([byAscii.has(a.trail!.id), byAscii.has(b.trail!.id)], [true, true]);
    assert.equal(scalar(`SELECT public.trail_normalised_destination('đà nẵng ${TAG}') = public.trail_normalised_destination('da nang ${TAG}')`), "t");
  });

  it("H4. FIXED (B01, §77): the stored key of 'I︠A︡roslavl' is `iaroslavl` and the Cities reader reaches it; the U+0361 row stores the same key", async () => {
    const { psqlReadClient } = await import("./db/discoverySearchPsqlClient.js");
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const put = (name: string) => {
      const id = randomUUID();
      createdCanonical.push(id);
      exec(`INSERT INTO public.canonical_locations (id, kind, name, normalized_name, display_name, country, lat, lng, aliases)
            VALUES ('${id}', 'city', ${q(name)}, ${q(TAG + id.slice(0, 4))}, ${q(name)}, 'Russia', 1, 2, ARRAY[${q(TAG)}]);`);
      return id;
    };
    const reach = async () => new Set((await readCanonicalCitySuggestions(psqlReadClient(), PLAIN, 10)).map((r) => r.id));
    const marked = put(ALA_LC);
    assert.equal(scalar(`SELECT search_key FROM public.canonical_locations WHERE id = '${marked}'`), "iaroslavl");
    assert.equal((await reach()).has(marked), true, "reachable by the undecorated spelling");
    // Control: the in-range tie stores the same key. The reader keeps one row per key, so the two spellings are now one city.
    const tie = put(TIE_0361);
    assert.equal(scalar(`SELECT search_key FROM public.canonical_locations WHERE id = '${tie}'`), "iaroslavl");
    const both = await reach();
    assert.equal([marked, tie].filter((id) => both.has(id)).length, 1, "one key, one suggestion");
  });

  it("H5. FIXED (DV-20, §77): 3441 recomputes stored `trails.slug` — a Trail stored under an older fold is re-slugged, and a re-spelling is then refused", async () => {
    const { makeTrailBridge } = await import("./db/trailPostgrestBridge.js");
    const sc = makeTrailBridge().client;
    const seed = (slug: string, title: string, destination: string) => {
      const id = randomUUID();
      exec(`INSERT INTO public.trails (id, slug, title, destination, lifecycle_status) VALUES ('${id}', '${slug}', '${title}', '${destination}', 'active');`);
      return id;
    };
    const stale = () => scalar(`SELECT count(*) FROM public.trails WHERE slug LIKE '%${TAG}%' AND slug <> public.trail_canonical_slug(title)`);
    // As 3415 (before 3441) slugged "Ǿresundbron …" (the Ø inside Ǿ deleted), and as 3441 before §77 slugged the half-mark tie.
    const d = seed(`resundbron${TAG}d`, `Ǿresundbron${TAG}d`, `copenhagen ${TAG}`);
    const f = seed(`i-a-roslavl-bridges${TAG}f`, `${ALA_LC} bridges${TAG}f`, `yaroslavl ${TAG}`);
    assert.equal(stale(), "2", "control: both stored slugs disagree with the current fold before 3441 runs");
    exec(readFileSync(resolve(HERE, "../migrations/3441_trail_letter_fold_decompose_first.sql"), "utf8"));
    assert.equal(stale(), "0", "3441 recomputed every stored slug");
    assert.equal(scalar(`SELECT slug FROM public.trails WHERE id = '${d}'`), `oresundbron${TAG}d`);
    assert.equal(scalar(`SELECT slug FROM public.trails WHERE id = '${f}'`), `iaroslavl-bridges${TAG}f`);
    for (const [title, id] of [[`Øresundbron${TAG}d`, d], [`${PLAIN} bridges${TAG}f`, f]] as const) {
      const again = await proposeTrail(sc, { title, destination: `malmo ${TAG}` }, null);
      assert.equal(again.trail, null, `${title} was admitted beside the re-slugged Trail`);
      assert.ok(again.canonicalisation.some((c) => c.check === "duplicate_title_similarity" && c.conflictsWith === id), JSON.stringify(again.canonicalisation));
    }
  });
});
