/**
 * userLink — WHO IS IN THE DELETION UNIVERSE, decided from the schema.
 *
 * ── THE BUG THIS FILE EXISTS TO FIX ──────────────────────────────────────────
 * check:deletion-coverage used to answer "is this table about a user?" by
 * matching 18 recognised COLUMN NAMES (USER_IDENTIFYING_COLUMNS). A column name
 * is a convention, not a fact. A table can carry a person's uuid in a column
 * called `blocked_id`, `subject_profile_id` or `actor_ref` and be invisible to a
 * name list, so the guard reported 248 user-keyed tables and governed a
 * universe it had not measured. 91 tables were outside it — including `blocks`,
 * `appeals`, `moderation_actions`, `reviews`, `media_assets`,
 * `user_restrictions`, `user_mutes`, `safe_return_contacts`, `trip_documents`
 * and `profiles` itself. Several of those are already erased by
 * AccountDeletionService and could not even be RECORDED as erased, because an
 * entry the name list could not see was reported as a stale entry.
 *
 * So the denominator is measured from the FOREIGN KEY GRAPH of the committed
 * baseline dump instead. Column names still contribute — they are the only
 * evidence for a uuid that carries no FK — but they are never the sole source of
 * truth, and they can never produce a confident class on their own.
 *
 * ── THE FIVE CLASSES, AND THE RULE THAT PRODUCES EACH ────────────────────────
 * Precedence is DIRECT > INDIRECT > DERIVED > AMBIGUOUS > NOT_USER_LINKED. A
 * table is classified by the STRONGEST evidence it has; every other piece of
 * evidence is still listed in `reasons`, so nothing that argued for inclusion is
 * thrown away.
 *
 *   DIRECT_USER_LINKED    The table IS a canonical user root (`profiles`), or it
 *                         declares a FOREIGN KEY to one (public.profiles or
 *                         auth.users). MEASURED — the constraint is in the dump.
 *
 *   INDIRECT_USER_LINKED  The table declares an OWNERSHIP-PRESERVING foreign key
 *                         to a table that is itself DIRECT or INDIRECT. This is
 *                         the documented graph rule, stated once in
 *                         INDIRECT_OWNERSHIP_RULE below and applied
 *                         mechanically. It is transitive, so a profile FK two
 *                         hops away through another owned row is INDIRECT at
 *                         hops = 2, and `path` names the hops it travelled.
 *
 *   DERIVED_USER_LINKED   No FK path, but either (a) the table carries a column
 *                         from the curated USER_IDENTIFYING_COLUMNS list that no
 *                         FK backs — a user's uuid stored without a constraint —
 *                         or (b) a person has explicitly registered the table in
 *                         deletionDispositions.ts. A manual registration ALWAYS
 *                         keeps a table in the universe: a legal-retention row
 *                         someone wrote down by hand cannot fall out of scope
 *                         because the schema stopped mentioning it.
 *
 *   AMBIGUOUS             There is evidence, and it does not settle the question.
 *                         Two ways in: a uuid column NAMED like a person
 *                         reference that declares no foreign key (`user_a`,
 *                         `subject_user_id`, `admin_id`, `verified_by`), or a
 *                         path to a user-linked table made only of
 *                         NON-ownership-preserving edges. AMBIGUOUS IS INSIDE
 *                         THE GOVERNED UNIVERSE. "We cannot tell" is a reason to
 *                         make somebody look, not a reason to drop the table.
 *
 *   NOT_USER_LINKED       No FK path, no curated column, no name hint on a uuid,
 *                         no manual registration. Reference data, caches and
 *                         catalogues live here — and the REASON is stated per
 *                         table so the claim can be checked rather than trusted.
 *
 * ── WHAT THIS CANNOT SEE, stated rather than implied ─────────────────────────
 *   * A user's uuid stored in a `text` column, in jsonb, or in an array of a
 *     non-uuid type. The hint rule only looks at uuid / uuid[] columns.
 *   * Post-baseline tables. They enter through the manifest's
 *     POST_BASELINE_TABLES as DERIVED (manual registration) and carry no schema
 *     evidence at all until the baseline is recaptured.
 *   * Application-level ownership with no constraint and no naming convention.
 *     That is exactly the hole AMBIGUOUS exists to keep visible.
 *
 * NOTHING HERE DECIDES A DELETION FATE. This file answers "who is in scope",
 * which is owner decision D6's INPUT, never its answer.
 */
import {
  ERASED_BY_CASCADE,
  ANONYMISED_FK_NULLED,
  DELETION_FLOW_TABLES,
  RETAINED_WITH_REASON,
  UNCLASSIFIED_BACKLOG,
  DENOMINATOR_CORRECTION_BACKLOG,
  POST_BASELINE_TABLES,
  USER_IDENTIFYING_COLUMNS,
} from "../deletionDispositions.js";
import { parseSchemaFacts, type TableFacts, type ForeignKeyFact } from "./schemaFacts.js";
import type { UserLinkClass, UserLinkFact } from "./types.js";

/** Referenced tables that ARE the account being deleted. */
export const USER_ROOT_REFERENCES: readonly string[] = ["public.profiles", "auth.users"];

/**
 * Public tables that are themselves the user record. `profiles` also declares an
 * FK to auth.users today, so it would be DIRECT either way — it is named here so
 * that dropping that constraint cannot quietly remove the user record itself
 * from the universe of tables governed by account deletion.
 */
export const USER_ROOT_TABLES: readonly string[] = ["profiles"];

/**
 * THE INDIRECT OWNERSHIP RULE — stated as code, not as a comment, so a test can
 * assert the rule text survives `stripComments` and a reader cannot delete the
 * rule by deleting its documentation.
 *
 * An FK edge child -> parent is OWNERSHIP-PRESERVING when the child row cannot
 * exist independently of the parent row:
 *
 *   * the FK declares ON DELETE CASCADE  (parent goes, child goes), or
 *   * every column of the FK is NOT NULL (the reference can never be severed in
 *     place, so every child row has a parent for its whole life).
 *
 * A NULLABLE, non-cascading FK is a REFERENCE, not containment: some rows have
 * no parent at all, so the parent's owner cannot be said to own the child. Such
 * an edge does not carry ownership and lands the child in AMBIGUOUS instead.
 */
export const INDIRECT_OWNERSHIP_RULE =
  "A table is INDIRECT_USER_LINKED when it declares an ownership-preserving foreign key to a " +
  "DIRECT or INDIRECT user-linked table. An edge is ownership-preserving when the child row " +
  "cannot exist without the parent row: the foreign key declares ON DELETE CASCADE, or every " +
  "column of the foreign key is NOT NULL. A nullable non-cascading foreign key is a reference, " +
  "not ownership, and yields AMBIGUOUS. The rule is transitive, so a profiles foreign key two " +
  "hops away through another owned row is INDIRECT_USER_LINKED at hops = 2.";

/**
 * uuid columns whose NAME says "this is a person" but which declare no foreign
 * key. CONTRIBUTING evidence only: a hit here can never produce DIRECT or
 * INDIRECT, only AMBIGUOUS. Deliberately anchored on person WORDS — an
 * unrelated uuid (`item_id`, `entity_id`, `catalog_id`, `trip_id`, `id`) must
 * not match, or the class would mean nothing.
 */
export const USER_NAME_HINT_RE =
  /(^|_)(user|users|actor|owner|author|admin|moderator|reviewer|requester|recipient|sender|host|buddy|traveler|traveller|viewer|profile|follower|following|blocker|blocked|reporter|creator|member|assignee|guest|participant|invitee|inviter)(_|$)|_by$/;

const UUID_TYPE_RE = /^uuid(\[\])?\b/;

/** Every bucket of the manifest, i.e. every table a person has written down. */
export function manuallyRegisteredTables(): Map<string, string> {
  const out = new Map<string, string>();
  const put = (bucket: string, names: readonly string[]) => {
    for (const t of names) if (!out.has(t)) out.set(t, bucket);
  };
  put("ERASED_BY_CASCADE", ERASED_BY_CASCADE);
  put("ANONYMISED_FK_NULLED", ANONYMISED_FK_NULLED);
  put("DELETION_FLOW_TABLES", DELETION_FLOW_TABLES);
  put("RETAINED_WITH_REASON", RETAINED_WITH_REASON.map((r) => r.table));
  put("UNCLASSIFIED_BACKLOG", UNCLASSIFIED_BACKLOG);
  put("DENOMINATOR_CORRECTION_BACKLOG", DENOMINATOR_CORRECTION_BACKLOG);
  put("POST_BASELINE_TABLES", POST_BASELINE_TABLES);
  return out;
}

export interface UserLinkInput {
  /** Text of the schema-only baseline dump. */
  sql?: string;
  /** Pre-parsed facts, when the caller already has them. */
  facts?: Map<string, TableFacts>;
  /**
   * Tables to include that the dump predates. They carry no schema evidence, so
   * they can only ever be DERIVED (manual registration).
   */
  extraTables?: readonly string[];
  /** Manual registrations. Defaults to the live manifest. */
  registrations?: Map<string, string>;
}

/** Is this edge ownership-preserving? See INDIRECT_OWNERSHIP_RULE. */
export function isOwnershipPreserving(child: TableFacts, fk: ForeignKeyFact): boolean {
  if (fk.onDelete === "CASCADE") return true;
  return fk.columns.every((name) => {
    const col = child.columns.find((c) => c.name === name);
    return col ? /\bNOT NULL\b/.test(col.type) : false;
  });
}

const CLASS_RANK: Record<UserLinkClass, number> = {
  DIRECT_USER_LINKED: 4,
  INDIRECT_USER_LINKED: 3,
  DERIVED_USER_LINKED: 2,
  AMBIGUOUS: 1,
  NOT_USER_LINKED: 0,
};

/**
 * Classify EVERY application table. Returns one fact per table, sorted by name,
 * so the output is a stable artefact rather than a hash-order listing.
 *
 * VACUITY IS A FAILURE: a classification over zero tables, or one that finds no
 * user root at all, would let every downstream count pass by describing
 * nothing. Both throw.
 */
export function classifyUserLinks(input: UserLinkInput): Map<string, UserLinkFact> {
  const facts = input.facts ?? parseSchemaFacts(input.sql ?? "");
  const registrations = input.registrations ?? manuallyRegisteredTables();
  const extras = [...new Set(input.extraTables ?? [])].filter((t) => !facts.has(t));

  if (facts.size === 0 && extras.length === 0) {
    throw new Error(
      "classifyUserLinks: the schema text yielded ZERO tables, and therefore ZERO user-keyed tables. " +
        "A user-link graph over nothing would let the deletion denominator pass vacuously; refusing to build one.",
    );
  }

  const curated = new Set(USER_IDENTIFYING_COLUMNS);
  const rootRefs = new Set(USER_ROOT_REFERENCES);
  const rootTables = new Set(USER_ROOT_TABLES);

  const linkClass = new Map<string, UserLinkClass>();
  const reasons = new Map<string, string[]>();
  const hops = new Map<string, number>();
  const paths = new Map<string, string[]>();
  const addReason = (t: string, r: string) => reasons.set(t, [...(reasons.get(t) ?? []), r]);
  const assign = (t: string, c: UserLinkClass) => {
    const cur = linkClass.get(t) ?? "NOT_USER_LINKED";
    if (CLASS_RANK[c] > CLASS_RANK[cur]) linkClass.set(t, c);
  };

  const names = [...facts.keys()].sort();

  // ── DIRECT: a canonical user root, or a measured FK to one. ────────────────
  for (const name of names) {
    const t = facts.get(name)!;
    if (rootTables.has(name)) {
      assign(name, "DIRECT_USER_LINKED");
      hops.set(name, 0);
      paths.set(name, [name]);
      addReason(name, `canonical user root: ${name} IS the user record`);
    }
    for (const fk of t.foreignKeys) {
      if (!rootRefs.has(fk.references)) continue;
      assign(name, "DIRECT_USER_LINKED");
      if (!hops.has(name)) {
        hops.set(name, 0);
        paths.set(name, [name, fk.references]);
      }
      addReason(
        name,
        `FOREIGN KEY ${fk.constraint} (${fk.columns.join(", ")}) REFERENCES ${fk.references} ` +
          `ON DELETE ${fk.onDelete}`,
      );
    }
  }

  if (![...linkClass.values()].some((c) => c === "DIRECT_USER_LINKED") && facts.size > 0) {
    throw new Error(
      "classifyUserLinks: the schema declares NO foreign key to public.profiles or auth.users and no " +
        "canonical user root, so it yields ZERO user-keyed tables. Either the dump is not this " +
        "application's schema, or the parser silently dropped every user constraint; refusing to " +
        "report an empty denominator.",
    );
  }

  // ── INDIRECT: breadth-first over ownership-preserving edges. ───────────────
  // Breadth-first so `hops` is the SHORTEST ownership path, and each level is
  // walked in sorted order so the recorded path is deterministic.
  let frontier = names.filter((n) => linkClass.get(n) === "DIRECT_USER_LINKED");
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const owned = new Set(frontier);
    const next: string[] = [];
    for (const name of names) {
      if (linkClass.has(name) && CLASS_RANK[linkClass.get(name)!] >= CLASS_RANK.INDIRECT_USER_LINKED) continue;
      const t = facts.get(name)!;
      const edges = t.foreignKeys
        .filter((fk) => fk.references.startsWith("public."))
        .map((fk) => ({ fk, parent: fk.references.slice("public.".length) }))
        .filter((e) => e.parent !== name && owned.has(e.parent))
        .filter((e) => isOwnershipPreserving(t, e.fk))
        .sort((a, b) => (a.parent + a.fk.columns.join()).localeCompare(b.parent + b.fk.columns.join()));
      if (edges.length === 0) continue;
      const e = edges[0];
      assign(name, "INDIRECT_USER_LINKED");
      hops.set(name, depth);
      paths.set(name, [name, ...(paths.get(e.parent) ?? [e.parent])]);
      addReason(
        name,
        `ownership-preserving FOREIGN KEY ${e.fk.constraint} (${e.fk.columns.join(", ")}) REFERENCES ` +
          `public.${e.parent} ON DELETE ${e.fk.onDelete} — ${e.parent} is user-linked, ` +
          `so these rows belong to that row's owner (hops = ${depth})`,
      );
      next.push(name);
    }
    frontier = next;
  }

  // ── The remaining evidence, weakest last. ─────────────────────────────────
  for (const name of names) {
    const t = facts.get(name)!;
    const settled = CLASS_RANK[linkClass.get(name) ?? "NOT_USER_LINKED"] >= CLASS_RANK.INDIRECT_USER_LINKED;

    // DERIVED (a): a curated user column that no FK backs.
    const fkBacked = new Set(t.foreignKeys.flatMap((fk) => fk.columns));
    const rootBacked = new Set(
      t.foreignKeys.filter((fk) => rootRefs.has(fk.references)).flatMap((fk) => fk.columns),
    );
    const unbackedCurated = t.columns
      .filter((c) => curated.has(c.name) && !fkBacked.has(c.name))
      .map((c) => c.name);
    if (unbackedCurated.length > 0) {
      assign(name, "DERIVED_USER_LINKED");
      if (!settled) {
        addReason(
          name,
          `column(s) ${unbackedCurated.join(", ")} are on the curated USER_IDENTIFYING_COLUMNS list and ` +
            `declare NO foreign key — a user's uuid stored without a constraint`,
        );
      }
    }

    // AMBIGUOUS (a0): a curated user column whose FK points somewhere that is NOT
    // a user root. The NAME says account, the CONSTRAINT says otherwise, and the
    // schema does not settle which is right. This case is the reason the class
    // exists at all: without it a table the old column-name denominator DID see
    // could fall out of the corrected one, which would be a regression wearing
    // the costume of an improvement.
    const contradictedCurated = t.columns
      .filter((c) => curated.has(c.name) && fkBacked.has(c.name) && !rootBacked.has(c.name))
      .map((c) => c.name);
    if (contradictedCurated.length > 0) {
      assign(name, "AMBIGUOUS");
      if (CLASS_RANK[linkClass.get(name)!] === CLASS_RANK.AMBIGUOUS) {
        addReason(
          name,
          `column(s) ${contradictedCurated.join(", ")} are on the curated USER_IDENTIFYING_COLUMNS list but ` +
            `their foreign key does NOT reference public.profiles or auth.users — the name and the ` +
            `constraint disagree and the schema does not settle it`,
        );
      }
    }

    // AMBIGUOUS (a): a uuid column NAMED like a person, with no FK behind it.
    const hinted = t.columns
      .filter((c) => !fkBacked.has(c.name) && !curated.has(c.name))
      .filter((c) => UUID_TYPE_RE.test(c.type) && USER_NAME_HINT_RE.test(c.name))
      .map((c) => c.name);
    if (hinted.length > 0) {
      assign(name, "AMBIGUOUS");
      if (CLASS_RANK[linkClass.get(name)!] === CLASS_RANK.AMBIGUOUS) {
        addReason(
          name,
          `uuid column(s) ${hinted.join(", ")} are named like a person reference but declare no foreign ` +
            `key — the schema can neither confirm nor deny that these are account identifiers`,
        );
      }
    }

    // AMBIGUOUS (b): reachable, but only across edges that do not carry ownership.
    if (!settled) {
      const refOnly = t.foreignKeys
        .filter((fk) => fk.references.startsWith("public."))
        .map((fk) => ({ fk, parent: fk.references.slice("public.".length) }))
        .filter((e) => e.parent !== name)
        .filter((e) => CLASS_RANK[linkClass.get(e.parent) ?? "NOT_USER_LINKED"] >= CLASS_RANK.INDIRECT_USER_LINKED)
        .filter((e) => !isOwnershipPreserving(t, e.fk));
      if (refOnly.length > 0) {
        assign(name, "AMBIGUOUS");
        if (CLASS_RANK[linkClass.get(name)!] === CLASS_RANK.AMBIGUOUS) {
          addReason(
            name,
            `reaches user-linked table(s) ${[...new Set(refOnly.map((e) => e.parent))].sort().join(", ")} only ` +
              `through NULLABLE non-cascading foreign key(s) ${refOnly.map((e) => e.fk.constraint).join(", ")} — ` +
              `a reference, not ownership`,
          );
        }
      }
    }
  }

  // ── Manual registration: always keeps a table in the universe, and never
  // overwrites what the SCHEMA says about how it is linked.
  //
  // A hand registration proves a table is IN SCOPE — a legal-retention row
  // somebody wrote down cannot fall out of the universe because the schema
  // stopped mentioning it. It does not prove HOW the link is made, so it lifts a
  // table out of NOT_USER_LINKED and stops there. In particular it must not
  // promote an AMBIGUOUS table to DERIVED: "the schema cannot confirm this link"
  // stays true no matter who added the row to a list, and letting a registration
  // erase it would empty the one class whose job is to keep unconfirmed
  // ownership visible.
  for (const [name, bucket] of registrations) {
    if (!facts.has(name) && !extras.includes(name)) continue;
    if ((linkClass.get(name) ?? "NOT_USER_LINKED") === "NOT_USER_LINKED") {
      assign(name, "DERIVED_USER_LINKED");
    }
    addReason(name, `registered by hand in deletionDispositions.${bucket}`);
  }
  for (const name of extras) {
    assign(name, "DERIVED_USER_LINKED");
    if ((reasons.get(name) ?? []).length === 0) {
      addReason(name, "post-baseline table carried by the manifest; the dump predates it, so there is no schema evidence either way");
    }
  }

  const out = new Map<string, UserLinkFact>();
  for (const name of [...names, ...extras].sort()) {
    const cls = linkClass.get(name) ?? "NOT_USER_LINKED";
    const why =
      reasons.get(name) ??
      (facts.has(name)
        ? [
            "no foreign key to public.profiles or auth.users, no ownership-preserving path to a user-linked " +
              "table, no curated user column, no person-named uuid column, and no manual registration",
          ]
        : ["not present in the baseline dump and not registered anywhere"]);
    out.set(name, {
      table: name,
      linkClass: cls,
      reasons: why,
      hops: hops.get(name) ?? null,
      path: paths.get(name) ?? [],
      governed: cls !== "NOT_USER_LINKED",
      inBaseline: facts.has(name),
    });
  }
  return out;
}

export interface UserLinkCounts {
  TOTAL_APPLICATION_TABLES: number;
  DIRECT_USER_LINKED: number;
  INDIRECT_USER_LINKED: number;
  DERIVED_USER_LINKED: number;
  NOT_USER_LINKED: number;
  AMBIGUOUS: number;
  /** DIRECT + INDIRECT + DERIVED + AMBIGUOUS — the deletion denominator. */
  GOVERNED: number;
}

export function userLinkCounts(links: Map<string, UserLinkFact> | Iterable<UserLinkFact>): UserLinkCounts {
  const all = links instanceof Map ? [...links.values()] : [...links];
  const counts: UserLinkCounts = {
    TOTAL_APPLICATION_TABLES: all.length,
    DIRECT_USER_LINKED: 0,
    INDIRECT_USER_LINKED: 0,
    DERIVED_USER_LINKED: 0,
    NOT_USER_LINKED: 0,
    AMBIGUOUS: 0,
    GOVERNED: 0,
  };
  for (const f of all) {
    counts[f.linkClass] = counts[f.linkClass] + 1;
    if (f.governed) counts.GOVERNED += 1;
  }
  return counts;
}
