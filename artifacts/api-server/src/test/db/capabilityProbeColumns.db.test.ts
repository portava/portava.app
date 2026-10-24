/**
 * Every capability's readiness probe, RUN on the replayed chain (census-trips hotfix, 2026-10-24).
 *
 * `probeSchemaReadiness` asks PostgREST `SELECT <columns> FROM <table> WHERE <probe column> = <probe value>` for every
 * table a capability requires, and anything but "no row" closes the capability: a missing column is 42703, a value the
 * key's type cannot take is 22P02. TRIP_OPERATIONAL_PROJECTIONS shipped probing `id` on three tables that have none
 * (trip_decisions, trip_subgroup_members, trip_meeting_checkpoint_participants) and the uuid sentinel against a BIGINT
 * key (trip_reservation_events), so with trip_operational_projections_enabled ON in production the gate could never
 * open. This suite runs the same filter, as SQL, against the catalog the full chain builds, for EVERY definition in the
 * tree, and fails on any error. A new definition is found by its declaration (`: CapabilityDefinition = {`), so one this
 * file does not import fails the completeness case rather than going unchecked.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do (CI's local-db job runs it, and refuses skips).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, psql } from "./localDb.ts";
import { SCHEMA_PROBE_SENTINEL_ID, type CapabilityDefinition } from "../../lib/capability/schemaRequirement.js";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";
const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** Every module that declares a CapabilityDefinition, and the module path it is imported from. */
const MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  "domain/trips/policies/tripOperationalProjections.ts": () => import("../../domain/trips/policies/tripOperationalProjections.js"),
  "lib/capability/registry.ts": () => import("../../lib/capability/registry.js"),
  "lib/discoveryTripProjectionConsumer.ts": () => import("../../lib/discoveryTripProjectionConsumer.js"),
  "lib/mapProjectionTripContract.ts": () => import("../../lib/mapProjectionTripContract.js"),
  "lib/media/trailReviewSchemaCapability.ts": () => import("../../lib/media/trailReviewSchemaCapability.js"),
  "lib/moderationReportSnapshots.ts": () => import("../../lib/moderationReportSnapshots.js"),
  "services/airport/airportCurationSchema.ts": () => import("../../services/airport/airportCurationSchema.js"),
  "services/airport/LayoverMetricsReturns.ts": () => import("../../services/airport/LayoverMetricsReturns.js"),
  "services/airport/LayoverRouteSubjects.ts": () => import("../../services/airport/LayoverRouteSubjects.js"),
  "services/airport/LayoverTravelProvenanceSchema.ts": () => import("../../services/airport/LayoverTravelProvenanceSchema.js"),
  "services/compass/CompassConversationService.ts": () => import("../../services/compass/CompassConversationService.js"),
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "test" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
/** `[path, constName]` for every `<name>: CapabilityDefinition = {` declaration under src (tests excluded). */
function declarations(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const p of walk(SRC)) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/(?:^|\n)\s*(export\s+)?const\s+([A-Za-z0-9_]+)\s*:\s*CapabilityDefinition\s*=\s*\{/g)) out.push([relative(SRC, p), m[2]!]);
  }
  return out;
}
const isDefinition = (v: unknown): v is CapabilityDefinition =>
  !!v && typeof v === "object" && typeof (v as any).flag === "string" && typeof (v as any).requires?.tables === "object";
const ident = (s: string) => { assert.match(s, /^[a-z_][a-z0-9_]*$/, `not a plain identifier: ${s}`); return `"${s}"`; };
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * `[path, line, argument]` for every `probeSchemaReadiness(<client>, <definition>` call under src (tests excluded).
 * The follow-up hotfix (2026-10-24) found three definitions written INLINE at the call, which the declaration scan
 * above cannot see; this scan finds the call itself, so a definition is covered however it is written.
 */
function probeCallSites(): Array<[string, number, string]> {
  const out: Array<[string, number, string]> = [];
  for (const p of walk(SRC)) {
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/probeSchemaReadiness\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*,\s*([^\s,)]+)/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      out.push([relative(SRC, p), line, m[1]!]);
    }
  }
  return out;
}
/** The one call site that passes a definition through: readCapability's own `def` parameter (its callers pass registry definitions). */
const PASS_THROUGH: Record<string, string> = { "lib/capability/schemaCapability.ts": "def" };

describe("every capability's readiness probe runs cleanly on the replayed chain", { skip: SKIP }, () => {
  it("completeness: every probeSchemaReadiness call passes a NAMED definition that a module this suite imports exports", async () => {
    const sites = probeCallSites();
    assert.ok(sites.length >= 15, `only ${sites.length} call sites found — the scan broke`);
    const exported = new Map<string, string[]>();
    for (const [path, load] of Object.entries(MODULES)) {
      for (const [name, v] of Object.entries(await load())) if (isDefinition(v)) exported.set(name, [...(exported.get(name) ?? []), path]);
    }
    const problems: string[] = [];
    for (const [path, line, arg] of sites) {
      if (PASS_THROUGH[path] === arg) continue;
      if (arg.startsWith("{")) { problems.push(`${path}:${line} passes an INLINE definition: export it as a CapabilityDefinition and add its module to MODULES`); continue; }
      if (!exported.has(arg)) problems.push(`${path}:${line} passes ${arg}, which no module in MODULES exports as a CapabilityDefinition`);
    }
    assert.deepEqual(problems, [], problems.join("\n"));
  });

  it("completeness: every CapabilityDefinition declared under src is EXPORTED from a module this suite imports", async () => {
    const decl = declarations();
    assert.ok(decl.length >= 10, `only ${decl.length} declarations found — the scan broke`);
    for (const [path, name] of decl) {
      assert.ok(path in MODULES, `${path} declares ${name}: add the module to MODULES`);
      const mod = await MODULES[path]!();
      assert.ok(isDefinition(mod[name]), `${path} declares ${name} but does not export it, so its probe goes unchecked`);
    }
  });

  it("each required table's probe filter (declared, or the default id = sentinel) and its column list answer 'no row', never an error", async () => {
    const problems: string[] = [];
    let probes = 0;
    for (const [path, load] of Object.entries(MODULES)) {
      const mod = await load();
      for (const [exportName, def] of Object.entries(mod)) {
        if (!isDefinition(def)) continue;
        for (const [table, req] of Object.entries(def.requires.tables)) {
          const probe = req.probe ?? { column: "id", value: SCHEMA_PROBE_SENTINEL_ID };
          const cols = req.columns.length > 0 ? req.columns.map(ident).join(", ") : ident(probe.column);
          const sql = `SELECT ${cols} FROM public.${ident(table)} WHERE ${ident(probe.column)} = ${lit(probe.value)} LIMIT 1;`;
          const r = psql(`BEGIN READ ONLY;\n${sql}\nROLLBACK;`);
          probes += 1;
          if (r.status !== 0) problems.push(`${path} ${exportName} (${def.flag}) ${table}: ${r.stderr.trim().split("\n")[0]}`);
          else if (r.stdout.trim() !== "") problems.push(`${path} ${exportName} ${table}: the probe value matched a row`);
        }
      }
    }
    assert.ok(probes >= 20, `only ${probes} probes ran`);
    assert.deepEqual(problems, [], `capability probes that can never answer "ready":\n${problems.join("\n")}`);
  });
});
