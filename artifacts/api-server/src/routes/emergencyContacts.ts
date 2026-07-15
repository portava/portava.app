/**
 * Emergency Contacts routes (profile-level)
 *
 * GET    /api/me/emergency-contacts          — list
 * POST   /api/me/emergency-contacts          — create
 * PATCH  /api/me/emergency-contacts/:id      — update
 * DELETE /api/me/emergency-contacts/:id      — remove
 *
 * Max 10 contacts per user.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";

const router = Router();

const contactSchema = z.object({
  name:          z.string().min(1).max(200),
  label:         z.string().max(100).optional().default(""),
  phone:         z.string().max(30).optional().nullable(),
  email:         z.string().email().max(200).optional().nullable(),
  notifyMethod:  z.enum(["in_app", "sms", "email"]).optional().default("in_app"),
  sortOrder:     z.number().int().min(0).max(99).optional().default(0),
});

const patchSchema = contactSchema.partial();

function toRow(contact: any) {
  return {
    id:            contact.id,
    label:         contact.label ?? "",
    name:          contact.name,
    phone:         contact.phone ?? null,
    email:         contact.email ?? null,
    notifyMethod:  contact.notify_method,
    sortOrder:     contact.sort_order,
    createdAt:     contact.created_at,
    updatedAt:     contact.updated_at,
  };
}

// ── GET /api/me/emergency-contacts ────────────────────────────────────────────

router.get("/me/emergency-contacts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { sendError(res, "db_error", "Service client not available"); return; }

  const { data, error } = await db
    .from("profile_emergency_contacts")
    .select("*")
    .eq("user_id", user.id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(200).json({ contacts: ((data as any[]) ?? []).map(toRow) });
});

// ── POST /api/me/emergency-contacts ───────────────────────────────────────────

router.post("/me/emergency-contacts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { sendError(res, "db_error", "Service client not available"); return; }

  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // Enforce max 10 contacts per user
  const { count } = await db
    .from("profile_emergency_contacts")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);

  if ((count ?? 0) >= 10) {
    sendError(res, "forbidden", "You can have at most 10 emergency contacts");
    return;
  }

  const { data, error } = await db
    .from("profile_emergency_contacts")
    .insert({
      user_id:       user.id,
      name:          parsed.data.name,
      label:         parsed.data.label,
      phone:         parsed.data.phone ?? null,
      email:         parsed.data.email ?? null,
      notify_method: parsed.data.notifyMethod,
      sort_order:    parsed.data.sortOrder,
    })
    .select("*")
    .single();

  if (error || !data) { sendError(res, "db_error", error?.message ?? "Insert failed"); return; }

  res.status(201).json({ ok: true, contact: toRow(data as any) });
});

// ── PATCH /api/me/emergency-contacts/:id ──────────────────────────────────────

router.patch("/me/emergency-contacts/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { sendError(res, "db_error", "Service client not available"); return; }

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const patch: Record<string, any> = {};
  if (parsed.data.name          !== undefined) patch.name          = parsed.data.name;
  if (parsed.data.label         !== undefined) patch.label         = parsed.data.label;
  if ("phone"         in parsed.data)          patch.phone         = parsed.data.phone ?? null;
  if ("email"         in parsed.data)          patch.email         = parsed.data.email ?? null;
  if (parsed.data.notifyMethod  !== undefined) patch.notify_method = parsed.data.notifyMethod;
  if (parsed.data.sortOrder     !== undefined) patch.sort_order    = parsed.data.sortOrder;
  patch.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("profile_emergency_contacts")
    .update(patch)
    .eq("id", req.params.id)
    .eq("user_id", user.id)
    .select("*")
    .single();

  if (error || !data) { sendError(res, "not_found", "Contact not found"); return; }

  res.status(200).json({ ok: true, contact: toRow(data as any) });
});

// ── DELETE /api/me/emergency-contacts/:id ─────────────────────────────────────

router.delete("/me/emergency-contacts/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { sendError(res, "db_error", "Service client not available"); return; }

  const { error, count } = await db
    .from("profile_emergency_contacts")
    .delete({ count: "exact" })
    .eq("id", req.params.id)
    .eq("user_id", user.id);

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!count) { sendError(res, "not_found", "Contact not found"); return; }

  res.status(200).json({ ok: true });
});

export default router;
