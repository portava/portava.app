/**
 * rentaBuddyScanner.ts — pure keyword scanner for Rent a Buddy policy enforcement.
 *
 * No imports. No DB calls. Safe to import in tests without triggering module-load
 * side-effects (Supabase client init, environment variable checks, etc.).
 *
 * Exported from here; re-exported by rentABuddy.ts (which also has the DB-backed
 * scanForPolicyViolations and applyPolicySeverity wrappers).
 */

// ── Policy language ───────────────────────────────────────────────────────────

export const POLICY_TEXT =
  "Rent a Buddy is for travel companionship, city guidance, language support, local help, social exploration, shopping, nightlife guidance, content help, and arrival support only. It is not a dating, escort, adult, romantic, sexual, or illegal-service feature. Requests or offers that violate this policy may lead to account review, suspension, removal, and Trust Score penalties.";

// ── Private meetup location blocklist ────────────────────────────────────────

export const PRIVATE_LOCATION_PATTERNS: RegExp[] = [
  /private\s+hotel\s+room/i,
  /come\s+to\s+my\s+room/i,
  /\bmy\s+room\b/i,
  /hotel\s+room/i,
  /\bmy\s+place\b/i,
  /my\s+apartment/i,
  /my\s+airbnb/i,
  /\bmy\s+home\b/i,
  /private\s+home/i,
];

export function isPrivateLocation(text: string): boolean {
  return PRIVATE_LOCATION_PATTERNS.some((p) => p.test(text));
}

// ── Category risk levels ──────────────────────────────────────────────────────

export const CATEGORY_RISK_LEVELS: Record<string, "low" | "medium" | "high"> = {
  arrival:   "high",
  nightlife: "high",
  adventure: "medium",
  wellness:  "medium",
  city:      "low",
  language:  "low",
  food:      "low",
  shopping:  "low",
  culture:   "low",
  content:   "low",
  nature:    "low",
  other:     "low",
};

export function getCategoryRiskLevel(category: string): "low" | "medium" | "high" {
  return CATEGORY_RISK_LEVELS[category] ?? "low";
}

// ── Policy keyword scanner ────────────────────────────────────────────────────

export interface PolicyMatch {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  excerpt: string;
}

export const POLICY_RULES: Array<{
  patterns: RegExp[];
  category: string;
  severity: "low" | "medium" | "high" | "critical";
}> = [
  {
    patterns: [/\bescort\b/i, /girlfriend\s+experience/i, /boyfriend\s+experience/i, /\bgfe\b/i, /\bbfe\b/i],
    category: "adult_service",
    severity: "critical",
  },
  {
    patterns: [/\badult\s+service/i, /\bsexual\s+service/i, /\bsex\s+work\b/i, /\bsex\b.*\bfor\s+hire\b/i],
    category: "adult_service",
    severity: "critical",
  },
  {
    patterns: [/\bprostitut/i, /\bcall\s+girl\b/i, /\bcall\s+boy\b/i, /\bsugarbaby\b/i, /\bsugar\s+baby\b/i],
    category: "adult_service",
    severity: "critical",
  },
  {
    patterns: [/\bmassage\s+with\s+(happy|happy[-\s]ending|extra|sexual)/i, /\bhappy\s+ending\b/i],
    category: "adult_massage",
    severity: "critical",
  },
  {
    patterns: [/\bmassage\b/i, /\bbody\s+rub\b/i],
    category: "massage_service",
    severity: "medium",
  },
  {
    patterns: [/\bhookup\b/i, /\bdate\s+me\b/i, /\bromantic\s+service/i, /\bromantic\s+companion/i, /\bintimate\s+time\b/i],
    category: "romantic_service",
    severity: "high",
  },
  {
    patterns: [/\bsex\b/i, /\bsexy\b/i],
    category: "explicit",
    severity: "high",
  },
  {
    patterns: [/\boff[-\s]?app\b/i, /\bpay\s+outside\b/i, /\bcash\s+only\b.*\boutside\b/i, /\bvenmo\s+me\b/i, /\bpaypal\s+me\b/i, /\bbank\s+transfer\s+only\b/i, /\bno\s+app\s+payment\b/i],
    category: "off_app_payment",
    severity: "high",
  },
  {
    patterns: [/\bdrugs?\b(?!\s+store)/i, /\bweed\b/i, /\bcocaine\b/i, /\bheroin\b/i, /\bmeth\b/i, /\bmdma\b/i, /\becstasy\b/i, /\bketamine\b/i, /\bsupply\s+drugs?\b/i],
    category: "drugs",
    severity: "high",
  },
  {
    patterns: [/\bweapon\b/i, /\bknife\b/i, /\bgun\b/i, /\bfirearm\b/i],
    category: "weapons",
    severity: "critical",
  },
  {
    patterns: [/\balone\s+in\s+my\s+room\b/i, /\bno\s+one\s+will\s+know\b/i, /\bkeep\s+this\s+between\s+us\b/i, /\bdon.t\s+tell\s+anyone\b/i],
    category: "grooming_language",
    severity: "high",
  },
];

export function scanText(text: string): PolicyMatch[] {
  const matches: PolicyMatch[] = [];
  const seen = new Set<string>();
  for (const rule of POLICY_RULES) {
    if (seen.has(rule.category)) continue;
    for (const pattern of rule.patterns) {
      const m = text.match(pattern);
      if (m) {
        matches.push({
          category: rule.category,
          severity: rule.severity,
          excerpt: text.substring(
            Math.max(0, (m.index ?? 0) - 20),
            (m.index ?? 0) + m[0].length + 20,
          ),
        });
        seen.add(rule.category);
        break;
      }
    }
  }
  return matches;
}

export function worstSeverity(matches: PolicyMatch[]): PolicyMatch | null {
  if (matches.length === 0) return null;
  const order: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
  return matches.reduce((a, b) => (order[a.severity] >= order[b.severity] ? a : b));
}
