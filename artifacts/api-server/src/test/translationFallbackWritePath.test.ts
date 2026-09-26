/**
 * §18.2 — the migration-2991 fallback in `upsertTranslation`, as RUNTIME
 * behaviour rather than as a predicate.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `upsertTranslation` used to build one `Record<string, unknown>`, spread the
 * two 2991 columns onto it conditionally, and `delete` them before the retry.
 * That shape is a blind spot for `check:write-path-columns`, which resolves an
 * upsert payload STATICALLY, so it was rewritten into two TYPED LITERALS at two
 * separate `.upsert(` calls chosen by a module-level flag.
 *
 * `src/test/translationConfidence.test.ts` already covers the PREDICATE
 * (`isMissingTranslationConfidenceColumn` by code and by message). What nothing
 * covered was the behaviour the predicate exists to drive: WHICH payload
 * reaches the database, whether the retry happens, what the row that LANDS
 * actually contains, and whether an unrelated failure is mistaken for a pending
 * migration. A static-check fix that quietly removed the runtime compatibility
 * would have left every one of those tests green.
 *
 * That matters because migration 2991 is applied to portava-ci and NOT to
 * production: `src/test/generated/liveColumns.json` — the information_schema of
 * the LIVE database — lists eleven columns on `message_translations` and
 * NEITHER `confidence` NOR `provider_version`. The fallback is not a
 * theoretical branch; it is what runs on every translation the deployed system
 * writes today. So `makeSchemaStrictClient` reproduces the old schema for free
 * and with a real 42703, and `unchecked` is how this file stages the NEW schema
 * that portava-ci already has.
 *
 * MUTATION REQUIREMENT, stated so a later reader can check this file is still
 * doing its job:
 *   - deleting the retry (`return` instead of the second `.upsert(`) must fail
 *     "the row lands, carrying the nine columns the old schema does have".
 *   - hoisting `confidenceColumnsAbsent = true` out of the guard, or negating
 *     it back on success, must fail "the process pays the failed round-trip
 *     exactly once".
 *   - widening `isMissingTranslationConfidenceColumn` to consult the message
 *     text even when the database named a different code must fail "a
 *     permission denial that happens to say the word `confidence` is not a
 *     pending migration".
 *   - making either payload computed (a spread, a `delete`) fails
 *     `check:write-path-columns`, not this file — that check is the other half
 *     of this pair and neither replaces the other.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';

import { makeSchemaStrictClient, type SchemaStrictClient } from './helpers/schemaStrictSupabase.js';
import {
  retranslateForUser,
  isMissingTranslationConfidenceColumn,
  CONFIDENCE_MIGRATION_PENDING_MESSAGE,
  __resetConfidenceColumnProbe,
} from '../services/messageTranslation.js';
import { MOCK_TRANSLATION_VERSION } from '../lib/translation.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';
const ROW = '33333333-3333-4333-8333-333333333333';

/** Long enough and terminated, so `validateTranslation` passes and the write
 *  under test is the `status: 'translated'` one rather than a failure row. */
const BODY = 'Hello there, this is a real message body with enough text to validate.';

/**
 * The nine columns the table has had since before 2991 — the exact shape the
 * short payload must write, spelled out here rather than derived from the
 * module, so that a column silently dropped from the fallback literal fails.
 */
const BASE_COLUMNS = [
  'error_message',
  'message_id',
  'provider',
  'recipient_id',
  'source_language',
  'status',
  'target_language',
  'translated_body',
  'updated_at',
];

function seed(): Record<string, Array<Record<string, unknown>>> {
  return {
    message_translations: [
      {
        id: ROW,
        message_id: MSG,
        recipient_id: USER,
        source_language: 'en',
        target_language: 'fr',
        translated_body: null,
        provider: null,
        status: 'translated',
        error_message: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    messages: [
      {
        id: MSG,
        body: BODY,
        original_language: 'en',
        // 'provider' is what lets `translationConfidenceOf` produce a non-null
        // reading at all, so case 1 has a real value to carry rather than null.
        language_detection_source: 'provider',
      },
    ],
  };
}

type LogLine = { level: string; obj: Record<string, unknown>; msg: string };

function recordingLogger(): { lines: LogLine[]; logger: Logger } {
  const lines: LogLine[] = [];
  const at = (level: string) => (obj: unknown, msg?: unknown) => {
    if (typeof obj === 'string') lines.push({ level, obj: {}, msg: obj });
    else lines.push({ level, obj: (obj ?? {}) as Record<string, unknown>, msg: String(msg ?? '') });
  };
  const logger = {
    trace: at('trace'), debug: at('debug'), info: at('info'),
    warn: at('warn'), error: at('error'), fatal: at('fatal'),
  } as unknown as Logger;
  return { lines, logger };
}

function linesAt(lines: LogLine[], level: string, msg: string): LogLine[] {
  return lines.filter((l) => l.level === level && l.msg === msg);
}

/**
 * Record EVERY payload handed to `.upsert()` on `message_translations`,
 * accepted or refused.
 *
 * `SchemaStrictClient.writes` only holds the writes the double ACCEPTED, which
 * cannot distinguish "did not retry" from "retried and was refused again". The
 * whole question in cases 3–5 is how many round-trips were paid and what was in
 * each, so the attempts are counted at the call.
 */
function attemptsOf(sc: SchemaStrictClient): Array<Record<string, unknown>> {
  const attempts: Array<Record<string, unknown>> = [];
  const inner = sc.from.bind(sc);
  sc.from = (table: string) => {
    const b = inner(table);
    if (table !== 'message_translations') return b;
    const realUpsert = b.upsert.bind(b);
    b.upsert = (rows: unknown, opts?: unknown) => {
      for (const r of Array.isArray(rows) ? rows : [rows]) {
        attempts.push({ ...(r as Record<string, unknown>) });
      }
      return realUpsert(rows, opts);
    };
    return b;
  };
  return attempts;
}

/** One sweep that produces exactly one `status: 'translated'` upsert. */
async function sweep(sc: SchemaStrictClient, logger: Logger): Promise<void> {
  await retranslateForUser(sc as any, USER, 'es', logger);
}

beforeEach(() => {
  // The flag is module-level and therefore shared by every test in this file.
  __resetConfidenceColumnProbe();
});

// ── 1. New schema ────────────────────────────────────────────────────────────

describe('2991 APPLIED — the reading is written, not dropped', () => {
  it('writes confidence and provider_version, carrying the values the call passed', async () => {
    // `unchecked` stands in for portava-ci, where 2991 IS applied. The live
    // snapshot this double reads predates the migration, so without this the
    // new-schema case is unreachable and only the fallback would ever be tested.
    const sc = makeSchemaStrictClient(seed(), { unchecked: ['message_translations'] });
    const attempts = attemptsOf(sc);
    const { lines, logger } = recordingLogger();

    await sweep(sc, logger);

    assert.equal(attempts.length, 1, 'one upsert: nothing was refused, so nothing is retried');
    const sent = attempts[0];
    assert.ok('confidence' in sent, 'the confidence reading must reach the database');
    assert.ok('provider_version' in sent, 'the engine identity must reach the database');
    assert.equal(
      sent.confidence,
      'low',
      'the value the call computed, not a placeholder: this sweep took no reading of its own, ' +
        'so `translationConfidenceOf` answers LOW and LOW is what must land',
    );
    assert.equal(
      sent.provider_version,
      MOCK_TRANSLATION_VERSION,
      'the engine that actually ran, read from the provider result rather than a literal beside it',
    );
    assert.equal(sent.provider, 'mock');
    assert.equal(sent.status, 'translated');
    assert.equal(sent.message_id, MSG);
    assert.equal(sent.recipient_id, USER);
    assert.equal(sent.target_language, 'es');

    assert.equal(sc.writes.length, 1, 'the row landed');
    assert.deepEqual(
      Object.keys(sc.writes[0].rows[0]).sort(),
      [...BASE_COLUMNS, 'confidence', 'provider_version'].sort(),
      'eleven columns on the new schema: the nine base ones plus the two 2991 adds',
    );
    assert.deepEqual(
      linesAt(lines, 'warn', CONFIDENCE_MIGRATION_PENDING_MESSAGE),
      [],
      'no migration warning when there is no pending migration',
    );
    assert.deepEqual(linesAt(lines, 'error', 'translation_upsert_failed'), []);
  });
});

// ── 2. Old schema ────────────────────────────────────────────────────────────

describe('2991 PENDING — the translation is kept and the operator is told why', () => {
  it('retries ONCE without both columns, and the row lands with the nine the old schema has', async () => {
    // No `unchecked`: the live snapshot has neither new column, so the first
    // upsert earns a REAL 42703 the way production does.
    const sc = makeSchemaStrictClient(seed());
    const attempts = attemptsOf(sc);
    const { lines, logger } = recordingLogger();

    await sweep(sc, logger);

    assert.equal(attempts.length, 2, 'exactly one retry — not zero, and not a loop');
    assert.ok('confidence' in attempts[0], 'the first attempt names the columns, so the schema is asked');
    assert.ok('provider_version' in attempts[0]);

    assert.equal(
      sc.deadColumnErrors.length,
      2,
      'the database refused BOTH new columns, which is what makes this the migration case',
    );
    assert.deepEqual(
      sc.deadColumnErrors.map((d) => d.column).sort(),
      ['confidence', 'provider_version'],
    );

    // THE ROW THAT LANDS — asserted by its columns, not by the absence of an error.
    assert.equal(sc.writes.length, 1, 'one accepted write: the translation was NOT lost');
    const landed = sc.writes[0].rows[0];
    assert.deepEqual(
      Object.keys(landed).sort(),
      BASE_COLUMNS,
      'the nine base columns, exactly — a tenth would be refused again and a missing one ' +
        'would be a column that quietly stopped being written',
    );
    assert.equal('confidence' in landed, false, 'the column the database does not have is gone');
    assert.equal('provider_version' in landed, false);
    assert.equal(landed.status, 'translated', 'and it is the translation, not a failure row');
    assert.equal(landed.translated_body, `[translated from en] ${BODY}`);
    assert.equal(landed.message_id, MSG);
    assert.equal(landed.recipient_id, USER);

    const warned = linesAt(lines, 'warn', CONFIDENCE_MIGRATION_PENDING_MESSAGE);
    assert.equal(warned.length, 1, 'the operator is told once, by the message that names 2991');
    assert.match(warned[0].msg, /2991/);
    assert.equal(warned[0].obj.err, '42703', 'and the refusal code travels with it');
    assert.equal(warned[0].obj.messageId, MSG);
    assert.equal(warned[0].obj.recipientId, USER);

    assert.deepEqual(
      linesAt(lines, 'error', 'translation_upsert_failed'),
      [],
      'a handled pending migration is not a write failure',
    );
  });
});

// ── 3. The process-level cache ───────────────────────────────────────────────

describe('2991 PENDING — the process learns it once', () => {
  it('pays the failed round-trip exactly once, and never un-learns it', async () => {
    const first = makeSchemaStrictClient(seed());
    const firstAttempts = attemptsOf(first);
    await sweep(first, recordingLogger().logger);
    assert.equal(firstAttempts.length, 2, 'the first sweep discovers the pending migration');

    // A FRESH client, so nothing but the module-level flag can carry the fact.
    const second = makeSchemaStrictClient(seed());
    const secondAttempts = attemptsOf(second);
    const { lines, logger } = recordingLogger();
    await sweep(second, logger);

    assert.equal(secondAttempts.length, 1, 'the second recipient does not rediscover the same schema fact');
    assert.equal('confidence' in secondAttempts[0], false, 'it goes straight to the short payload');
    assert.equal('provider_version' in secondAttempts[0], false);
    assert.deepEqual(
      second.deadColumnErrors,
      [],
      'no second refusal: the round-trip the flag exists to save was actually saved',
    );
    assert.equal(second.writes.length, 1, 'and the row still lands');
    assert.deepEqual(
      linesAt(lines, 'warn', CONFIDENCE_MIGRATION_PENDING_MESSAGE),
      [],
      'the operator is not warned once per recipient for one schema fact',
    );

    // NEVER NEGATED BACK. This client would accept the full payload, so a flag
    // cleared on success would show up here as the columns returning.
    const third = makeSchemaStrictClient(seed(), { unchecked: ['message_translations'] });
    const thirdAttempts = attemptsOf(third);
    await sweep(third, recordingLogger().logger);
    assert.equal(thirdAttempts.length, 1);
    assert.equal(
      'confidence' in thirdAttempts[0],
      false,
      'a successful short write must NOT clear the flag — a migration cannot un-apply itself ' +
        'mid-process, and re-probing on every success is the round-trip this cache removes',
    );

    // …but a test can reset it, or every later test in this file inherits it.
    __resetConfidenceColumnProbe();
    const fourth = makeSchemaStrictClient(seed(), { unchecked: ['message_translations'] });
    const fourthAttempts = attemptsOf(fourth);
    await sweep(fourth, recordingLogger().logger);
    assert.equal(
      'confidence' in fourthAttempts[0],
      true,
      '__resetConfidenceColumnProbe must restore the un-probed state',
    );
    assert.equal(fourthAttempts[0].provider_version, MOCK_TRANSLATION_VERSION);
  });
});

// ── 4. An UNRELATED failure ──────────────────────────────────────────────────

describe('an unrelated database failure is not a pending migration', () => {
  /**
   * `unchecked` so the ONLY thing that can fail this write is the injected
   * error — otherwise a 42703 from the stale snapshot would mask the answer.
   */
  function staged(error: { code?: string; message?: string }) {
    const sc = makeSchemaStrictClient(seed(), {
      unchecked: ['message_translations'],
      writeError: { table: 'message_translations', error },
    });
    return { sc, attempts: attemptsOf(sc), ...recordingLogger() };
  }

  async function assertNotTreatedAsMigration(
    error: { code?: string; message?: string },
    what: string,
  ) {
    const { sc, attempts, lines, logger } = staged(error);
    await sweep(sc, logger);

    assert.equal(attempts.length, 1, `${what}: no retry — there is nothing to retry WITHOUT`);
    assert.ok(
      'confidence' in attempts[0] && 'provider_version' in attempts[0],
      `${what}: the two columns must NOT be stripped. Stripping them here fails again for the ` +
        'real reason and reports the wrong cause',
    );
    assert.equal(sc.writes.length, 0, `${what}: nothing landed`);
    assert.deepEqual(
      linesAt(lines, 'warn', CONFIDENCE_MIGRATION_PENDING_MESSAGE),
      [],
      `${what}: naming 2991 here would send an operator to apply a migration that is not the problem`,
    );
    const failed = linesAt(lines, 'error', 'translation_upsert_failed');
    assert.equal(failed.length, 1, `${what}: the failure is logged by name, not swallowed`);
    assert.equal(failed[0].obj.err, error.code, `${what}: with the real code`);
    assert.equal(failed[0].obj.messageId, MSG);

    // The flag must be untouched, or ONE unrelated failure silently drops the
    // confidence reading from every later write in the process.
    const after = makeSchemaStrictClient(seed(), { unchecked: ['message_translations'] });
    const afterAttempts = attemptsOf(after);
    await sweep(after, recordingLogger().logger);
    assert.ok(
      'confidence' in afterAttempts[0],
      `${what}: the process must not have concluded that 2991 is pending`,
    );
  }

  it('a unique violation is not a pending migration', async () => {
    await assertNotTreatedAsMigration(
      {
        code: '23505',
        message:
          'duplicate key value violates unique constraint "message_translations_message_id_recipient_id_key"',
      },
      '23505',
    );
  });

  it('a permission denial that happens to say the word `confidence` is not a pending migration', async () => {
    // THE TRAP. Postgres spells a column-level privilege refusal exactly like
    // this, and the text matches BOTH halves of the message heuristic —
    // `confidence` and `column` — word for word. Reading it as 2991 would set
    // the process-wide flag on a database where 2991 IS applied, and every
    // later translation in that process would silently lose its reading.
    await assertNotTreatedAsMigration(
      {
        code: '42501',
        message: 'permission denied for column confidence of relation message_translations',
      },
      '42501',
    );
  });

  it('a transport error with no message is not a pending migration', async () => {
    const { sc, attempts, lines, logger } = staged({});
    await sweep(sc, logger);
    assert.equal(attempts.length, 1, 'an empty error shape is not evidence of anything');
    assert.ok('confidence' in attempts[0], 'and is no reason to drop two columns');
    assert.deepEqual(linesAt(lines, 'warn', CONFIDENCE_MIGRATION_PENDING_MESSAGE), []);
    assert.equal(linesAt(lines, 'error', 'translation_upsert_failed').length, 1);
  });

  it('the predicate itself refuses a coded error whatever its text says', () => {
    // The unit-level statement of the two cases above, so a later reader can
    // see the rule without reconstructing it from the sweep.
    assert.equal(
      isMissingTranslationConfidenceColumn({
        code: '42501',
        message: 'permission denied for column confidence of relation message_translations',
      }),
      false,
    );
    assert.equal(
      isMissingTranslationConfidenceColumn({
        code: '23502',
        message: 'null value in column "provider_version" violates not-null constraint',
      }),
      false,
    );
    // …and still says yes to the refusal it exists for, by code and by text.
    assert.equal(isMissingTranslationConfidenceColumn({ code: '42703' }), true);
    assert.equal(
      isMissingTranslationConfidenceColumn({
        message: 'column message_translations.confidence does not exist',
      }),
      true,
    );
  });
});

// ── 5. The retry itself fails ────────────────────────────────────────────────

describe('2991 PENDING and the retry ALSO fails', () => {
  it('logs the failure by name, does not throw, and does not lose the caller', async () => {
    // No `unchecked`, so the FIRST upsert earns a real 42703 from the stale
    // snapshot; `writeError` then takes the retry, which names only live
    // columns. The double checks columns before it applies `writeError`, which
    // is what makes this ordering reachable.
    const sc = makeSchemaStrictClient(seed(), {
      writeError: {
        table: 'message_translations',
        error: { code: '08006', message: 'connection terminated unexpectedly' },
      },
    });
    const attempts = attemptsOf(sc);
    const { lines, logger } = recordingLogger();

    await assert.doesNotReject(() => sweep(sc, logger), 'a lost row must not become a thrown sweep');

    assert.equal(attempts.length, 2, 'it still retried once');
    assert.equal('confidence' in attempts[1], false, 'and the retry was the short payload');
    assert.deepEqual(Object.keys(attempts[1]).sort(), BASE_COLUMNS);
    assert.equal(sc.writes.length, 0, 'nothing landed — this row is genuinely lost');

    assert.equal(
      linesAt(lines, 'warn', CONFIDENCE_MIGRATION_PENDING_MESSAGE).length,
      1,
      'the pending migration is still reported',
    );
    const failed = linesAt(lines, 'error', 'translation_upsert_failed');
    assert.equal(failed.length, 1, 'and so is the loss — silently returning would hide it');
    assert.equal(failed[0].obj.err, '08006', 'with the RETRY error, not the 42703 that preceded it');
    assert.equal(failed[0].obj.status, 'translated');
    assert.equal(failed[0].obj.messageId, MSG);

    // THE CALLER IS NOT LOST. The sweep ran to its end rather than aborting on
    // the first unwritable recipient.
    assert.equal(
      linesAt(lines, 'info', 'retranslate_sweep_complete').length,
      1,
      'the sweep completed: one unwritable row must not strand the recipients after it',
    );
    assert.deepEqual(linesAt(lines, 'error', 'retranslate_sweep_error'), []);
  });
});
