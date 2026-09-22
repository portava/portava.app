/**
 * An in-memory MODEL of public.memory_kernel_execute (migration 2710).
 *
 * WHAT THIS IS AND IS NOT
 * =======================
 * It is a model of the SQL, not the SQL. It exists so the TypeScript layer can
 * be exercised end to end — gating, the envelope, authorization-before-command
 * ordering, the §5 guard, idempotent replay, the rejection-to-HTTP mapping, and
 * the ATOMICITY CONTRACT the outbox depends on. The function's own semantics
 * (row locking, RLS, the append-only trigger, and the fact that PostgreSQL
 * really does roll the whole statement back) are the database's and are NOT
 * proven here; migration 2710 carries its own postconditions for those and the
 * parent's apply gate runs them.
 *
 * WHAT IT MODELS EXACTLY, AND WHY IT MATTERS
 * ==========================================
 * The transaction. Every write the command makes — the canonical row, the
 * event, the outbox row, the receipt, the audit row — happens against a SNAPSHOT
 * that is committed only if all of them succeed. `failOn` makes any one of them
 * fail, and the snapshot is discarded, which is what `RAISE` inside a plpgsql
 * function does to the surrounding transaction. The RPC then answers the way
 * supabase-js answers a failed RPC: `{ data: null, error }` — RESOLVED, not
 * rejected, because that is the measured behaviour of the installed client and
 * is the single fact most likely to turn a broken kernel into a silent success.
 *
 * A rejection is different from a failure and the model keeps them apart: a
 * REJECTED command (unknown type, not owner, illegal transition) RETURNS
 * `{ ok:false, reason }` and its audit row COMMITS, because the SQL returns
 * rather than raises. That is why the audit is a record of attempts and not
 * only of successes — §24's reason codes would otherwise have nothing to count.
 */
import {
  assertLifecycleTransition,
  lifecycleStateOf,
  COMMAND_CAPABILITY,
  COMMAND_EVENT,
  COMMAND_SUBJECT,
  HIGHLIGHT_KERNEL_FN,
  MEMORY_COMMAND_TYPES,
  MEMORY_KERNEL_FN,
  type MemoryCommandType,
} from "../lib/memoryCommandBus.js";

export type KernelWriteTarget = "state" | "event" | "outbox" | "receipt" | "audit";

export interface KernelState {
  tables: Record<string, any[]>;
  rpcCalls: Array<{ name: string; args: any }>;
  /** Which of the kernel's five writes fails, if any. */
  failOn: Set<KernelWriteTarget>;
  /** The function itself is absent (migration 2710 unapplied). */
  absent: boolean;
}

let idCounter = 0;
export function _resetKernelIds(): void { idCounter = 0; }

const clone = (t: Record<string, any[]>) =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));

const rejected = (reason: string, extra: Record<string, unknown> = {}) =>
  ({ data: { ok: false, reason, ...extra, contract_version: 1 }, error: null });

/**
 * Build the `rpc` implementation for a fake supabase client.
 * `state.tables` is the same object the `.from()` fake reads, so a command's
 * effect is visible to the route's own reads afterwards.
 */
export function makeKernelRpc(state: KernelState) {
  return async function rpc(name: string, args: any) {
    state.rpcCalls.push({ name, args });

    if (state.absent) {
      // PostgREST answers an unknown function with PGRST202. supabase-js
      // RESOLVES with the error bound; it does not throw.
      return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } };
    }
    if (name === HIGHLIGHT_KERNEL_FN) return highlightRpc(state, args);
    if (name !== MEMORY_KERNEL_FN) {
      return { data: null, error: { message: `unknown rpc ${name}` } };
    }

    const c = args?.p_command;
    const t = (n: string) => (state.tables[n] ??= []);

    // ── malformed ────────────────────────────────────────────────────────────
    if (!c || typeof c !== "object" || !c.command_id || !c.actor_user_id
        || !c.idempotency_key || typeof c.idempotency_key !== "string"
        || c.idempotency_key.length < 1 || c.idempotency_key.length > 200
        || !c.type || typeof c.payload !== "object" || c.payload === null) {
      return rejected("MEMORY_COMMAND_MALFORMED");
    }
    const type = c.type as MemoryCommandType;
    if (!(MEMORY_COMMAND_TYPES as readonly string[]).includes(type)) {
      return rejected("MEMORY_COMMAND_UNKNOWN_TYPE", { type });
    }

    // The whole transaction is against this snapshot.
    const snapshot = clone(state.tables);
    const restore = () => { for (const k of Object.keys(state.tables)) state.tables[k] = snapshot[k] ?? []; };

    // ── audit, written on EVERY path (it commits even for a rejection) ────────
    const writeAudit = (outcome: string, reason: string | null, eventId: string | null, memoryId: string | null) => {
      if (state.failOn.has("audit")) throw new Error("memory_command_audit insert failed");
      t("memory_command_audit").push({
        id: `audit-${++idCounter}`,
        command_id: c.command_id,
        command_type: type,
        memory_id: memoryId,
        actor_user_id: c.actor_user_id,
        idempotency_key: c.idempotency_key,
        outcome,
        reason,
        event_id: eventId,
        created_at: "2026-09-08T00:00:00.000Z",
      });
    };
    const rejectWithAudit = (reason: string, extra: Record<string, unknown> = {}) => {
      try { writeAudit("rejected", reason, null, c.memory_id ?? null); }
      catch (e: any) { restore(); return { data: null, error: { message: e.message } }; }
      return rejected(reason, extra);
    };

    // ── idempotency receipt (§19). Keyed (actor_user_id, idempotency_key). ────
    const receipt = t("memory_command_receipts").find(
      (r) => r.actor_user_id === c.actor_user_id && r.idempotency_key === c.idempotency_key);
    if (receipt) {
      if (receipt.command_type !== type) {
        return rejectWithAudit("MEMORY_IDEMPOTENCY_KEY_REUSED", { detail: `key already used for ${receipt.command_type}` });
      }
      try { writeAudit("duplicate", null, receipt.event_id, receipt.memory_id); }
      catch (e: any) { restore(); return { data: null, error: { message: e.message } }; }
      // THE ORIGINAL result, from the receipt. Not recomputed.
      return {
        data: {
          ok: true, duplicate: true, memory_id: receipt.memory_id,
          event_id: receipt.event_id, event_type: receipt.event_type,
          result: receipt.result_json, contract_version: 1,
        },
        error: null,
      };
    }

    // ── capability + lifecycle ───────────────────────────────────────────────
    const capability = COMMAND_CAPABILITY[type];
    let memoryRow: any = null;
    let fromState: string | null = null;
    let toState: string | null = null;

    if (type !== "CREATE_MEMORY") {
      memoryRow = t("memories").find((m) => m.id === c.memory_id && m.state !== "deleted");
      if (!memoryRow) return rejectWithAudit("MEMORY_NOT_FOUND");
      if (capability === "owner" && memoryRow.owner_id !== c.actor_user_id) {
        return rejectWithAudit("MEMORY_AUTH_NOT_OWNER");
      }
      if (capability === "owner_or_participant") {
        const tagged = String(c.payload.tagged_user_id ?? "");
        const ok = memoryRow.owner_id === c.actor_user_id || tagged === c.actor_user_id;
        if (!ok) return rejectWithAudit("MEMORY_AUTH_NOT_OWNER");
        if (type === "ADD_PERSON" && tagged !== c.actor_user_id) {
          return rejectWithAudit("MEMORY_AUTH_NOT_PARTICIPANT");
        }
      }
      fromState = memoryRow.state;
    }

    const targetState =
      type === "DELETE_MEMORY" ? "deleted"
      : type === "ARCHIVE_MEMORY" ? "archived"
      : type === "CONFIRM_MEMORY" ? "published"
      : (c.payload?.patch as any)?.state;

    if (memoryRow && targetState !== undefined) {
      const verdict = assertLifecycleTransition(memoryRow.state, String(targetState));
      if (!verdict.ok) {
        return rejectWithAudit(verdict.reason, { from: verdict.from, to: verdict.to });
      }
      toState = verdict.toState;
    } else if (memoryRow) {
      toState = lifecycleStateOf(memoryRow.state);
    }

    // ── apply, then event + outbox + receipt + audit, all or nothing ──────────
    try {
      if (state.failOn.has("state")) throw new Error("canonical write failed");

      let memoryId: string;
      let result: any;

      switch (type) {
        case "CREATE_MEMORY": {
          const row = { id: `mem-${++idCounter}`, created_at: "2026-09-08T00:00:00.000Z", updated_at: null, ...(c.payload.write as any) };
          t("memories").push(row);
          memoryId = row.id;
          result = row;
          toState = lifecycleStateOf(row.state);
          break;
        }
        case "ADD_MEDIA": {
          const row = { id: `item-${++idCounter}`, created_at: "2026-09-08T00:00:00.000Z", ...(c.payload.write as any) };
          t("memory_items").push(row);
          memoryId = memoryRow.id;
          result = row;
          break;
        }
        case "REMOVE_MEDIA": {
          const before = t("memory_items").length;
          state.tables.memory_items = t("memory_items").filter(
            (i) => !(i.id === c.payload.item_id && i.memory_id === memoryRow.id));
          if (state.tables.memory_items.length === before) {
            restore();
            return rejectWithAudit("MEMORY_ITEM_NOT_FOUND");
          }
          memoryId = memoryRow.id;
          result = { id: c.payload.item_id };
          break;
        }
        case "ADD_PERSON":
        case "REMOVE_PERSON": {
          const tag = t("memory_tags").find(
            (g) => g.memory_id === memoryRow.id && g.tagged_user_id === c.payload.tagged_user_id);
          if (!tag) { restore(); return rejectWithAudit("MEMORY_TAG_NOT_FOUND"); }
          tag.status = c.payload.status;
          memoryId = memoryRow.id;
          result = { status: c.payload.status };
          break;
        }
        default: {
          Object.assign(memoryRow, c.payload.patch ?? {});
          memoryId = memoryRow.id;
          result = memoryRow;
          break;
        }
      }

      const eventType = COMMAND_EVENT[type];
      const eventId = `evt-${++idCounter}`;

      if (state.failOn.has("event")) throw new Error("memory_domain_events insert failed");
      t("memory_domain_events").push({
        event_id: eventId,
        memory_id: memoryId,
        type: eventType,
        actor_user_id: c.actor_user_id,
        causation_id: c.command_id,
        correlation_id: c.correlation_id ?? null,
        // §23 privacy-filtered payload. Ids and vocabulary only — never the
        // Memory's body. lib/memoryOutbox.eventPayloadIsPrivacyFiltered is the
        // rule; src/test/memoryOutbox.test.ts asserts it over these rows.
        payload_json: {
          command_type: type,
          from_state: fromState === null ? null : lifecycleStateOf(fromState),
          to_state: toState,
          visibility: (c.payload.visibility as string | undefined) ?? null,
          refs: {
            memory_id: memoryId,
            actor_user_id: c.actor_user_id,
            item_id: (c.payload.item_id as string | undefined) ?? null,
            tagged_user_id: (c.payload.tagged_user_id as string | undefined) ?? null,
          },
        },
        schema_version: 1,
        occurred_at: c.client_observed_at ?? "2026-09-08T00:00:00.000Z",
        recorded_at: "2026-09-08T00:00:00.000Z",
      });

      if (state.failOn.has("outbox")) throw new Error("memory_event_outbox insert failed");
      t("memory_event_outbox").push({
        id: ++idCounter, event_id: eventId, memory_id: memoryId, type: eventType,
        created_at: "2026-09-08T00:00:00.000Z", published_at: null, attempts: 0,
      });

      if (state.failOn.has("receipt")) throw new Error("memory_command_receipts insert failed");
      t("memory_command_receipts").push({
        actor_user_id: c.actor_user_id, idempotency_key: c.idempotency_key,
        command_id: c.command_id, command_type: type, memory_id: memoryId,
        event_id: eventId, event_type: eventType, result_json: result,
        created_at: "2026-09-08T00:00:00.000Z",
      });

      writeAudit("accepted", null, eventId, memoryId);

      return {
        data: { ok: true, duplicate: false, memory_id: memoryId, event_id: eventId, event_type: eventType, result, contract_version: 1 },
        error: null,
      };
    } catch (e: any) {
      // plpgsql RAISE => the whole transaction rolls back. Nothing the command
      // wrote survives, and the RPC answers with `error` bound and `data` null.
      restore();
      return { data: null, error: { message: e?.message ?? "kernel failure" } };
    }
  };
}

/**
 * An in-memory MODEL of public.highlight_kernel_execute (migration 2993).
 *
 * Deliberately in THIS file and sharing `state.tables` with the Memory model,
 * because the thing most worth exercising is what the two have in common: one
 * `memory_command_receipts` table keyed (actor_user_id, idempotency_key), one
 * `memory_domain_events` stream, one outbox, one audit. A separate fake with
 * its own tables would make the cross-aggregate idempotency rule — an actor
 * may not reuse one key for a different command, whichever kernel it went to —
 * true by construction in the test and untested in fact.
 *
 * WHAT IT MODELS, AND WHAT IT DOES NOT. Same limits as the Memory model above:
 * the transaction, the ordering and the reason codes are modelled; row
 * locking, the CHECK constraints and RLS are the database's and are asserted
 * by migration 2993's own postconditions, not here. One thing IS modelled
 * exactly because it is the point of 2993: the event and outbox rows carry
 * `highlight_id` and a NULL `memory_id`, never the reverse.
 */
function highlightRpc(state: KernelState, args: any) {
  const c = args?.p_command;
  const t = (n: string) => (state.tables[n] ??= []);

  if (!c || typeof c !== "object" || !c.command_id || !c.actor_user_id
      || !c.idempotency_key || typeof c.idempotency_key !== "string"
      || c.idempotency_key.length < 1 || c.idempotency_key.length > 200
      || !c.type || typeof c.payload !== "object" || c.payload === null) {
    return rejected("MEMORY_COMMAND_MALFORMED");
  }
  const type = c.type as MemoryCommandType;
  // The SQL function's IN-list, expressed as the subject map so the two cannot
  // drift: a command this kernel is not for is UNKNOWN_TYPE to it, which is
  // exactly what memory_kernel_execute answers for a Highlight command.
  const known = (MEMORY_COMMAND_TYPES as readonly string[]).includes(type)
    && COMMAND_SUBJECT[type] === "highlight";

  const snapshot = clone(state.tables);
  const restore = () => { for (const k of Object.keys(state.tables)) state.tables[k] = snapshot[k] ?? []; };

  const writeAudit = (outcome: string, reason: string | null, eventId: string | null, highlightId: string | null) => {
    if (state.failOn.has("audit")) throw new Error("memory_command_audit insert failed");
    t("memory_command_audit").push({
      id: `audit-${++idCounter}`,
      command_id: c.command_id,
      command_type: type,
      memory_id: null,
      highlight_id: highlightId,
      actor_user_id: c.actor_user_id,
      idempotency_key: c.idempotency_key,
      outcome,
      reason,
      event_id: eventId,
      created_at: "2026-09-08T00:00:00.000Z",
    });
  };
  const rejectWithAudit = (reason: string, extra: Record<string, unknown> = {}) => {
    try { writeAudit("rejected", reason, null, c.highlight_id ?? null); }
    catch (e: any) { restore(); return { data: null, error: { message: e.message } }; }
    return rejected(reason, extra);
  };

  if (!known) return rejectWithAudit("MEMORY_COMMAND_UNKNOWN_TYPE", { detail: type });

  // §19 — the SAME receipt table as the Memory kernel.
  const receipt = t("memory_command_receipts").find(
    (r) => r.actor_user_id === c.actor_user_id && r.idempotency_key === c.idempotency_key);
  if (receipt) {
    if (receipt.command_type !== type) {
      return rejectWithAudit("MEMORY_IDEMPOTENCY_KEY_REUSED", { detail: `key already used for ${receipt.command_type}` });
    }
    try { writeAudit("duplicate", null, receipt.event_id, receipt.highlight_id ?? null); }
    catch (e: any) { restore(); return { data: null, error: { message: e.message } }; }
    return {
      data: {
        ok: true, duplicate: true, highlight_id: receipt.highlight_id ?? null,
        event_id: receipt.event_id, event_type: receipt.event_type,
        result: receipt.result_json, contract_version: 1,
      },
      error: null,
    };
  }

  if (!c.highlight_id) return rejectWithAudit("MEMORY_COMMAND_MALFORMED", { detail: "highlight_id required" });

  const row = t("highlights").find((h) => h.id === c.highlight_id);
  if (!row || row.deleted_at != null) return rejectWithAudit("HIGHLIGHT_NOT_FOUND");
  // §23, re-checked here and not trusted from the caller.
  if (row.owner_id !== c.actor_user_id) return rejectWithAudit("HIGHLIGHT_AUTH_NOT_OWNER");

  const nowIso = "2026-09-08T00:00:00.000Z";
  const derived = (r: any): string =>
    r.archived_at != null ? "HIDDEN"
    : r.pinned_at != null ? "PINNED"
    : (r.expires_at != null && r.expires_at <= nowIso) ? "EXPIRED"
    : "ACTIVE";
  const fromState = derived(row);

  try {
    if (state.failOn.has("state")) throw new Error("canonical write failed");

    let result: any;
    switch (type) {
      case "PIN_HIGHLIGHT":   row.pinned_at = nowIso;   result = { id: row.id, pinned_at: nowIso }; break;
      case "UNPIN_HIGHLIGHT": row.pinned_at = null;     result = { id: row.id, pinned_at: null }; break;
      default:                row.archived_at = nowIso; result = { id: row.id, archived_at: nowIso }; break;
    }
    const toState = derived(row);
    const eventType = COMMAND_EVENT[type];
    const eventId = `evt-${++idCounter}`;

    if (state.failOn.has("event")) throw new Error("memory_domain_events insert failed");
    t("memory_domain_events").push({
      event_id: eventId,
      // 2993's memory_domain_events_one_subject: exactly one subject, and for
      // a Highlight command it is never the Memory column.
      memory_id: null,
      highlight_id: row.id,
      type: eventType,
      actor_user_id: c.actor_user_id,
      causation_id: c.command_id,
      correlation_id: c.correlation_id ?? null,
      payload_json: {
        command_type: type,
        from_state: fromState,
        to_state: toState,
        state_provenance: "derived",
        pinned: type === "PIN_HIGHLIGHT",
        visibility: null,
        refs: { highlight_id: row.id, memory_id: null, actor_user_id: c.actor_user_id },
      },
      schema_version: 1,
      occurred_at: c.client_observed_at ?? nowIso,
      recorded_at: nowIso,
    });

    if (state.failOn.has("outbox")) throw new Error("memory_event_outbox insert failed");
    t("memory_event_outbox").push({
      id: ++idCounter, event_id: eventId, memory_id: null, highlight_id: row.id,
      type: eventType, created_at: nowIso, published_at: null, attempts: 0,
    });

    if (state.failOn.has("receipt")) throw new Error("memory_command_receipts insert failed");
    t("memory_command_receipts").push({
      actor_user_id: c.actor_user_id, idempotency_key: c.idempotency_key,
      command_id: c.command_id, command_type: type, memory_id: null,
      highlight_id: row.id, event_id: eventId, event_type: eventType,
      result_json: result, created_at: nowIso,
    });

    writeAudit("accepted", null, eventId, row.id);

    return {
      data: {
        ok: true, duplicate: false, highlight_id: row.id, event_id: eventId,
        event_type: eventType, result, contract_version: 1,
      },
      error: null,
    };
  } catch (e: any) {
    restore();
    return { data: null, error: { message: e?.message ?? "kernel failure" } };
  }
}
