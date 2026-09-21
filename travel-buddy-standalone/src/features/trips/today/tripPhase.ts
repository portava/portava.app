/**
 * Trips spec §3.2 — the active operational phase, and the screen that switches
 * on it (census-trips TR38–TR45).
 *
 * WHY THIS FILE EXISTS
 * ====================
 * §3.2 is a two-column table: eight phases, and for each one a PRIMARY UI /
 * BEHAVIOUR. The server has derived the phase and served §3.2's second column
 * verbatim since §40.4, and the census has held all eight rows at BUILT-BUT-
 * WRONG ever since for one stated reason: *"the row is derivation AND UI
 * switch, and no screen switches on it yet."* This is the switch.
 *
 * THE VOCABULARY WAS WRONG HERE, AND THAT IS A FINDING
 * ===================================================
 * `tripToday.ts` declared seven phases — FREE_TIME, ACTIVE_PLAN, TRANSIT,
 * LEAVE_BY_WINDOW, DISRUPTED, AT_RISK, REST. Three of them (LEAVE_BY_WINDOW,
 * AT_RISK, and the absent eighth) are values `TripOperationalPhase.ts` has
 * never emitted, and three the server DOES emit — ARRIVAL_DAY, NIGHTLIFE,
 * DEPARTURE_DAY — were missing. A client type describing a vocabulary
 * production never sends is a type that cannot catch a mistake. The eight
 * below are the server's, in the server's order.
 *
 * WHAT A PHASE IS ALLOWED TO DO
 * =============================
 * A phase REORDERS what the card leads with and, in two cases, SUPPRESSES.
 * It never invents content: every section is drawn from the projection the
 * card already read, and a section with nothing in it is not rendered. REST
 * suppresses opportunities because §3.2 says "suppress low-value
 * interruptions"; DISRUPTED deprioritises them because it says
 * "recovery-first ... entertainment/commercial surfaces are deprioritized".
 * Neither hides safety: the §17.2 banner is above all of this and is not a
 * phase's to move.
 *
 * §17.2 OUTRANKS THE PHASE, AND THIS WAS A REAL DEFECT
 * ===================================================
 * The first version of this file let NIGHTLIFE and FREE_TIME lead with
 * opportunities while the server's attention switch had `suppression.discovery`
 * set — the screen test for a SAFETY_EVENT caught it offering a museum during
 * an open safety event. A phase decides ORDER; the switch decides whether a
 * surface may appear at all, and it wins. The withholding is reported with the
 * server's own reason, never silently.
 */
import type { TripToday } from './tripToday.ts';

/** §3.2's eight, exactly as `domain/trips/services/TripOperationalPhase.ts` emits them. */
export const OPERATIONAL_PHASES = [
  'ARRIVAL_DAY', 'FREE_TIME', 'ACTIVE_PLAN', 'TRANSIT', 'NIGHTLIFE', 'REST', 'DEPARTURE_DAY', 'DISRUPTED',
] as const;
export type OperationalPhase = (typeof OPERATIONAL_PHASES)[number];

export function isOperationalPhase(v: unknown): v is OperationalPhase {
  return typeof v === 'string' && (OPERATIONAL_PHASES as readonly string[]).includes(v);
}

/** The card's renderable sections. Every one is a field of the projection. */
export const SECTION_KEYS = ['plan', 'commitment', 'windows', 'crew', 'opportunities', 'actions', 'health'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

export interface PhasePresentation {
  /** §3.2's second column, as this client would say it. The server's own `primaryFocus` is preferred when present. */
  focus: string;
  /** What this phase leads with, in order. */
  lead: SectionKey[];
  /** What this phase withholds, and why. */
  suppress: SectionKey[];
  suppressionReason: string | null;
}

const P: Record<OperationalPhase, PhasePresentation> = {
  ARRIVAL_DAY: {
    focus: 'Arrival logistics, accommodation, crew arrivals, payments/connectivity basics.',
    lead: ['actions', 'crew', 'commitment'], suppress: [], suppressionReason: null,
  },
  FREE_TIME: {
    focus: 'Temporal Freedom windows, Saved Ideas, nearby opportunities, social availability.',
    lead: ['windows', 'opportunities', 'crew'], suppress: [], suppressionReason: null,
  },
  ACTIVE_PLAN: {
    focus: 'Current activity, participants, next constraint, leave-by time if relevant.',
    lead: ['plan', 'commitment', 'crew'], suppress: [], suppressionReason: null,
  },
  TRANSIT: {
    focus: 'Route, destination, ETA, group progress, transport state.',
    lead: ['commitment', 'crew', 'plan'], suppress: [], suppressionReason: null,
  },
  NIGHTLIFE: {
    focus: 'Live vibe, crowd movement, queue/entry constraints, crew state, safe return.',
    lead: ['crew', 'opportunities', 'commitment'], suppress: [], suppressionReason: null,
  },
  REST: {
    focus: 'Suppress low-value interruptions and avoid aggressive recommendation churn.',
    lead: ['health', 'actions'], suppress: ['opportunities', 'windows'],
    suppressionReason: 'resting — low-value interruptions are suppressed (§3.2)',
  },
  DEPARTURE_DAY: {
    focus: 'Checkout, baggage, airport timing, remaining viable opportunities.',
    lead: ['commitment', 'actions', 'opportunities'], suppress: [], suppressionReason: null,
  },
  DISRUPTED: {
    focus: 'Recovery-first UX. Entertainment/commercial surfaces are deprioritized.',
    lead: ['health', 'actions', 'commitment'], suppress: ['opportunities'],
    suppressionReason: 'recovery first — entertainment and commercial surfaces are deprioritised (§3.2)',
  },
};

/**
 * What this phase leads with. An unknown or absent phase leads with nothing
 * and suppresses nothing: the card falls back to §11.2's five answers, which
 * is the order that holds when the phase is not known.
 */
export function phasePresentation(phase: unknown): PhasePresentation | null {
  return isOperationalPhase(phase) ? P[phase] : null;
}

export interface PhaseSection { key: SectionKey; label: string; detail: string }

const hhmm = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 16) : null;
};

/** The content of one section, drawn from the projection. Null when it has nothing to say. */
function section(key: SectionKey, t: TripToday): PhaseSection | null {
  switch (key) {
    case 'plan': {
      const p = t.currentPlan;
      if (!p) return null;
      return { key, label: 'Now', detail: `${p.title ?? 'a plan'}${p.locationName ? ` at ${p.locationName}` : ''}${p.status ? ` — ${p.status}` : ''}` };
    }
    case 'commitment': {
      const c = t.nextCommitment;
      if (!c) return null;
      const arrive = hhmm(c.arriveBy); const leave = hhmm(c.mustLeaveBy);
      return { key, label: 'Next', detail: `${c.type}${arrive ? `, arrive by ${arrive}` : ''}${leave ? ` — leave by ${leave}` : ' — leave-by unknown'}` };
    }
    case 'windows': {
      const w = t.freeWindows[0];
      if (!w) return null;
      return { key, label: 'Free', detail: `${w.durationMinutes} min until ${hhmm(w.endsAt) ?? 'later'}${w.certified ? '' : ' (not certified)'}` };
    }
    case 'crew': {
      const c = t.crewSummary;
      if (!c.featureEnabled) return null;
      const bits = [`${c.accepted} of ${c.total}`];
      if (c.liveSharing) bits.push(`${c.liveSharing} sharing`);
      if (c.safeReturnActive) bits.push(`${c.safeReturnActive} on safe return`);
      return { key, label: 'Crew', detail: bits.join(' · ') };
    }
    case 'opportunities': {
      if (t.opportunities.status !== 'ok' || t.opportunities.items.length === 0) return null;
      return { key, label: 'Could do', detail: `${t.opportunities.items.length} thing(s) — ${t.opportunities.items.slice(0, 2).map((o) => o.title ?? o.label ?? 'an idea').join(', ')}` };
    }
    case 'actions': {
      if (t.unresolvedActions.length === 0) return null;
      const critical = t.unresolvedActions.filter((u) => u.severity === 'critical').length;
      return { key, label: 'To sort out', detail: `${t.unresolvedActions.length} open${critical > 0 ? `, ${critical} critical` : ''} — ${t.unresolvedActions[0]!.detail}` };
    }
    case 'health': {
      if (t.health === 'HEALTHY' && t.healthReasons.length === 0) return null;
      return { key, label: 'State', detail: `${t.health}${t.healthReasons.length > 0 ? ` — ${t.healthReasons[0]!.detail}` : ''}` };
    }
    default:
      return null;
  }
}

export interface PhaseView {
  phase: OperationalPhase | null;
  /** The server's own words when it sent them; else this client's copy of §3.2's column. */
  focus: string | null;
  sections: PhaseSection[];
  /** Sections this phase withheld that WOULD have had content, and why. Never silent. */
  withheld: { key: SectionKey; reason: string }[];
}

/**
 * The phase block the card renders above §11.2's answers. Suppression is
 * REPORTED, not silent: a withheld section that had something to say is named
 * with the reason, because a card that quietly drops content and a card with
 * nothing to show look identical.
 */
export function phaseView(t: TripToday): PhaseView {
  const phase = isOperationalPhase(t.nowState.phase) ? t.nowState.phase : null;
  const pres = phase ? P[phase] : null;
  if (!pres) return { phase: null, focus: t.nowState.primaryFocus ?? null, sections: [], withheld: [] };
  const suppressed = new Map<SectionKey, string>();
  for (const k of pres.suppress) suppressed.set(k, pres.suppressionReason ?? 'suppressed by the phase');
  // §17.2 outranks §3.2: a switch that suppressed discovery suppresses it in
  // the phase block too, in the server's words.
  if (t.attention.suppression.discovery || t.attention.suppression.commercial) {
    suppressed.set('opportunities', t.attention.suppression.detail ?? t.attention.suppression.reason ?? `withheld by the ${t.attention.mode} switch (§17.2)`);
  }
  const sections = pres.lead
    .filter((k) => !suppressed.has(k))
    .map((k) => section(k, t))
    .filter((s): s is PhaseSection => s !== null);
  const withheld = [...suppressed.entries()]
    .filter(([k]) => section(k, t) !== null)
    .map(([key, reason]) => ({ key, reason }));
  return { phase, focus: t.nowState.primaryFocus ?? pres.focus, sections, withheld };
}

/** Is this section suppressed by the phase? The card asks before rendering anything below the block. */
export function phaseSuppresses(t: TripToday, key: SectionKey): boolean {
  if (key === 'opportunities' && (t.attention.suppression.discovery || t.attention.suppression.commercial)) return true;
  const pres = phasePresentation(t.nowState.phase);
  return pres ? pres.suppress.includes(key) : false;
}
