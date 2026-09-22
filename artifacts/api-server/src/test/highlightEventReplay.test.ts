/**
 * §17 / §21 / §25 — hide, unhide, and whether a replay reaches the row.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §17 (:478) the command boundary, the seventeen commands, the fourteen events.
 *   §21 (:566) Archive is reversible and is NOT the delete.
 *   §25 (:641) replay and certification.
 *
 * THE POINT OF THIS FILE. `POST /highlights/:id/archive` is §17's
 * HIDE_HIGHLIGHT and emits `highlight.hidden`. Before this lane
 * `DELETE /highlights/:id/archive` — the half that makes §21's Archive
 * reversible — was a bare `.update({ archived_at: null })` that crossed no
 * command boundary and emitted nothing, so the log's last word on a
 * hidden-then-unhidden Highlight was `highlight.hidden` while the row was
 * visible. `replayAgreesWithRow` is that divergence, made executable.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightEventReplay.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HIGHLIGHT_COMMAND_EFFECTS,
  replayAgreesWithRow,
  replayHighlightEvents,
  type HighlightDomainEventRow,
} from "../services/memoryProjections/highlightEventReplay.js";
import {
  COMMAND_CAPABILITY,
  COMMAND_EVENT,
  COMMAND_SUBJECT,
  HIGHLIGHT_COMMAND_TYPES,
  MEMORY_COMMAND_TYPES,
} from "../lib/memoryCommandBus.js";

const H = "11111111-1111-4111-8111-111111111111";

function ev(
  sequence: number,
  commandType: string | undefined,
  over: Partial<HighlightDomainEventRow> = {},
): HighlightDomainEventRow {
  const type =
    commandType === "HIDE_HIGHLIGHT" || commandType === "UNHIDE_HIGHLIGHT"
      ? "highlight.hidden"
      : "highlight.pinned";
  return {
    event_id: `e${sequence}`,
    highlight_id: H,
    sequence,
    type,
    payload_json: commandType === undefined ? {} : { command_type: commandType },
    ...over,
  };
}

// ── 1. the command boundary has an inverse for HIDE ─────────────────────────

describe("§21 Archive is reversible, so the command boundary has an inverse for HIDE_HIGHLIGHT", () => {
  it("UNHIDE_HIGHLIGHT is a declared command", () => {
    assert.ok(
      (MEMORY_COMMAND_TYPES as readonly string[]).includes("UNHIDE_HIGHLIGHT"),
      "§21 requires Archive to be reversible and §17 requires every canonical write to cross the " +
        "command boundary; without this name the un-archive is a direct write that emits nothing",
    );
  });

  it("it is a Highlight command, owner-only, and emits §17's highlight.hidden", () => {
    assert.equal(COMMAND_SUBJECT.UNHIDE_HIGHLIGHT, "highlight");
    assert.equal(COMMAND_CAPABILITY.UNHIDE_HIGHLIGHT, "owner");
    // §17 names no `highlight.unhidden`. The PIN/UNPIN precedent already in
    // COMMAND_EVENT is followed exactly: both directions emit the one §17 name
    // and the payload's command_type carries the direction.
    assert.equal(COMMAND_EVENT.UNHIDE_HIGHLIGHT, "highlight.hidden");
    assert.equal(COMMAND_EVENT.HIDE_HIGHLIGHT, "highlight.hidden");
    assert.ok((HIGHLIGHT_COMMAND_TYPES as readonly string[]).includes("UNHIDE_HIGHLIGHT"));
  });

  it("HIDE and UNHIDE touch archived_at and never pinned_at — §21 keeps the operations separate", () => {
    assert.deepEqual(HIGHLIGHT_COMMAND_EFFECTS.HIDE_HIGHLIGHT, { hidden: true, pinned: null });
    assert.deepEqual(HIGHLIGHT_COMMAND_EFFECTS.UNHIDE_HIGHLIGHT, { hidden: false, pinned: null });
    assert.deepEqual(HIGHLIGHT_COMMAND_EFFECTS.PIN_HIGHLIGHT, { hidden: null, pinned: true });
    assert.deepEqual(HIGHLIGHT_COMMAND_EFFECTS.UNPIN_HIGHLIGHT, { hidden: null, pinned: false });
  });

  it("every declared Highlight command has a replay transition — the two lists cannot drift", () => {
    const replayable = new Set(Object.keys(HIGHLIGHT_COMMAND_EFFECTS));
    for (const t of HIGHLIGHT_COMMAND_TYPES) {
      assert.ok(replayable.has(t), `${t} is issued by the bus and has no replay transition`);
    }
    assert.equal(replayable.size, HIGHLIGHT_COMMAND_TYPES.length);
  });
});

// ── 1b. the gap between the bus and the kernel, pinned ──────────────────────

describe("the SQL half does not accept UNHIDE_HIGHLIGHT yet, and that is recorded rather than assumed", () => {
  const SQL = readFileSync(
    new URL("../migrations/2993_highlight_command_boundary.sql", import.meta.url),
    "utf8",
  );

  it("2993 as written admits exactly three Highlight commands", () => {
    // MEASURED, not assumed. The function's guard is
    //   IF v_type NOT IN ('PIN_HIGHLIGHT', 'UNPIN_HIGHLIGHT', 'HIDE_HIGHLIGHT')
    // so a dispatched UNHIDE_HIGHLIGHT is refused by name with
    // MEMORY_COMMAND_UNKNOWN_TYPE — an audited rejection, never a wrong write.
    // That is a SAFE gap and it is still a gap. When 2993 gains its
    // `WHEN 'UNHIDE_HIGHLIGHT'` arm this test goes red and must be updated in
    // the same change, which is the point: the two halves cannot drift
    // silently in either direction.
    assert.match(SQL, /v_type NOT IN \('PIN_HIGHLIGHT', 'UNPIN_HIGHLIGHT', 'HIDE_HIGHLIGHT'\)/);
    assert.ok(
      !/WHEN 'UNHIDE_HIGHLIGHT'/.test(SQL),
      "2993 now applies UNHIDE_HIGHLIGHT — update this block and the lane report's NOT-DONE entry",
    );
  });

  it("every OTHER declared Highlight command IS applied by 2993", () => {
    for (const t of HIGHLIGHT_COMMAND_TYPES) {
      if (t === "UNHIDE_HIGHLIGHT") continue;
      assert.ok(SQL.includes(`WHEN '${t}'`), `2993 has no arm for ${t}`);
    }
  });
});

// ── 2. the fold ─────────────────────────────────────────────────────────────

describe("§25 the fold reads command_type, never the event name", () => {
  it("an empty stream is the initial state, not a refusal", () => {
    const r = replayHighlightEvents(H, []);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.state.hidden, false);
    assert.equal(r.ok && r.state.pinned, false);
    assert.equal(r.ok && r.state.sequence, 0);
  });

  it("hide alone replays to hidden", () => {
    const r = replayHighlightEvents(H, [ev(1, "HIDE_HIGHLIGHT")]);
    assert.equal(r.ok && r.state.hidden, true);
  });

  it("HIDE THEN UNHIDE REPLAYS TO VISIBLE — both events carry §17's one name", () => {
    const evts = [ev(1, "HIDE_HIGHLIGHT"), ev(2, "UNHIDE_HIGHLIGHT")];
    assert.deepEqual([...new Set(evts.map((e) => e.type))], ["highlight.hidden"]);
    const r = replayHighlightEvents(H, evts);
    assert.equal(r.ok && r.state.hidden, false, "a fold over event NAMES would answer hidden here");
    assert.deepEqual(r.ok && r.state.applied, ["HIDE_HIGHLIGHT", "UNHIDE_HIGHLIGHT"]);
  });

  it("pin and unpin are folded the same way and do not disturb hidden", () => {
    const r = replayHighlightEvents(H, [
      ev(1, "HIDE_HIGHLIGHT"),
      ev(2, "PIN_HIGHLIGHT"),
      ev(3, "UNPIN_HIGHLIGHT"),
    ]);
    assert.equal(r.ok && r.state.hidden, true);
    assert.equal(r.ok && r.state.pinned, false);
  });

  it("order comes from `sequence`, so out-of-order DELIVERY does not change the answer", () => {
    const forwards = replayHighlightEvents(H, [ev(1, "HIDE_HIGHLIGHT"), ev(2, "UNHIDE_HIGHLIGHT")]);
    const backwards = replayHighlightEvents(H, [ev(2, "UNHIDE_HIGHLIGHT"), ev(1, "HIDE_HIGHLIGHT")]);
    assert.deepEqual(forwards, backwards);
    assert.equal(forwards.ok && forwards.state.hidden, false);
  });

  it("a DUPLICATE sequence is refused, not resolved — a corrupt log yields no state", () => {
    const r = replayHighlightEvents(H, [ev(1, "HIDE_HIGHLIGHT"), ev(1, "UNHIDE_HIGHLIGHT")]);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "duplicate_sequence");
  });

  it("an event with no command_type is refused rather than folded by its name", () => {
    const r = replayHighlightEvents(H, [ev(1, undefined)]);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "command_type_absent");
  });

  it("an unknown command is refused", () => {
    const r = replayHighlightEvents(H, [ev(1, "DELETE_MEMORY")]);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "command_type_unknown");
  });

  it("an event whose name is not the one its command emits is refused", () => {
    const r = replayHighlightEvents(H, [ev(1, "HIDE_HIGHLIGHT", { type: "highlight.pinned" })]);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "event_type_mismatch");
  });

  it("a stream that mixes two Highlights is refused", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const r = replayHighlightEvents(H, [ev(1, "HIDE_HIGHLIGHT"), ev(2, "UNHIDE_HIGHLIGHT", { highlight_id: other })]);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "mixed_subjects");
  });
});

// ── 3. replay against the row ───────────────────────────────────────────────

describe("§25 the log must reproduce the row", () => {
  const VISIBLE = { archived_at: null, pinned_at: null };
  const HIDDEN = { archived_at: "2026-06-01T00:00:00.000Z", pinned_at: null };

  it("a Highlight with no events is NOT replayable — silence is not agreement", () => {
    const r = replayAgreesWithRow(H, [], VISIBLE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "not_replayable");
  });

  it("hide, with the row archived, agrees", () => {
    const r = replayAgreesWithRow(H, [ev(1, "HIDE_HIGHLIGHT")], HIDDEN);
    assert.equal(r.ok && r.agrees, true);
  });

  it("THE DIVERGENCE THIS FILE EXISTS FOR: a hide with no matching un-hide event, over an un-archived row", () => {
    // Exactly what the direct-write `DELETE /highlights/:id/archive` produced:
    // the row is visible, the log's last word is `highlight.hidden`, and any
    // §18 consumer rebuilding from the log withholds the Highlight forever.
    const r = replayAgreesWithRow(H, [ev(1, "HIDE_HIGHLIGHT")], VISIBLE);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.agrees, false);
    assert.deepEqual(
      r.ok && r.agrees === false ? r.divergences : null,
      [{ field: "hidden", replayed: true, stored: false }],
    );
  });

  it("and it is CLOSED once the un-hide crosses the command boundary", () => {
    const r = replayAgreesWithRow(H, [ev(1, "HIDE_HIGHLIGHT"), ev(2, "UNHIDE_HIGHLIGHT")], VISIBLE);
    assert.equal(r.ok && r.agrees, true);
  });

  it("a pin divergence is reported on its own field", () => {
    const r = replayAgreesWithRow(H, [ev(1, "PIN_HIGHLIGHT")], VISIBLE);
    assert.equal(r.ok && r.agrees, false);
    assert.deepEqual(
      r.ok && r.agrees === false ? r.divergences : null,
      [{ field: "pinned", replayed: true, stored: false }],
    );
  });

  it("a refusal from the fold is passed through, never reported as agreement", () => {
    const r = replayAgreesWithRow(H, [ev(1, undefined)], VISIBLE);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "command_type_absent");
  });
});
