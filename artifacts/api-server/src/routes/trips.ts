import { Router } from "express";
import { getServiceClient, isServiceClientReady } from "../lib/supabase";

const router = Router();

router.post("/trips", async (req, res) => {
  if (!isServiceClientReady) {
    res.status(503).json({ error: "Server not configured: SUPABASE_SERVICE_ROLE_KEY is missing" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const token = authHeader.slice(7);

  const client = getServiceClient()!;

  // Verify user JWT via Supabase Auth directly — this works regardless of
  // whether PostgREST supports ECC P-256 JWT verification.
  const { data: { user }, error: authError } = await client.auth.getUser(token);
  if (authError || !user) {
    res.status(401).json({ error: authError?.message ?? "Invalid or expired token" });
    return;
  }

  const { title, destinationCity, destinationCountry, startDate, endDate, status, visibility, coverUrl } = req.body;

  if (!title || !destinationCity) {
    res.status(400).json({ error: "title and destinationCity are required" });
    return;
  }

  const { data, error } = await client
    .from("trips")
    .insert({
      owner_id: user.id,
      title,
      destination_city: destinationCity,
      destination_country: destinationCountry ?? null,
      start_date: startDate ?? null,
      end_date: endDate ?? null,
      status: status ?? "planning",
      visibility: visibility ?? "private",
      cover_url: coverUrl ?? null,
    })
    .select("*")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert trip");
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(data);
});

/* ===========================================================================
 * POST /trips/:tripId/invite  — trip owner invites a user
 * ===========================================================================
 * Reuses the existing trip_members table with role='invited'.
 * Friendship alone NEVER creates this row — only explicit owner invitation.
 */
router.post("/trips/:tripId/invite", async (req, res) => {
  if (!isServiceClientReady) {
    res.status(503).json({ error: "server_not_configured" });
    return;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing Authorization header" }); return; }

  const client = getServiceClient()!;
  const { data: { user }, error: authErr } = await client.auth.getUser(authHeader.slice(7));
  if (authErr || !user) { res.status(401).json({ error: "Invalid or expired token" }); return; }

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const userId = req.body?.userId;
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) { res.status(400).json({ error: "invalid_payload", message: "userId must be a valid UUID" }); return; }
  if (userId === user.id) { res.status(400).json({ error: "invalid_payload", message: "You cannot invite yourself" }); return; }

  // Only the trip owner may invite
  const { data: trip } = await client.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { res.status(404).json({ error: "not_found", message: "Trip not found" }); return; }
  if ((trip as any).owner_id !== user.id) { res.status(403).json({ error: "forbidden", message: "Only the trip owner can invite members" }); return; }

  // Idempotent: check existing membership
  const { data: existing } = await client.from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", userId).maybeSingle();
  if (existing) { res.status(200).json({ status: "already_member", role: (existing as any).role, idempotent: true }); return; }

  const { error } = await client.from("trip_members").insert({ trip_id: tripId, user_id: userId, role: "invited" });
  if (error) { res.status(500).json({ error: "db_error", message: error.message }); return; }

  res.status(201).json({ status: "invited", tripId, userId });
});

/* ===========================================================================
 * POST /trips/:tripId/accept-invite  — invitee accepts their trip invitation
 * ===========================================================================
 */
router.post("/trips/:tripId/accept-invite", async (req, res) => {
  if (!isServiceClientReady) { res.status(503).json({ error: "server_not_configured" }); return; }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing Authorization header" }); return; }

  const client = getServiceClient()!;
  const { data: { user }, error: authErr } = await client.auth.getUser(authHeader.slice(7));
  if (authErr || !user) { res.status(401).json({ error: "Invalid or expired token" }); return; }

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const { data: membership } = await client
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();

  if (!membership) { res.status(404).json({ error: "not_found", message: "No invitation found for this trip" }); return; }
  if ((membership as any).role !== "invited") { res.status(400).json({ error: "invalid_payload", message: `Already a ${(membership as any).role}` }); return; }

  const { error } = await client.from("trip_members").update({ role: "member" }).eq("trip_id", tripId).eq("user_id", user.id);
  if (error) { res.status(500).json({ error: "db_error", message: error.message }); return; }

  res.status(200).json({ status: "accepted", tripId, role: "member" });
});

/* ===========================================================================
 * POST /trips/:tripId/decline-invite  — invitee declines their trip invitation
 * ===========================================================================
 */
router.post("/trips/:tripId/decline-invite", async (req, res) => {
  if (!isServiceClientReady) { res.status(503).json({ error: "server_not_configured" }); return; }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { res.status(401).json({ error: "Missing Authorization header" }); return; }

  const client = getServiceClient()!;
  const { data: { user }, error: authErr } = await client.auth.getUser(authHeader.slice(7));
  if (authErr || !user) { res.status(401).json({ error: "Invalid or expired token" }); return; }

  const { tripId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tripId)) { res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" }); return; }

  const { data: membership } = await client
    .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle();

  if (!membership) { res.status(404).json({ error: "not_found", message: "No invitation found for this trip" }); return; }
  if ((membership as any).role !== "invited") { res.status(400).json({ error: "invalid_payload", message: "Cannot decline — you are already a member" }); return; }

  const { error } = await client.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", user.id);
  if (error) { res.status(500).json({ error: "db_error", message: error.message }); return; }

  res.status(200).json({ status: "declined", tripId });
});

export default router;
