/**
 * Identity-verification MARKET COVERAGE — "can this provider verify anyone here
 * at all?", answered fail-closed.
 *
 * ── THE OWNER DECISION THIS IMPLEMENTS ───────────────────────────────────────
 *   "Use Sumsub as the primary identity provider behind the provider interface.
 *    Verify market coverage; fail closed and keep bookings unavailable where
 *    suitable verification is unsupported."
 *
 * and, on the same choice:
 *
 *   "Sumsub is my pick for the primary identity provider because it documents
 *    support for 220+ countries and territories, but that is not literally
 *    universal; check coverage for each market and keep the feature unavailable
 *    where valid verification cannot be provided."
 *
 * The second sentence is the whole of this file. "220+ countries" is a
 * MARKETING FIGURE and it is deliberately not written anywhere in this module:
 * a hardcoded number cannot tell you whether the market in front of you is one
 * of them, and a list transcribed from a web page into TypeScript is a claim
 * about the vendor that nothing can check. So coverage is a DATA INPUT with a
 * declared seam, and the seam is EMPTY in this commit.
 *
 * ── WHAT THAT MEANS TODAY ────────────────────────────────────────────────────
 * With no manifest mounted, EVERY market resolves `unknown` and every booking
 * that consults this module is refused. That is the intended resting state. The
 * alternative — "we could not read the coverage list, so assume it is fine" —
 * is the exact fail-open this product cannot afford: the one place where a
 * wrong answer admits an unverified stranger to a paid in-person meeting.
 *
 * ── AN UNREADABLE LIST IS NOT AN EMPTY LIST, AND NEITHER IS A PASS ───────────
 * Six distinct ways the source can fail to be usable, each with its own code
 * and all of them refusing:
 *
 *   coverage_source_undeclared   no coverage source is declared for this
 *                                provider at all
 *   coverage_source_absent       the declared file is not there
 *   coverage_source_unreadable   it is there and could not be READ (I/O, EACCES,
 *                                a directory where a file was expected)
 *   coverage_source_malformed    read, but not JSON / not the declared shape /
 *                                a country code that is not alpha-2
 *   coverage_source_empty        valid JSON, valid shape, ZERO supported markets
 *   coverage_source_conflicting  a market listed as both supported and not
 *
 * `empty` is called out separately because it is the one an "if (!list.length)"
 * reader is most likely to collapse into "no coverage, carry on". A provider
 * that supports nowhere is not a coverage answer, it is a broken file.
 *
 * `provider_mismatch` is a seventh: a manifest for one vendor mounted while
 * another is configured. Reading Stripe's coverage to decide Sumsub's reach is
 * a fabricated answer, so it refuses rather than guessing.
 *
 * ── WHAT WOULD POPULATE IT ───────────────────────────────────────────────────
 * One JSON file, named by `IDENTITY_COVERAGE_MANIFEST` (or found at the
 * conventional path below), containing the supported-market list for the
 * CONFIGURED provider AT THE VERIFICATION LEVEL Portava uses — exported from
 * the vendor's own per-country document-type coverage for that level, with the
 * revision and the date it was taken. For Sumsub that is the per-country
 * supported-document matrix for the configured `levelName`, which is visible in
 * the Sumsub dashboard and in their coverage documentation and is therefore an
 * operator export, not something this repository can synthesise offline. There
 * is no public, unauthenticated coverage endpoint this adapter could call, and
 * calling anything at all was out of scope for this change (no credentials, no
 * live API calls), so the file is the seam and its absence is a refusal.
 *
 * Shape (see `parseCoverageManifest` for the enforced version):
 *
 *   {
 *     "provider": "sumsub",
 *     "level": "id_selfie",
 *     "revision": "2026-10-04-basic-kyc-level",
 *     "retrievedAt": "2026-10-04T00:00:00.000Z",
 *     "supported":   ["PH", "US", "GB"],
 *     "unsupported": ["KP"]
 *   }
 *
 * ── WHY THIS IS NOT ON `IdentityVerificationProvider` ────────────────────────
 * The provider interface in types.ts has four methods and they are all about
 * one person's one verification attempt. Coverage is a property of the MARKET,
 * is needed BEFORE any session exists, and is consulted by the booking gate,
 * which holds no provider object. Adding a fifth method to suit one vendor
 * would have widened the interface every other adapter must satisfy for a
 * question none of them is asked. So the registry below is keyed by provider
 * NAME and lives beside the adapters rather than inside them.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── the shape of an answer ───────────────────────────────────────────────────

export type MarketCoverageStatus = "supported" | "unsupported" | "unknown";

export type CoverageSourceFailure =
  | "coverage_source_undeclared"
  | "coverage_source_absent"
  | "coverage_source_unreadable"
  | "coverage_source_malformed"
  | "coverage_source_empty"
  | "coverage_source_conflicting"
  | "coverage_source_provider_mismatch";

export type MarketCoverageCode =
  | CoverageSourceFailure
  /** No market was supplied — "we did not ask" is not "it is fine". */
  | "market_not_supplied"
  /** Supplied, but not an ISO 3166-1 alpha-2 code we can look up. */
  | "market_malformed"
  /** The source was readable and this market is in NEITHER list. */
  | "market_not_listed"
  /** The source names this market as not supported. */
  | "market_excluded"
  /** The source names this market as supported. */
  | "market_supported"
  /** This provider is not market-scoped (the mock). */
  | "provider_not_market_scoped";

export interface MarketCoverageDecision {
  status: MarketCoverageStatus;
  /** Normalized alpha-2 market, or null when none could be read. */
  market: string | null;
  code: MarketCoverageCode;
  /** Operator-facing explanation. Never contains a key or a manifest path's contents. */
  reason: string;
  /** Manifest revision when one was readable — so a refusal can be traced to a file version. */
  revision?: string;
}

// ── the declared seam ────────────────────────────────────────────────────────

export type CoverageRequirement =
  | { kind: "manifest"; envVar: string; defaultPath: string }
  | { kind: "not_market_scoped"; why: string };

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Conventional location for the mounted coverage manifest. NOT present in this commit. */
export const DEFAULT_COVERAGE_MANIFEST_PATH = resolve(
  PKG_ROOT,
  "coverage/identity-market-coverage.json",
);

/** Env var naming the manifest, overriding the conventional path. */
export const COVERAGE_MANIFEST_ENV = "IDENTITY_COVERAGE_MANIFEST";

/**
 * Coverage requirement per provider name.
 *
 * A provider ABSENT from this map is `coverage_source_undeclared` and therefore
 * refuses — including `stripe` and `persona`. That is deliberate and it is the
 * fail-closed direction: both of those vendors really do have per-country
 * limits (Stripe has a documented `country_not_supported` error), nobody has
 * exported their coverage either, and neither is reachable today because
 * `readiness.IMPLEMENTED_PROVIDERS` excludes them. Listing them as
 * `not_market_scoped` to keep a notional path open would have been a claim that
 * they verify everywhere, which is false.
 */
const COVERAGE_REQUIREMENTS: Record<string, CoverageRequirement> = {
  // The mock is a local test double. It is refused outright in production and
  // in any hosted deployment by `mockIdentityPermitted` (lib/paymentsMode.ts),
  // so it never decides a real booking, and giving it a coverage manifest would
  // mean inventing one.
  mock: {
    kind: "not_market_scoped",
    why: "the mock provider is a local test double and is refused in production and hosted deployments",
  },
  sumsub: {
    kind: "manifest",
    envVar: COVERAGE_MANIFEST_ENV,
    defaultPath: DEFAULT_COVERAGE_MANIFEST_PATH,
  },
};

export function coverageRequirementFor(provider: string): CoverageRequirement | null {
  return COVERAGE_REQUIREMENTS[provider.toLowerCase()] ?? null;
}

// ── the manifest ─────────────────────────────────────────────────────────────

export interface CoverageManifest {
  provider: string;
  /** The verification level the list was exported for, e.g. `id_selfie`. */
  level: string;
  revision: string;
  retrievedAt: string;
  supported: ReadonlySet<string>;
  unsupported: ReadonlySet<string>;
}

export type CoverageSourceOutcome =
  | { ok: true; manifest: CoverageManifest }
  | { ok: false; failure: CoverageSourceFailure; detail: string };

/**
 * Filesystem seam, injected by tests. Deliberately two calls rather than one
 * "read or null": a file that is NOT THERE and a file that could not be READ
 * are different answers and a single nullable read cannot tell them apart.
 */
export interface CoverageSourceIo {
  exists(path: string): boolean;
  readText(path: string): string;
}

export const nodeCoverageIo: CoverageSourceIo = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, "utf8"),
};

const ALPHA2 = /^[A-Z]{2}$/;

/**
 * Normalize one market code. Returns null for anything that is not a plain
 * alpha-2 string — including `"usa"`, `""`, `"  "`, numbers and nested objects.
 *
 * Lower case IS accepted and upper-cased: ISO 3166-1 alpha-2 is case-insensitive
 * in practice and every vendor emits a different case. A code with surrounding
 * whitespace is accepted too, because manifests are hand-exported.
 */
export function normalizeMarket(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return ALPHA2.test(trimmed) ? trimmed : null;
}

/**
 * Validate and parse a manifest body. Pure — takes the text, returns an outcome.
 *
 * EVERY malformed entry is a refusal of the WHOLE FILE, not a dropped row. A
 * parser that skips what it cannot read silently narrows coverage, and a
 * silently narrowed coverage list is a coverage list nobody can audit; the
 * operator has to know the export is broken.
 */
export function parseCoverageManifest(
  text: string,
  expectedProvider: string,
): CoverageSourceOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failure: "coverage_source_malformed", detail: "not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, failure: "coverage_source_malformed", detail: "not a JSON object" };
  }
  const body = parsed as Record<string, unknown>;

  const provider = typeof body["provider"] === "string" ? body["provider"].trim().toLowerCase() : "";
  if (!provider) {
    return { ok: false, failure: "coverage_source_malformed", detail: "no `provider`" };
  }
  if (provider !== expectedProvider.toLowerCase()) {
    return {
      ok: false,
      failure: "coverage_source_provider_mismatch",
      detail: `manifest declares provider "${provider}", configured provider is "${expectedProvider.toLowerCase()}"`,
    };
  }

  const level = typeof body["level"] === "string" ? body["level"].trim() : "";
  if (!level) {
    return { ok: false, failure: "coverage_source_malformed", detail: "no `level`" };
  }
  const revision = typeof body["revision"] === "string" ? body["revision"].trim() : "";
  if (!revision) {
    return { ok: false, failure: "coverage_source_malformed", detail: "no `revision`" };
  }
  const retrievedAtRaw = body["retrievedAt"];
  if (typeof retrievedAtRaw !== "string" || Number.isNaN(Date.parse(retrievedAtRaw))) {
    return { ok: false, failure: "coverage_source_malformed", detail: "`retrievedAt` is not a date" };
  }

  const supportedRaw = body["supported"];
  if (!Array.isArray(supportedRaw)) {
    return { ok: false, failure: "coverage_source_malformed", detail: "`supported` is not an array" };
  }
  const unsupportedRaw = body["unsupported"] === undefined ? [] : body["unsupported"];
  if (!Array.isArray(unsupportedRaw)) {
    return { ok: false, failure: "coverage_source_malformed", detail: "`unsupported` is not an array" };
  }

  const supported = new Set<string>();
  for (const entry of supportedRaw) {
    const code = normalizeMarket(entry);
    if (code === null) {
      return {
        ok: false,
        failure: "coverage_source_malformed",
        detail: "`supported` holds an entry that is not an ISO 3166-1 alpha-2 code",
      };
    }
    supported.add(code);
  }
  const unsupported = new Set<string>();
  for (const entry of unsupportedRaw) {
    const code = normalizeMarket(entry);
    if (code === null) {
      return {
        ok: false,
        failure: "coverage_source_malformed",
        detail: "`unsupported` holds an entry that is not an ISO 3166-1 alpha-2 code",
      };
    }
    unsupported.add(code);
  }

  if (supported.size === 0) {
    return {
      ok: false,
      failure: "coverage_source_empty",
      detail: "`supported` is empty — a provider that covers nowhere is a broken export, not an answer",
    };
  }
  for (const code of unsupported) {
    if (supported.has(code)) {
      return {
        ok: false,
        failure: "coverage_source_conflicting",
        detail: `"${code}" is listed as both supported and unsupported`,
      };
    }
  }

  return {
    ok: true,
    manifest: { provider, level, revision, retrievedAt: retrievedAtRaw, supported, unsupported },
  };
}

/**
 * Load the coverage source for a provider. Never throws.
 *
 * NOT CACHED, on purpose. A cache here would have to decide what to do with a
 * FAILED load, and both answers are wrong: caching the failure makes a mounted
 * manifest invisible until a restart, and not caching it while caching successes
 * means the hot path alternates between two policies. The read is a local file
 * behind a gate that already does database work, and the gate is unreachable
 * today, so there is nothing to optimise yet. If that changes, cache SUCCESSES
 * keyed by path + mtime and leave failures uncached.
 */
export function loadCoverageSource(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  io: CoverageSourceIo = nodeCoverageIo,
): CoverageSourceOutcome {
  const requirement = coverageRequirementFor(provider);
  if (requirement === null) {
    return {
      ok: false,
      failure: "coverage_source_undeclared",
      detail: `no coverage source is declared for provider "${provider.toLowerCase()}"`,
    };
  }
  if (requirement.kind === "not_market_scoped") {
    // Callers must check `coverageRequirementFor` first; reaching here means a
    // caller asked for a manifest a provider does not have. Refusing is the
    // only safe answer a loader can give.
    return {
      ok: false,
      failure: "coverage_source_undeclared",
      detail: `provider "${provider.toLowerCase()}" is not market-scoped and has no manifest`,
    };
  }

  const configured = env[requirement.envVar];
  const path =
    typeof configured === "string" && configured.trim().length > 0
      ? configured.trim()
      : requirement.defaultPath;

  let exists: boolean;
  try {
    exists = io.exists(path);
  } catch {
    // An `exists` that throws (a permission error on a parent directory) is an
    // I/O failure, not an absence.
    return { ok: false, failure: "coverage_source_unreadable", detail: "coverage manifest could not be stat'ed" };
  }
  if (!exists) {
    return {
      ok: false,
      failure: "coverage_source_absent",
      detail: `no coverage manifest at the configured location (${requirement.envVar} or the conventional path)`,
    };
  }

  let text: string;
  try {
    text = io.readText(path);
  } catch {
    return { ok: false, failure: "coverage_source_unreadable", detail: "coverage manifest could not be read" };
  }
  return parseCoverageManifest(text, provider);
}

// ── resolution ───────────────────────────────────────────────────────────────

const SOURCE_FAILURE_REASON: Record<CoverageSourceFailure, string> = {
  coverage_source_undeclared: "no market-coverage source is declared for the configured identity provider",
  coverage_source_absent: "the market-coverage manifest is not mounted",
  coverage_source_unreadable: "the market-coverage manifest could not be read",
  coverage_source_malformed: "the market-coverage manifest is not in the declared shape",
  coverage_source_empty: "the market-coverage manifest lists no supported market",
  coverage_source_conflicting: "the market-coverage manifest contradicts itself",
  coverage_source_provider_mismatch: "the mounted market-coverage manifest is for a different provider",
};

/**
 * Resolve one market against an already-loaded source. PURE — no I/O, no env.
 *
 * Every branch that is not "the source said yes" returns `unknown` or
 * `unsupported`, and the caller must treat both as unavailable. There is no
 * fourth state and no optional-boolean shape, because an `available?: boolean`
 * a caller forgets to read defaults to falsy-but-unexamined, and the whole
 * point of this module is that forgetting must refuse.
 */
export function resolveMarketCoverage(
  market: unknown,
  source: CoverageSourceOutcome,
): MarketCoverageDecision {
  const normalized = normalizeMarket(market);

  if (!source.ok) {
    return {
      status: "unknown",
      market: normalized,
      code: source.failure,
      reason: `${SOURCE_FAILURE_REASON[source.failure]} (${source.detail})`,
    };
  }

  const { manifest } = source;

  // The source is readable, so the market itself is now the question. Order
  // matters only in that a missing market can never be looked up.
  if (market === undefined || market === null || (typeof market === "string" && market.trim() === "")) {
    return {
      status: "unknown",
      market: null,
      code: "market_not_supplied",
      reason: "no market was supplied, so coverage could not be checked",
      revision: manifest.revision,
    };
  }
  if (normalized === null) {
    return {
      status: "unknown",
      market: null,
      code: "market_malformed",
      reason: "the supplied market is not an ISO 3166-1 alpha-2 code",
      revision: manifest.revision,
    };
  }

  if (manifest.unsupported.has(normalized)) {
    return {
      status: "unsupported",
      market: normalized,
      code: "market_excluded",
      reason: `the identity provider's coverage list names ${normalized} as not supported at level ${manifest.level}`,
      revision: manifest.revision,
    };
  }
  if (manifest.supported.has(normalized)) {
    return {
      status: "supported",
      market: normalized,
      code: "market_supported",
      reason: `covered at level ${manifest.level}`,
      revision: manifest.revision,
    };
  }
  // NOT IN THE LIST IS NOT SUPPORTED. A readable manifest that does not mention
  // a market is the ordinary case for the markets the vendor's "220+" does not
  // reach, and it is the single most important branch in this file.
  return {
    status: "unknown",
    market: normalized,
    code: "market_not_listed",
    reason: `${normalized} does not appear in the identity provider's coverage list for level ${manifest.level}`,
    revision: manifest.revision,
  };
}

// ── the one call the booking gate makes ──────────────────────────────────────

export interface MarketAvailability {
  /** True ONLY when a market-scoped provider's coverage list says yes, or the provider is not market-scoped. */
  available: boolean;
  provider: string;
  market: string | null;
  status: MarketCoverageStatus;
  code: MarketCoverageCode;
  reason: string;
  revision?: string;
}

/**
 * "May identity verification be relied on for this market?" Never throws.
 *
 * A provider that is not market-scoped (the mock) answers `available: true`
 * with `provider_not_market_scoped` — that is what keeps local development and
 * the test suite working, and it is safe because such a provider cannot be
 * selected in production at all.
 */
export function identityMarketAvailability(
  provider: string,
  market: unknown,
  env: NodeJS.ProcessEnv = process.env,
  io: CoverageSourceIo = nodeCoverageIo,
): MarketAvailability {
  const name = provider.toLowerCase();
  const requirement = coverageRequirementFor(name);

  if (requirement !== null && requirement.kind === "not_market_scoped") {
    return {
      available: true,
      provider: name,
      market: normalizeMarket(market),
      status: "supported",
      code: "provider_not_market_scoped",
      reason: requirement.why,
    };
  }

  const decision = resolveMarketCoverage(market, loadCoverageSource(name, env, io));
  const result: MarketAvailability = {
    available: decision.status === "supported",
    provider: name,
    market: decision.market,
    status: decision.status,
    code: decision.code,
    reason: decision.reason,
  };
  if (decision.revision !== undefined) result.revision = decision.revision;
  return result;
}
