/**
 * VERIFICATION LANE V3 — THE SEAM BETWEEN THE TWO TREES.
 *
 * `travel-buddy-standalone` is NOT in `pnpm-workspace.yaml`. It cannot import
 * from `artifacts/api-server` and `artifacts/api-server` cannot import from it.
 * So every enumeration and every ceiling that both halves need is written out
 * TWICE, by two lanes, with nothing but a comment holding them together.
 *
 * `voicePolicy.ts` names two of them and says why they matter: "a recorder that
 * stopped at 360 s would produce a file the send route refuses AFTER the
 * traveller had recorded six minutes." There are more than two, and the other
 * copies have no guard at all. This file is that guard.
 *
 * ── HOW IT WORKS, AND WHY IT LOOKS ODD ─────────────────────────────────────
 * The server's values cannot be IMPORTED, so they are READ FROM THE SERVER'S
 * SOURCE FILE AS TEXT and parsed. That is deliberate and is the only technique
 * available across this boundary: it needs no build of the other package, it
 * cannot be satisfied by a stale copy, and it fails loudly if the server file
 * moves or is renamed — which is itself a thing worth being told about, since a
 * moved file is how a "shared" constant stops being shared.
 *
 * Each extractor names the exact declaration it is reading. If the server
 * rewrites a list into a different shape, the extractor throws with the file
 * and the symbol, and that is a REAL failure: an unreadable server declaration
 * means this guard is no longer guarding, and a guard that silently stops
 * guarding is worse than no guard.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 * It does not execute a line of server code. It compares NAMES and NUMBERS. A
 * server that keeps `VOICE_MAX_DURATION_SECONDS = 300` and stops enforcing it
 * passes here — that is `artifacts/api-server/src/test/verifyFlowVoiceEndToEnd.test.ts`'s
 * job, and it drives the real route.
 *
 * It is a `.component.test.tsx` because that is the only jest pattern this
 * package runs; it renders nothing. `scripts/run-node-tests.mjs` discovers
 * `.test.ts` only, so a `.test.tsx` outside the component pattern would execute
 * in NEITHER runner — the orphan state `scripts/check-orphan-tests.mjs` exists
 * to make impossible.
 *
 * SHOWN RED before commit — see the foot of this file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  VOICE_MAX_DURATION_SECONDS,
  WAVEFORM_MAX_PEAKS,
  downsampleWaveform,
  isSendableRecording,
  recordingShouldStop,
} from '../voice/voicePolicy.ts';
import { DRAWER_TABS, ENVELOPE_KINDS, SENDABLE_KINDS } from '../kinds/kindsApi.ts';
import { rendersTypedKind } from '../kinds/TypedMessageRenderer.tsx';
import { COMPOSER_ENTRIES } from '../composer/composerMenu.ts';
import { TYPED_KIND_LABELS, typedKindPreviewLabel } from '../inbox/typedPreviewLabels.ts';

// ── reading the other tree ───────────────────────────────────────────────────

/** repo root — five levels up from `src/features/telegraph/__tests__`. */
const API = resolve(__dirname, '../../../../../artifacts/api-server/src');

function serverSource(relative: string): string {
  const path = resolve(API, relative);
  if (!existsSync(path)) {
    throw new Error(
      `The server file this guard compares against is not at ${path}. ` +
        `Either the path moved — in which case this guard has silently stopped ` +
        `guarding a duplicated constant and must be repointed — or the two trees ` +
        `are no longer checked out together.`,
    );
  }
  return readFileSync(path, 'utf8');
}

/** `export const NAME = <number>;` */
function serverNumber(relative: string, name: string): number {
  const src = serverSource(relative);
  const m = new RegExp(`export const ${name}\\s*=\\s*([0-9_]+)\\s*;`).exec(src);
  if (!m) {
    throw new Error(
      `Could not read \`export const ${name} = <number>\` from ${relative}. ` +
        `The declaration was rewritten, so this guard no longer compares anything — ` +
        `repoint it rather than deleting the case.`,
    );
  }
  return Number(m[1].replace(/_/g, ''));
}

/**
 * `const NAME = [ "A", "B", … ] as const;` — string members, in order.
 *
 * `export` is OPTIONAL on purpose: `SURFACE_VALUES` and `OUTCOME_VALUES` in
 * `routes/rankEvents.ts` are module-private, which is right — nothing else on
 * the server should be reading them — and is exactly why the client's copy has
 * no compile-time tie to them at all.
 */
function serverStringList(relative: string, name: string): string[] {
  const src = serverSource(relative);
  const m = new RegExp(`(?:export )?const ${name}(?::[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
  if (!m) {
    throw new Error(
      `Could not read \`const ${name} = [ … ]\` from ${relative}. ` +
        `The declaration was rewritten, so this guard no longer compares anything — ` +
        `repoint it rather than deleting the case.`,
    );
  }
  const out = [...m[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]);
  if (out.length === 0) {
    throw new Error(`\`${name}\` in ${relative} parsed to an EMPTY list — the guard would pass vacuously.`);
  }
  return out;
}

/** The members of a TypeScript string-literal union declared in THIS tree. */
function clientUnion(relative: string, typeName: string): string[] {
  const path = resolve(__dirname, relative);
  const src = readFileSync(path, 'utf8');
  const m = new RegExp(`(?:export )?type ${typeName}\\s*=\\s*([\\s\\S]*?);`).exec(src);
  if (!m) throw new Error(`Could not read \`type ${typeName}\` from ${relative}.`);
  const out = [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
  if (out.length === 0) throw new Error(`\`${typeName}\` in ${relative} parsed to an EMPTY union.`);
  return out;
}

// ── §6.2/§6.3 VOICE — the two ceilings that already had a comment ────────────

describe('the voice ceilings the recorder enforces are the ones the send route enforces', () => {
  it('VOICE_MAX_DURATION_SECONDS matches the server, exactly', () => {
    // The consequence of drift, from voicePolicy.ts's own header: a recorder
    // that stopped at 360 s would produce a file the send route refuses AFTER
    // the traveller had spoken for six minutes.
    expect(VOICE_MAX_DURATION_SECONDS).toBe(
      serverNumber('services/telegraph/voice.ts', 'VOICE_MAX_DURATION_SECONDS'),
    );
  });

  it('WAVEFORM_MAX_PEAKS matches the server, exactly', () => {
    // Drift the other way is worse than a refusal: the server's zod schema
    // REFUSES an over-long array outright, so a client that downsampled to 240
    // would lose the whole recording at send time with a generic 400.
    expect(WAVEFORM_MAX_PEAKS).toBe(
      serverNumber('services/telegraph/voice.ts', 'WAVEFORM_MAX_PEAKS'),
    );
  });

  it('the recorder STOPS at the ceiling and REFUSES past it — the numbers are used, not just declared', () => {
    // A constant that agrees and is never consulted is the same defect wearing
    // a passing test. These two are the only places the number decides anything
    // on the client.
    expect(recordingShouldStop(VOICE_MAX_DURATION_SECONDS - 1)).toBe(false);
    expect(recordingShouldStop(VOICE_MAX_DURATION_SECONDS)).toBe(true);
    expect(isSendableRecording(VOICE_MAX_DURATION_SECONDS)).toBe(true);
    expect(isSendableRecording(VOICE_MAX_DURATION_SECONDS + 1)).toBe(false);
  });

  it('the waveform the client SENDS can never exceed what the server will accept', () => {
    // The end-to-end statement, rather than a statement about a constant: a
    // 90-second recording metered at 10 Hz is 900 peaks, and the schema caps at
    // WAVEFORM_MAX_PEAKS.
    const metered = new Array(900).fill(0).map((_, i) => (i % 2 === 0 ? 0 : 1));
    expect(downsampleWaveform(metered).length).toBeLessThanOrEqual(WAVEFORM_MAX_PEAKS);
  });
});

// ── §6.2 kinds and §6.4 tabs ─────────────────────────────────────────────────

describe('the §6.2 vocabulary is the same vocabulary on both sides of the boundary', () => {
  it('§6.4s drawer tabs match the server, IN ORDER — the tab strip is rendered from this list', () => {
    expect([...DRAWER_TABS]).toEqual(
      serverStringList('services/telegraph/messageKinds.ts', 'DRAWER_TABS'),
    );
  });

  it('the kinds the client SENDS through the typed route are exactly the ones that route accepts', () => {
    // The server derives both sets from one object — `ENVELOPE_KINDS` is
    // `Object.keys(PAYLOADS)` and `SENDABLE_ENVELOPE_KINDS` is that minus VOICE
    // — so neither is a literal a regex can read. The PAYLOADS map itself is,
    // and it is the thing both are derived from.
    //
    // A kind the client sends and the server refuses is a 400 the composer
    // cannot explain; a kind the server accepts and the client never offers is
    // a feature nobody can reach.
    const src = serverSource('services/telegraph/messageKinds.ts');
    const block = /const PAYLOADS = \{([\s\S]*?)\n\} as const;/.exec(src);
    if (!block) {
      throw new Error(
        'Could not read `const PAYLOADS = { … } as const;` from ' +
          'services/telegraph/messageKinds.ts — the declaration was rewritten and ' +
          'this guard no longer compares anything.',
      );
    }
    const payloadKeys = [...block[1].matchAll(/^\s{2}([A-Z_]+):\s/gm)].map((m) => m[1]);
    expect(payloadKeys.length).toBeGreaterThan(0);
    // VOICE is parseable but sent through its own route — on BOTH sides.
    expect(payloadKeys).toContain('VOICE');
    expect([...SENDABLE_KINDS].sort()).toEqual(payloadKeys.filter((k) => k !== 'VOICE').sort());
    expect([...ENVELOPE_KINDS].sort()).toEqual([...payloadKeys].sort());
  });

  it('the renderer knows EVERY kind the parser will hand it — otherwise: a blank bubble', () => {
    // `parseKindEnvelope` returns a payload for every ENVELOPE_KIND. The
    // dispatcher in `app/messages/[id].tsx` asks `rendersTypedKind` FIRST, so a
    // kind the parser understands and the renderer does not falls through to
    // the plain text bubble and renders the raw JSON envelope.
    for (const kind of ENVELOPE_KINDS) {
      expect(rendersTypedKind(kind.toLowerCase())).toBe(true);
    }
  });

  it('the renderer does NOT claim kinds that are rendered elsewhere', () => {
    // PORTAVA_OBJECT has its own component and its own branch in the
    // dispatcher, which runs AFTER `rendersTypedKind`. Claiming it here would
    // silently take over that branch and lose the revocation handling.
    for (const notMine of ['text', 'system', 'media', 'portava_object']) {
      expect(rendersTypedKind(notMine)).toBe(false);
    }
    expect(rendersTypedKind(null)).toBe(false);
    expect(rendersTypedKind(undefined)).toBe(false);
  });

  it('the INBOX has a preview label for every kind that can appear as a last message', () => {
    // The defect typedPreviewLabels.ts was written for: with no entry, the last
    // line of a conversation is the raw envelope,
    // `{"kind":"VOICE","envelopeVersion":"1","payload":{"url":"post-media/…`.
    // SAFETY is labelled from its subtype and so is absent from the table.
    for (const kind of ENVELOPE_KINDS) {
      const wire = kind.toLowerCase();
      if (wire === 'safety') {
        expect(typedKindPreviewLabel('safety', 'need_help')).toBeTruthy();
        expect(typedKindPreviewLabel('safety', null)).toBeTruthy();
        continue;
      }
      expect(TYPED_KIND_LABELS[wire]).toBeTruthy();
      const label = typedKindPreviewLabel(wire, null);
      expect(label).toBeTruthy();
      expect(label).not.toContain('{');
      expect(label).not.toContain('envelopeVersion');
    }
  });

  it('the composer offers only kinds §6.2 actually names', () => {
    const specKinds = serverStringList('services/telegraph/vocabulary.ts', 'TELEGRAPH_MESSAGE_KINDS');
    expect(specKinds).toHaveLength(13); // §6.2's thirteen, as the module header says
    for (const entry of COMPOSER_ENTRIES) {
      if (entry.kind === null) continue;
      expect(specKinds).toContain(entry.kind);
    }
  });

  it('a composer entry that is UNAVAILABLE says why in a real sentence', () => {
    // A `+` menu entry that opens a picker whose result cannot be sent loses
    // the traveller's thirty seconds of audio. Each unavailable entry must carry
    // its own reason, and a shrug is not one.
    for (const entry of COMPOSER_ENTRIES) {
      if (entry.available) {
        expect(entry.unavailableReason).toBeNull();
      } else {
        expect((entry.unavailableReason ?? '').length).toBeGreaterThan(40);
      }
    }
  });
});

// ── the ranking funnel vocabulary ────────────────────────────────────────────

describe('useRankOutcome cannot send a surface or an outcome the server 400s', () => {
  const RANK_EVENTS = 'routes/rankEvents.ts';

  it('every Surface the hook can send is in the server enum', () => {
    // The hook's own comment: "a value added here before the server accepts it
    // silently loses every outcome" — silently, because the report is
    // fire-and-forget and the 400 is swallowed by `.catch(() => {})`.
    const server = serverStringList(RANK_EVENTS, 'SURFACE_VALUES');
    const client = clientUnion('../../../hooks/useRankOutcome.ts', 'Surface');
    for (const s of client) expect(server).toContain(s);
  });

  it('every Outcome the hook can send is in the server enum, including the dismiss', () => {
    const server = serverStringList(RANK_EVENTS, 'OUTCOME_VALUES');
    const client = clientUnion('../../../hooks/useRankOutcome.ts', 'Outcome');
    for (const o of client) expect(server).toContain(o);
    // `dismiss` is kept OUT of `Outcome` on purpose — it is not a funnel rung
    // and must not be reportable through the fire-and-forget path — but it IS
    // sent by `reportDismiss`, so the server has to accept it.
    expect(client).not.toContain('dismiss');
    expect(server).toContain('dismiss');
    expect(clientUnion('../../../hooks/useRankOutcome.ts', 'NegativeOutcome')).toEqual(['dismiss']);
  });
});

// ── §10/§11 privacy vocabulary ───────────────────────────────────────────────

describe('the privacy controls the sheet renders are the controls the server enforces', () => {
  const RESURFACING = 'services/highlights/highlightResurfacing.ts';

  it('the six §11 controls match, name for name', () => {
    // The client declares the union so it can type its calls; the server owns
    // the values. A client control the server does not know is a 400 on a
    // privacy toggle; a server control the client cannot name is a protection
    // nobody can switch on.
    const server = serverStringList(RESURFACING, 'RESURFACING_CONTROLS');
    const client = clientUnion('../../highlights/privacyControlsApi.ts', 'ResurfacingControl');
    expect(client.sort()).toEqual([...server].sort());
    expect(server).toHaveLength(6);
  });

  it('the four suppressible surfaces match', () => {
    const server = serverStringList(RESURFACING, 'SUPPRESSIBLE_SURFACES');
    const client = clientUnion('../../highlights/privacyControlsApi.ts', 'SuppressibleSurface');
    expect(client.sort()).toEqual([...server].sort());
  });

  it("§10's two ladders match, IN ORDER — the order is the meaning", () => {
    // "Coarsening left to right." A client that reordered these would render a
    // tightening as a loosening, and the person would pick the wrong rung.
    const projection = 'services/highlights/highlightProjectionPolicy.ts';
    expect(clientUnion('../../highlights/privacyControlsApi.ts', 'LocationPrecisionRung')).toEqual(
      serverStringList(projection, 'LOCATION_PRECISION_LADDER'),
    );
    expect(clientUnion('../../highlights/privacyControlsApi.ts', 'PersonVisibilityRung')).toEqual(
      serverStringList(projection, 'PERSON_VISIBILITY_LADDER'),
    );
  });
});

// ── the layover observation vocabulary ───────────────────────────────────────

describe('the fact types the layover card offers are the ones the route accepts', () => {
  it("TravellerFactType matches the server's TRAVELER_OBSERVATION class", () => {
    // The server DERIVES its set by filtering `AIRPORT_FACT_TYPES` on the
    // class; the client writes it out. A type added to that class becomes
    // submittable server-side with no edit anywhere — and the client's union
    // would refuse to compile a call for it, so the channel would exist and be
    // unreachable. Read from the vocabulary, not from the derived constant,
    // because the derived one is a `.filter()` and cannot be parsed as a list.
    const src = readFileSync(
      resolve(API, 'services/airport/LayoverAirportTruth.ts'),
      'utf8',
    );
    const observation = [
      ...src.matchAll(/^\s*([a-z_]+):\s*"TRAVELER_OBSERVATION"/gm),
    ].map((m) => m[1]);
    if (observation.length === 0) {
      throw new Error(
        'Could not read the TRAVELER_OBSERVATION members of AIRPORT_FACT_TYPES — ' +
          'the declaration was rewritten and this guard no longer compares anything.',
      );
    }
    const client = clientUnion('../../../services/layover.ts', 'TravellerFactType');
    expect(client.sort()).toEqual(observation.sort());
  });
});

/**
 * SHOWN RED BEFORE COMMIT. Baseline 17/17. Each mutation was applied to the
 * CLIENT copy of the constant, the suite re-run, and the file restored from a
 * byte-for-byte copy; `git status` was clean of source changes at the end.
 *
 *   • `VOICE_MAX_DURATION_SECONDS` changed to 360 — the exact drift
 *     `voicePolicy.ts`'s own header warns about → 16/1.
 *     THE RECORDER CASE STAYED GREEN, and that is the finding: it asserts the
 *     number is USED, and it reads the same (now wrong) constant, so it agrees
 *     with itself perfectly while the recorder runs a minute past what the send
 *     route will accept. A client-only suite CANNOT catch this class at all,
 *     which is why the constant is compared against the server's source.
 *   • `WAVEFORM_MAX_PEAKS` changed to 240 → 16/1. Same asymmetry: the
 *     send-safe case stayed green because `downsampleWaveform` defaults to the
 *     client's own cap and would faithfully produce 240 peaks the server's zod
 *     schema refuses outright.
 *   • `DRAWER_TABS` reordered (VOICE moved before PORTAVA) → 16/1. The tab
 *     strip is rendered from this list and the counts arrive keyed by name, so
 *     a reorder is a cosmetic-looking change with no runtime symptom until
 *     someone compares the two lists.
 *   • `ENVELOPE_KINDS` with VOICE removed — the pre-integration spelling, which
 *     `kindsApi.ts`'s header records as having made a stored VOICE row "parse
 *     as nothing and render as a blank bubble" → 16/1.
 *   • `rendersTypedKind` with `'voice'` dropped from its list → 16/1. The
 *     dispatcher falls through to the plain bubble and renders the envelope.
 *   • `TYPED_KIND_LABELS.voice` deleted → 16/1. The assertion that the label
 *     contains no `{` is what separates "no label" from "the label IS the
 *     envelope", which is the defect that module was written for.
 *   • `Surface` given a fifth member `'wall'` → 16/1. The server's zod enum
 *     400s it and `fireRankOutcome`'s `.catch(() => {})` swallows the 400, so
 *     every outcome on that surface is lost in silence.
 *   • `ResurfacingControl` with `HIDE_TRIP` removed AND `LocationPrecisionRung`
 *     reversed, applied together → 15/2. The reversal is the one that matters
 *     most: reversed, the sheet renders §10's coarsening ladder as a
 *     tightening one and the person picks the opposite of what they meant.
 *   • `TravellerFactType` with `closure_reported` removed → 16/1.
 *
 * NOT MUTATED, and named rather than implied: the SERVER side of every pair.
 * Changing both copies together would keep this file green, correctly — it
 * checks that the two AGREE, not that either number is right. What each number
 * means is pinned in `artifacts/api-server/src/test/telegraphVoice.test.ts`,
 * `.../verifyFlowVoiceEndToEnd.test.ts` and `voice.component.test.tsx`.
 */
