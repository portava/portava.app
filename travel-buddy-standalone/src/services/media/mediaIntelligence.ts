/**
 * mediaIntelligence — how the client reads what the server concluded about a
 * place's CURRENT picture (spec §12 / §18; census-media MD323).
 *
 * The server's §18 pipeline ends in a Visual Consensus on every place
 * projection (artifacts/api-server/src/services/media/MediaConsensusService.ts):
 * how many INDEPENDENT sources witnessed the place inside the FRESH window, the
 * worst conflict on its live claims, and — only on a material conflict — the
 * spec's "Mixed reports — conditions may be changing". The client dropped all
 * of it, and drew its "current picture" strength from the independent-source
 * count over EVERY perspective the place has, of any age: three sources from
 * last month rendered as a strong CURRENT picture.
 *
 * This module is the one place the client turns that server conclusion into
 * what a screen shows. Its rules only ever lower confidence:
 *
 *   • Strength comes from FRESH independent witnesses when the consensus is
 *     present. A material dispute caps it at 'low' — four agreeing photographs
 *     do not settle a disputed live claim (the server orders it the same way).
 *   • The uncertainty banner shows exactly when the server says the reports
 *     disagree. The client never invents one and never drops one.
 *   • An unreadable consensus is treated as ABSENT, and an absent consensus
 *     (an older server) leaves the previous behaviour exactly as it was.
 *
 * Pure — no imports beyond types — safe for node:test.
 */
import type { ConfidenceState } from '../../features/media/types/media.ts';

/** §18's copy, verbatim — the fallback when a `mixed` consensus arrives without its label. */
export const MIXED_REPORTS_LABEL = 'Mixed reports — conditions may be changing';

export type ConsensusState = 'insufficient' | 'corroborated' | 'mixed';
export type CorroborationLevel = 'none' | 'single_source' | 'corroborated' | 'well_corroborated';

export interface VisualConsensusView {
  state: ConsensusState;
  corroboration: {
    level: CorroborationLevel;
    /** Perspectives inside the fresh window (raw count, not witnesses). */
    freshPerspectiveCount: number;
    /** Independent sources inside the fresh window. */
    independentSourceCount: number;
  };
  /** 'material' | 'minor' when live claims disagree; null when nothing does. */
  contradiction: 'material' | 'minor' | null;
  uncertaintyLabel: string | null;
  requestAnotherObservation: boolean;
}

const STATES: readonly ConsensusState[] = ['insufficient', 'corroborated', 'mixed'];
const LEVELS: readonly CorroborationLevel[] = ['none', 'single_source', 'corroborated', 'well_corroborated'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Read the server's `consensus` object. Null when absent or unreadable — never
 * a guessed consensus. A `contradiction` block whose state is not 'minor' reads
 * as 'material' (the server's own direction for an unrecognised conflict).
 */
export function mapVisualConsensus(raw: unknown): VisualConsensusView | null {
  if (!isObj(raw)) return null;
  const state = STATES.includes(raw.state as ConsensusState) ? (raw.state as ConsensusState) : null;
  if (!state) return null;
  const c = isObj(raw.corroboration) ? raw.corroboration : {};
  const level = LEVELS.includes(c.level as CorroborationLevel) ? (c.level as CorroborationLevel) : 'none';
  const contradiction = isObj(raw.contradiction)
    ? raw.contradiction.state === 'minor'
      ? 'minor'
      : 'material'
    : null;
  const label = typeof raw.uncertaintyLabel === 'string' && raw.uncertaintyLabel.trim() ? raw.uncertaintyLabel : null;
  return {
    state,
    corroboration: {
      level,
      freshPerspectiveCount: count(c.freshPerspectiveCount),
      independentSourceCount: count(c.independentSourceCount),
    },
    contradiction,
    uncertaintyLabel: label,
    requestAnotherObservation: raw.requestAnotherObservation === true,
  };
}

const RANK: Record<ConfidenceState, number> = { low: 0, moderate: 1, strong: 2 };

function strengthFromFreshLevel(level: CorroborationLevel): ConfidenceState {
  if (level === 'well_corroborated') return 'strong';
  if (level === 'corroborated') return 'moderate';
  return 'low';
}

/**
 * The current picture's strength and source count, as the badge shows them.
 * With a consensus: the FRESH witnesses (strength and count), capped at 'low'
 * under a material dispute, and never above what the legacy all-ages count
 * already said. Without one: the legacy values, unchanged.
 */
export function currentPictureFromConsensus(
  consensus: VisualConsensusView | null,
  legacy: { strength: ConfidenceState; sourceCount: number },
): { strength: ConfidenceState; sourceCount: number } {
  if (!consensus) return legacy;
  let strength = strengthFromFreshLevel(consensus.corroboration.level);
  if (consensus.state === 'mixed' || consensus.contradiction === 'material') strength = 'low';
  if (RANK[strength] > RANK[legacy.strength]) strength = legacy.strength;
  return { strength, sourceCount: consensus.corroboration.independentSourceCount };
}

/** The §18 uncertainty line, or null. Shown exactly when the server says reports disagree. */
export function uncertaintyBanner(consensus: VisualConsensusView | null): string | null {
  if (!consensus) return null;
  if (consensus.uncertaintyLabel) return consensus.uncertaintyLabel;
  return consensus.state === 'mixed' ? MIXED_REPORTS_LABEL : null;
}
