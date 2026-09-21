/**
 * Sensing S6 — "certify NO CLIENT TRUTH DUPLICATION" — and Sensing §6:
 *
 *   "Feature clients and React components must not independently calculate
 *    crowd, vibe, safety, opportunity, experience value or world-change state."
 *
 * The Wall census never counted this: it censused the Wall spec, and this
 * obligation reaches the Wall from the Sensing spec. It is a STRUCTURAL property
 * of the client tree — the kind that no unit test can catch and that decays the
 * moment someone adds "just a small threshold" on the device — so it is asserted
 * as a static ratchet over the source instead.
 *
 * WHAT IS FORBIDDEN. A client file under features/wall must not:
 *   • name a crowd / vibe / density / dance-likelihood / safety-score primitive,
 *     which would mean it is deriving one;
 *   • compare a confidence against a numeric floor, which is the §9/§108 gate's
 *     decision and belongs on the server;
 *   • re-derive a truth class from a source class or a cohort count.
 *
 * WHAT IS EXPLICITLY ALLOWED, and why it is not truth duplication:
 *   • comparing `validUntil` against the clock. §31 requires the client to
 *     DEGRADE a live label once its horizon passes. That is the client refusing
 *     to render a fact, never computing one — the strictly safe direction, and
 *     the server has already dropped the same fact on its own read path.
 *   • mapping a CARRIED `truthClass` to a word ("Scheduled", "Inferred"). The
 *     value is decided on the server; the client only renders it.
 *
 * MUTATION PROOF (verified: revert → RED, restore → GREEN)
 *   • add `const busy = confidence > 0.7;` to any Wall component → RED, naming
 *     the file and the line.
 *   • add a `crowdLevel` derivation to a Wall hook → RED.
 *   • point the scan at a directory with no files → RED (the guard proves it is
 *     actually reading something).
 *
 * It runs under JEST despite being a pure static scan: the tree's node:test
 * runner (`scripts/run-node-tests.mjs`) is what would normally host a file like
 * this, and `*.component.test.*` is the naming convention that routes a file to
 * jest instead. A ratchet that cannot execute is not a ratchet.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WALL_ROOT = join(process.cwd(), 'src', 'features', 'wall');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue; // the tests may name what they forbid
      sourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** Strip block and line comments so prose about a rule never trips the rule. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Rule {
  what: string;
  /** Matches a violation. */
  pattern: RegExp;
}

/**
 * Deriving world state on the device. These names exist ONLY as server-built
 * values on the wire; a client that spells one in an identifier or a literal is
 * computing it.
 */
const FORBIDDEN: Rule[] = [
  {
    what: 'a crowd / density derivation',
    pattern: /\b(crowdLevel|crowdState|densityLevel|computeCrowd|deriveCrowd)\b/,
  },
  {
    what: 'a vibe / energy derivation',
    pattern: /\b(vibeState|computeVibe|deriveVibe|danceLikelihood|dance_likelihood|energyLevel)\b/,
  },
  {
    what: 'a safety-state derivation',
    pattern: /\b(safetyScore|computeSafety|deriveSafety|isUnsafe)\b/,
  },
  {
    what: 'an opportunity / experience-value derivation',
    pattern: /\b(opportunityScore|experienceValue|computeOpportunity)\b/,
  },
  {
    what: 'a world-change / transition derivation',
    pattern: /\b(isHeatingUp|isPeaking|computeTransition|deriveTransition)\b/,
  },
  {
    what: 'a truth class re-derived from a source class or cohort size',
    pattern: /\b(deriveTruthClass|computeTruthClass|sourceClass\s*===|sourceCount\s*[<>=])/,
  },
  {
    // Any comparison of a confidence against a numeric floor, however it is
    // spelled — `item.confidence > 0.7`, `(c.confidence ?? 0) >= 0.5`. The §9
    // and §108 floors are the server's and re-deciding them here is exactly the
    // duplication S6 forbids.
    what: 'a confidence threshold — the §9 / §108 floors are the server’s',
    pattern: /\bconfidence\b[^\n]*[<>]=?\s*[01]?\.?\d/,
  },
  {
    what: 'a coverage threshold',
    pattern: /\bcoverage\b[^\n]*[<>]=?\s*[01]?\.?\d/,
  },
];

describe('Sensing S6 — the Wall client duplicates no server truth', () => {
  const files = sourceFiles(WALL_ROOT);

  it('the scan actually reads the Wall tree (guard against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(20);
    // The live strip is the surface most at risk — it must be in scope.
    expect(files.some((f) => f.endsWith('LiveForYouStrip.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('ContextThreadView.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('useWallFeed.ts'))).toBe(true);
  });

  it('no Wall client file calculates crowd, vibe, safety, opportunity or world-change state', () => {
    const violations: string[] = [];
    for (const file of files) {
      const body = code(readFileSync(file, 'utf8'));
      body.split('\n').forEach((line, i) => {
        for (const rule of FORBIDDEN) {
          if (rule.pattern.test(line)) {
            violations.push(`${file}:${i + 1} — ${rule.what}\n    ${line.trim()}`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('the rules are real: each one matches the thing it forbids', () => {
    // A ratchet whose patterns match nothing is worse than no ratchet.
    const samples: Array<[string, string]> = [
      ['const crowdLevel = busyCount > 3;', 'a crowd / density derivation'],
      ['const danceLikelihood = motion * 0.4;', 'a vibe / energy derivation'],
      ['const safetyScore = 1 - risk;', 'a safety-state derivation'],
      ['const opportunityScore = fit * freshness;', 'an opportunity / experience-value derivation'],
      ['const isPeaking = delta > 0;', 'a world-change / transition derivation'],
      ['if (item.confidence > 0.7) return "Live";', 'a confidence threshold'],
      ['const busy = (item.confidence ?? 0) >= 0.5;', 'a confidence threshold'],
      ['if (coverage >= 3) return "many";', 'a coverage threshold'],
      ['if (sourceCount >= 3) return "corroborated";', 'a truth class re-derived from a source class or cohort size'],
    ];
    for (const [sample, what] of samples) {
      const rule = FORBIDDEN.find((r) => r.pattern.test(sample));
      expect({ sample, caught: rule?.what.slice(0, 20) }).toEqual({
        sample,
        caught: what.slice(0, 20),
      });
    }
  });

  it('the ALLOWED degradations are still present — the client may refuse, never assert', () => {
    // §31: a passed freshness horizon degrades the label on the device. This is
    // the one clock comparison the client is supposed to make, and its absence
    // would be a different bug (a stale live label).
    const strip = readFileSync(join(WALL_ROOT, 'hooks', 'useLiveForYou.ts'), 'utf8');
    expect(strip).toMatch(/validUntil/);
  });
});
