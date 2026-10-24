/**
 * Telegraph §14.3 — adding people to a direct conversation, client side (census T212, T213, T390).
 *
 *   POST /api/threads/:id/add-people   { userIds, carryForward?, title? }  -> 201 { threadId, ... }
 *
 * §14.3: "Adding a third person to a DM creates a new group; it does not expose the old DM history."
 * The server forms a NEW `group` conversation of the DM's two people plus the added ones; the DM is
 * never written and no message is copied. "Explicitly selected Plans/Places may be carried forward as
 * new share objects" — the client sends only what the person ticked, by kind and canonical id, and the
 * server re-checks that every member of the new group can see each one.
 *
 * This module decides nothing. Every refusal (a block, a restriction, someone who cannot be added, a
 * plan someone cannot see) is the server's, and its sentence is shown as it came.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

/** The server's own limits (services/telegraph/groupFormation.ts). The server enforces them; these only shape the sheet. */
export const MAX_ADDED_PEOPLE = 10;
export const MAX_CARRY_FORWARD = 10;
export const MAX_GROUP_TITLE = 80;

export type CarryForwardKind = 'PLAN' | 'PLACE';

export interface CarryForwardSelection {
  kind: CarryForwardKind;
  objectId: string;
}

export interface AddPeopleRequest {
  userIds: string[];
  carryForward?: CarryForwardSelection[];
  title?: string | null;
}

export interface AddPeopleCreated {
  threadId: string;
  memberUserIds: string[];
  carriedForward: Array<{ kind: CarryForwardKind; objectId: string; messageId: string }>;
  /** §14.3 on the wire: the new conversation starts empty of the DM. */
  historyFrom: 'formation';
}

export type AddPeopleResult =
  | { ok: true; data: AddPeopleCreated }
  | { ok: false; error: string; message: string };

const GENERIC_REFUSAL = 'The group was not created. Nothing was changed.';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/**
 * The body exactly as the server's strict schema takes it: no empty carry-forward list, no blank
 * title, de-duplicated ids. A body the server would refuse for shape is not sent.
 */
export function buildAddPeopleBody(req: AddPeopleRequest): Record<string, unknown> {
  const userIds = [...new Set(req.userIds.filter((id) => typeof id === 'string' && id.length > 0))];
  const seen = new Set<string>();
  const carryForward = (req.carryForward ?? []).filter((c) => {
    const key = `${c.kind}:${c.objectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const title = typeof req.title === 'string' ? req.title.trim().slice(0, MAX_GROUP_TITLE) : '';
  return {
    userIds,
    ...(carryForward.length > 0 ? { carryForward } : {}),
    ...(title ? { title } : {}),
  };
}

export async function addPeopleToConversation(threadId: string, req: AddPeopleRequest): Promise<AddPeopleResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured', message: GENERIC_REFUSAL };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated', message: GENERIC_REFUSAL };
  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/add-people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(buildAddPeopleBody(req)),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(body?.error ?? res.status),
        message: typeof body?.message === 'string' && body.message.length > 0 ? body.message : GENERIC_REFUSAL,
      };
    }
    // A 2xx without the new conversation's id is not a group anyone can open.
    if (typeof body?.threadId !== 'string' || body.threadId.length === 0) {
      return { ok: false, error: 'malformed_response', message: GENERIC_REFUSAL };
    }
    return { ok: true, data: body as unknown as AddPeopleCreated };
  } catch {
    return { ok: false, error: 'network', message: GENERIC_REFUSAL };
  }
}
