/**
 * Phase 9 — §50 the field inventory, and §29 the first reader of `privacyClass`.
 *
 * Run: node --import tsx/esm --test src/test/inputAssistanceFieldInventory.test.ts
 *
 * WHAT WAS MISSING (census-input-intelligence §4, rows G356/G357/G31)
 * ------------------------------------------------------------------
 *   G356 "Inventory every current text field and classify it" — three source
 *        files cited "the client audit's §50 field table" as an EXISTING
 *        artifact and it was not in the repository. The citation was
 *        load-bearing: it is the stated reason the fieldIds are canonical.
 *   G357 "Record, per field: screen/route, component file, fieldId,
 *        InputContext, current implementation, desired mode, entity types,
 *        provider/API, zero-state, offline, privacy class, validation, bugs,
 *        migration status" — no such record existed in any form.
 *   G31  `privacyClass` was declared on all 29 contexts and READ BY NOTHING.
 *        Deleting the field would have changed no behaviour.
 *
 * These are client-side objects, imported here across the package boundary so
 * they run inside the api-server suite — the only suite this repository's gate
 * executes. A second copy on the server would be a second source of truth.
 *
 * EVERY TEST NAMES ITS MUTATION, and each was applied and watched go RED.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIELD_INVENTORY,
  fieldInventoryRow,
  inventoriedFieldIds,
  mountedFieldIds,
} from "../../../../travel-buddy-standalone/src/platform/input-assistance/contexts/fieldInventory.ts";
import { INPUT_CONTEXT_REGISTRY } from "../../../../travel-buddy-standalone/src/platform/input-assistance/contexts/inputContexts.ts";
import { isCacheablePrivacyClass } from "../../../../travel-buddy-standalone/src/platform/input-assistance/services/suggestionCache.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const APP = path.join(REPO_ROOT, "travel-buddy-standalone");
const SDK_REL = path.join("src", "platform", "input-assistance");

/** Absolute path of a file inside the client SDK, for the source-scan assertions. */
const C = (...p: string[]) => path.join(APP, SDK_REL, ...p);

/**
 * WHY THE REGISTRARS ARE PARSED RATHER THAN IMPORTED.
 *
 * `contexts/fieldRegistry.ts` pulls in `contexts/inputPolicies.ts`, and
 * `travel-buddy-standalone` declares no `"type": "module"` — so under this
 * package's ESM test loader that chain is required as CJS and throws
 * `SyntaxError: The requested module './inputContexts.ts' does not provide an
 * export named 'getContextDescriptor'`. Measured, not assumed. Leaf modules
 * whose only imports are types (`fieldInventory.ts`, `suggestionCache.ts`) load
 * cleanly and ARE imported above.
 *
 * So the registrars' `*_FIELD_IDS` / `*_FIELD_CONTEXTS` tables are read from
 * source, exactly as `inputPolicyContractParity.test.ts` reads the client
 * context registry and for the same reason. The parse is asserted non-empty
 * below, so a formatting change fails loudly instead of silently matching
 * nothing — the failure mode that makes a source-scan test worthless.
 */
const REGISTRAR_FILES = [
  C("search", "searchFields.ts"),
  C("social", "socialFields.ts"),
  C("creation", "creationFields.ts"),
  C("compass", "compassFields.ts"),
  C("geographic", "geoFields.ts"),
];

interface Registrars {
  /** fieldId → InputContext, as the registrars declare it. */
  contexts: Map<string, string>;
  /** `OBJ_NAME.key` accessor → fieldId, which is how call sites name a field. */
  accessors: Map<string, string>;
}

function parseRegistrars(): Registrars {
  const contexts = new Map<string, string>();
  const accessors = new Map<string, string>();
  for (const file of REGISTRAR_FILES) {
    const text = readFileSync(file, "utf8");
    // `export const X_FIELD_IDS = { key: 'id', … } as const;`
    for (const block of text.matchAll(/export const (\w+_FIELD_IDS) = \{([\s\S]*?)\n\} as const;/g)) {
      const objName = block[1]!;
      for (const m of block[2]!.matchAll(/^\s*(\w+):\s*'([^']+)',/gm)) {
        accessors.set(`${objName}.${m[1]!}`, m[2]!);
      }
    }
    // `export const X_FIELD_CONTEXTS: … = { [X_FIELD_IDS.key]: 'context', … };`
    for (const block of text.matchAll(/export const \w+_FIELD_CONTEXTS[^=]*= \{([\s\S]*?)\n\};/g)) {
      for (const m of block[1]!.matchAll(/^\s*\[(\w+_FIELD_IDS)\.(\w+)\]:\s*'([^']+)',/gm)) {
        const id = accessors.get(`${m[1]!}.${m[2]!}`);
        if (id) contexts.set(id, m[3]!);
      }
    }
  }
  return { contexts, accessors };
}

/**
 * `wall.session_intent` is registered INSIDE a `.tsx` component at module load,
 * so it cannot be imported here (React Native). It is inventoried and its
 * registration is asserted from source instead.
 */
const WALL_FIELD_ID = "wall.session_intent";
const WALL_FILE = path.join(APP, "src", "features", "wall", "components", "WallHeader.tsx");

const REGISTRARS = parseRegistrars();

// ── Repo scan: which fieldIds does anything OUTSIDE the SDK reference? ─────────

/** Every .ts/.tsx under travel-buddy-standalone/{src,app} that is NOT SDK internals or a test. */
function appSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e);
      const rel = path.relative(APP, abs);
      if (rel.startsWith(SDK_REL)) continue;          // the machinery, not a consumer
      if (e === "node_modules" || e === "__tests__") continue;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      if (!/\.tsx?$/.test(e)) continue;
      if (/\.test\.tsx?$/.test(e)) continue;
      out.push(abs);
    }
  };
  walk(path.join(APP, "src"));
  walk(path.join(APP, "app"));
  return out;
}

/**
 * fieldId → the tokens a consumer may use to name it: the literal string, and
 * the exported-constant accessor (which is how every real call site names it —
 * `GEO_FIELD_IDS.tripDestination`, not `'trip.destination'`).
 */
function referenceTokens(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const ensure = (id: string) => {
    if (!m.has(id)) m.set(id, [`'${id}'`, `"${id}"`]);
    return m.get(id)!;
  };
  for (const [accessor, id] of REGISTRARS.accessors) ensure(id).push(accessor);
  ensure(WALL_FIELD_ID);
  return m;
}

/**
 * Strip comments before scanning.
 *
 * MEASURED, not defensive: without this the scan reported `post.caption` as
 * MOUNTED because `useAiWritingAssist.ts` names it in a JSDoc example —
 * "(e.g. 'post.caption', 'compass.prompt')". A doc comment is not a mount, and
 * a test that cannot tell the difference would have certified an unmounted
 * field as reached by a screen, which is the exact class of error this
 * inventory exists to stop.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

/** fieldId → the app files that reference it in CODE. */
function referencesByField(): Map<string, string[]> {
  const tokens = referenceTokens();
  const found = new Map<string, string[]>();
  for (const id of tokens.keys()) found.set(id, []);
  for (const file of appSources()) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const [id, toks] of tokens) {
      if (toks.some((t) => text.includes(t))) found.get(id)!.push(path.relative(REPO_ROOT, file));
    }
  }
  return found;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. §50 — the inventory covers every registered field, exactly once
// ═══════════════════════════════════════════════════════════════════════════════

describe("§50 field inventory (G356) — every registered field is inventoried", () => {
  it("the parse of the registrars found the tables it claims to read", () => {
    // A source scan that matched nothing would pass every set comparison below
    // by asserting emptiness against emptiness. This is the floor.
    assert.ok(REGISTRARS.accessors.size >= 20, `parsed only ${REGISTRARS.accessors.size} *_FIELD_IDS entries`);
    assert.ok(REGISTRARS.contexts.size >= 20, `parsed only ${REGISTRARS.contexts.size} *_FIELD_CONTEXTS entries`);
    assert.equal(REGISTRARS.accessors.get("GEO_FIELD_IDS.tripDestination"), "trip.destination");
    assert.equal(REGISTRARS.contexts.get("trip.destination"), "trip_destination");
  });

  it("the inventory and the registrars name the same set of fieldIds", () => {
    // MUTATION-PROOF: add a fieldId to any `*_FIELD_CONTEXTS` map (or delete one
    // row from FIELD_INVENTORY) and this names the difference → RED. That is the
    // whole point: a field can no longer join the platform without being
    // classified, which is what §50 asks for and what did not exist.
    const registered = new Set(REGISTRARS.contexts.keys());
    // The one field a screen registers itself, in a .tsx this suite cannot load.
    registered.add(WALL_FIELD_ID);
    const inventoried = new Set(inventoriedFieldIds());

    const missing = [...registered].filter((id) => !inventoried.has(id)).sort();
    const extra = [...inventoried].filter((id) => !registered.has(id)).sort();
    assert.deepEqual(missing, [], `registered but NOT inventoried: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `inventoried but not registered anywhere: ${extra.join(", ")}`);
    assert.ok(inventoried.size >= 20, `the inventory must not silently empty out (got ${inventoried.size})`);
  });

  it("no fieldId is listed twice", () => {
    const ids = inventoriedFieldIds();
    assert.equal(new Set(ids).size, ids.length, "a duplicated row would double-count a field");
  });

  it("the wall pill's field really is registered in the component the inventory names", () => {
    const row = FIELD_INVENTORY.find((r) => r.fieldId === WALL_FIELD_ID);
    assert.ok(row, "wall.session_intent must be inventoried");
    const src = readFileSync(WALL_FILE, "utf8");
    assert.ok(src.includes(`'${WALL_FIELD_ID}'`), "WallHeader must still define the id the inventory records");
    assert.ok(src.includes("registerField("), "WallHeader must still be the thing that registers it");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. §50 — every recorded attribute is real
// ═══════════════════════════════════════════════════════════════════════════════

describe("§50 field inventory (G357) — the recorded attributes are checkable", () => {
  it("every row's context is a real InputContext, and the merged row is complete", () => {
    for (const rec of FIELD_INVENTORY) {
      const d = INPUT_CONTEXT_REGISTRY[rec.context];
      assert.ok(d, `${rec.fieldId} names context "${rec.context}", which is not in the registry`);
      const row = fieldInventoryRow(rec.fieldId);
      assert.ok(row, `${rec.fieldId} must resolve to a merged §50 row`);
      // The four attributes the registry owns are MERGED, never copied — so they
      // cannot disagree with it.
      assert.equal(row!.desiredMode, d.defaultMode);
      assert.equal(row!.offlinePolicy, d.offlinePolicy);
      assert.equal(row!.privacyClass, d.privacyClass);
      assert.deepEqual(row!.entityTypes, d.entityTypes);
      // And the recorded half is present rather than blank.
      assert.ok(row!.currentImplementation.length > 20, `${rec.fieldId} records no implementation`);
      assert.ok(row!.zeroState.length > 0, `${rec.fieldId} records no zero-state`);
      assert.ok(["mounted", "registered_unmounted"].includes(row!.migrationStatus));
    }
  });

  it("every componentFile the inventory names exists on disk", () => {
    // MUTATION-PROOF: change one componentFile to a path that does not exist →
    // RED naming it. This is what stops a rename from orphaning a row silently.
    for (const rec of FIELD_INVENTORY) {
      assert.ok(
        existsSync(path.join(REPO_ROOT, rec.componentFile)),
        `${rec.fieldId} names componentFile ${rec.componentFile}, which does not exist`,
      );
    }
  });

  it("the context each registrar declares is the context the inventory records", () => {
    // MUTATION-PROOF: change one row's `context` (e.g. geo.country from
    // country_picker to city_picker) → RED naming the disagreement. This is what
    // stops the inventory becoming a second, drifting source of truth.
    for (const rec of FIELD_INVENTORY) {
      if (rec.fieldId === WALL_FIELD_ID) {
        // Registered inline in the component; assert against that source instead.
        const src = readFileSync(WALL_FILE, "utf8");
        assert.ok(
          src.includes(`registerField(WALL_INTENT_FIELD_ID, '${rec.context}')`),
          `WallHeader registers ${WALL_FIELD_ID} under a context the inventory does not record as ${rec.context}`,
        );
        continue;
      }
      const declared = REGISTRARS.contexts.get(rec.fieldId);
      assert.ok(declared, `${rec.fieldId} is inventoried but no registrar declares it`);
      assert.equal(
        declared, rec.context,
        `${rec.fieldId}: the registrar says ${declared}, the inventory says ${rec.context}`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. §50/§51 — the migration status is a MEASUREMENT, not a claim
// ═══════════════════════════════════════════════════════════════════════════════

describe("§50 migration status (G357) — mounted means a screen really references it", () => {
  it("every `mounted` field is referenced outside the SDK, and every `registered_unmounted` one is not", () => {
    // MUTATION-PROOF: flip any row's migrationStatus and this names it → RED.
    // Verified both directions: 'mounted' → 'registered_unmounted' on
    // discovery.search, and 'registered_unmounted' → 'mounted' on geo.country.
    //
    // This is the assertion that makes the inventory a measurement. Without it
    // "mounted" would be a sentence somebody typed, which is exactly the state
    // §50's missing table left every reader in.
    const refs = referencesByField();
    const wrongUnmounted: string[] = [];
    const wrongMounted: string[] = [];
    for (const rec of FIELD_INVENTORY) {
      const where = refs.get(rec.fieldId) ?? [];
      if (rec.migrationStatus === "mounted" && where.length === 0) wrongMounted.push(rec.fieldId);
      if (rec.migrationStatus === "registered_unmounted" && where.length > 0) {
        wrongUnmounted.push(`${rec.fieldId} (referenced by ${where.join(", ")})`);
      }
    }
    assert.deepEqual(wrongMounted, [], `recorded as mounted but nothing outside the SDK names them: ${wrongMounted.join(", ")}`);
    assert.deepEqual(wrongUnmounted, [], `recorded as unmounted but a screen names them: ${wrongUnmounted.join("; ")}`);
  });

  it("the scan can actually find a reference — otherwise the test above is vacuous", () => {
    // A scan that matched nothing would pass the "unmounted" half of every row
    // and quietly assert nothing. This pins the floor.
    const refs = referencesByField();
    assert.ok(refs.get("discovery.search")!.length > 0, "the global search field must be found by the scan");
    assert.ok(mountedFieldIds().length >= 5, "the inventory must record at least the known mounted fields");
    assert.ok(
      mountedFieldIds().length < FIELD_INVENTORY.length,
      "the finding this table exists to record is that MOST registered fields are not mounted",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. §29 — privacyClass finally has a reader
// ═══════════════════════════════════════════════════════════════════════════════

describe("§29 privacyClass (G31) — the shared suggestion cache refuses viewer-scoped fields", () => {
  it("public is cacheable; every viewer-scoped class is not", () => {
    // MUTATION-PROOF: remove 'viewer_scoped' from UNCACHEABLE_PRIVACY_CLASSES → RED.
    //
    // The class names here are the ones `types/inputContext.ts#PrivacyClass`
    // actually declares. An earlier version of this test asserted "personal"
    // and "sensitive", which are not members of that union — so it was pinning
    // a vocabulary the code has never used, and `isCacheablePrivacyClass`
    // would have answered `true` (cacheable) for both, which is the leaking
    // direction. It compiled only until the union was exported properly.
    assert.equal(isCacheablePrivacyClass("public"), true);
    assert.equal(isCacheablePrivacyClass("viewer_scoped"), false);
    assert.equal(isCacheablePrivacyClass("owner_only"), false);
    assert.equal(isCacheablePrivacyClass("sensitive_location"), false);
    assert.equal(isCacheablePrivacyClass("private_message"), false);
  });

  it("fails CLOSED on an unresolvable class", () => {
    assert.equal(isCacheablePrivacyClass(null), false);
    assert.equal(isCacheablePrivacyClass(undefined), false);
  });

  it("this actually changes behaviour for a field a screen mounts today", () => {
    // Not a hypothetical: telegraph_recipient is `personal` AND mounted, so the
    // gate refuses a real, reachable list of PEOPLE. If this ever becomes
    // vacuous — no mounted field carries a non-public class — the row's verdict
    // must move to ⌀, and this assertion is what would say so.
    const affected = FIELD_INVENTORY
      .filter((r) => r.migrationStatus === "mounted")
      .map((r) => fieldInventoryRow(r.fieldId)!)
      .filter((r) => !isCacheablePrivacyClass(r.privacyClass));
    assert.ok(
      affected.length > 0,
      "no MOUNTED field is affected by the privacy gate — the guard would be vacuous and the census row must say ⌀",
    );
    assert.ok(
      affected.some((r) => r.fieldId === "telegraph.recipient"),
      "the recipient picker is the case this was built for",
    );
  });

  it("the hook guards BOTH the read and the write, not just one", () => {
    // MUTATION-PROOF: delete `if (cacheable)` from the `set` call in
    // useInputAssistance.ts → RED. A read-only guard would still WRITE the
    // recipient list into the process-global map, which is the half that
    // actually retains it.
    const hook = readFileSync(C("hooks", "useInputAssistance.ts"), "utf8");
    assert.ok(hook.includes("isCacheablePrivacyClass(policy.privacyClass)"), "the hook must resolve the gate from the policy");
    assert.ok(
      /const cached = cacheable \? sharedSuggestionCache\.get\(cacheKey\) : null;/.test(hook),
      "the cache READ must be gated",
    );
    assert.ok(
      /if \(cacheable\) sharedSuggestionCache\.set\(cacheKey, finalized\);/.test(hook),
      "the cache WRITE must be gated",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. §20 — the badges reach the row AND the screen-reader announcement
// ═══════════════════════════════════════════════════════════════════════════════

describe("§20 display (G180/G181) — the row renders the badges and announces them", () => {
  it("EntitySuggestionRow derives both its badges and its a11y label from one helper", () => {
    // MUTATION-PROOF: delete `...badges.map((b) => b.label),` from the a11yLabel
    // array in EntitySuggestionRow.tsx → RED. A badge that is visible and
    // unannounced is a §46 accessibility defect, and the two strings drifting
    // apart is how that happens.
    const row = readFileSync(C("components", "EntitySuggestionRow.tsx"), "utf8");
    assert.ok(row.includes("import { suggestionBadges }"), "the row must use the shared helper");
    assert.ok(row.includes("const badges = suggestionBadges(suggestion);"), "…once");
    assert.ok(row.includes("...badges.map((b) => b.label),"), "the announcement must include every badge");
    assert.ok(row.includes("testID={`ia-badge-${b.id}`}"), "each badge must be addressable in a UI test");
  });
});
