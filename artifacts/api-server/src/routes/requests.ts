import { Router } from "express";
import { requireUser } from "../lib/http";

const router = Router();

const PROFILE_PUBLIC = "id, handle, name, avatar_url";

interface Actor {
  id: string;
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
}

interface InboxItem {
  id: string;
  type: "friend_request" | "circle_invite" | "trip_invite";
  direction: "incoming" | "outgoing";
  status: string;
  actor: Actor | null;
  targetName: string | null;
  createdAt: string;
}

function profileToActor(p: any): Actor | null {
  if (!p) return null;
  return { id: p.id, handle: p.handle ?? null, name: p.name ?? null, avatarUrl: p.avatar_url ?? null };
}

async function batchProfiles(sc: any, ids: string[]): Promise<Record<string, any>> {
  if (ids.length === 0) return {};
  const { data } = await sc.from("profiles").select(PROFILE_PUBLIC).in("id", ids);
  const map: Record<string, any> = {};
  for (const p of (data ?? [])) map[p.id] = p;
  return map;
}

/* =============================================================================
 * GET /me/requests  — unified inbox list (friend requests, circle invites, trip invites)
 *
 * Returns { items: InboxItem[] } sorted newest-first.
 * Each item carries direction: 'incoming' | 'outgoing' so the client can
 * split them into two tabs without a second round-trip.
 * =============================================================================
 */
router.get("/me/requests", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const [
    { data: frIn },
    { data: frOut },
    { data: ciIn },
    { data: ciOut },
    { data: tripInvited },
  ] = await Promise.all([
    sc.from("friend_requests").select("id, status, created_at, requester_id")
      .eq("recipient_id", user.id).eq("status", "pending").order("created_at", { ascending: false }),
    sc.from("friend_requests").select("id, status, created_at, recipient_id")
      .eq("requester_id", user.id).eq("status", "pending").order("created_at", { ascending: false }),
    sc.from("circle_invites").select("id, status, created_at, owner_id")
      .eq("recipient_id", user.id).eq("status", "pending").order("created_at", { ascending: false }),
    sc.from("circle_invites").select("id, status, created_at, recipient_id")
      .eq("owner_id", user.id).eq("status", "pending").order("created_at", { ascending: false }),
    sc.from("trip_members").select("trip_id, created_at")
      .eq("user_id", user.id).eq("role", "invited").order("created_at", { ascending: false }),
  ]);

  // Enrich trip invites: look up trip titles and owner IDs
  const tripIds = [...new Set((tripInvited ?? []).map((r: any) => r.trip_id as string))];
  let tripTitleMap: Record<string, string | null> = {};
  let tripOwnerMap: Record<string, string> = {};
  if (tripIds.length > 0) {
    const [{ data: tripsData }, { data: ownerRows }] = await Promise.all([
      sc.from("trips").select("id, title").in("id", tripIds),
      sc.from("trip_members").select("trip_id, user_id").in("trip_id", tripIds).eq("role", "owner"),
    ]);
    for (const t of (tripsData ?? [])) tripTitleMap[t.id] = t.title ?? null;
    for (const r of (ownerRows ?? [])) tripOwnerMap[r.trip_id] = r.user_id;
  }

  // Collect all actor IDs for a single batch profile fetch
  const actorIds = new Set<string>([
    ...(frIn ?? []).map((r: any) => r.requester_id),
    ...(frOut ?? []).map((r: any) => r.recipient_id),
    ...(ciIn ?? []).map((r: any) => r.owner_id),
    ...(ciOut ?? []).map((r: any) => r.recipient_id),
    ...Object.values(tripOwnerMap),
  ]);
  const profileMap = await batchProfiles(sc, [...actorIds].filter(Boolean));

  const items: InboxItem[] = [];

  for (const r of (frIn ?? [])) {
    items.push({
      id: r.id, type: "friend_request", direction: "incoming", status: r.status,
      actor: profileToActor(profileMap[r.requester_id]), targetName: null, createdAt: r.created_at,
    });
  }
  for (const r of (ciIn ?? [])) {
    items.push({
      id: r.id, type: "circle_invite", direction: "incoming", status: r.status,
      actor: profileToActor(profileMap[r.owner_id]), targetName: null, createdAt: r.created_at,
    });
  }
  for (const r of (tripInvited ?? [])) {
    items.push({
      id: r.trip_id, type: "trip_invite", direction: "incoming", status: "invited",
      actor: profileToActor(profileMap[tripOwnerMap[r.trip_id]]), targetName: tripTitleMap[r.trip_id] ?? null,
      createdAt: r.created_at,
    });
  }
  for (const r of (frOut ?? [])) {
    items.push({
      id: r.id, type: "friend_request", direction: "outgoing", status: r.status,
      actor: profileToActor(profileMap[r.recipient_id]), targetName: null, createdAt: r.created_at,
    });
  }
  for (const r of (ciOut ?? [])) {
    items.push({
      id: r.id, type: "circle_invite", direction: "outgoing", status: r.status,
      actor: profileToActor(profileMap[r.recipient_id]), targetName: null, createdAt: r.created_at,
    });
  }

  res.status(200).json({ items });
});

/* =============================================================================
 * GET /me/requests/count  — incoming-only pending count (used for nav badge)
 * =============================================================================
 */
router.get("/me/requests/count", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const [{ data: frRows }, { data: ciRows }, { data: tiRows }] = await Promise.all([
    sc.from("friend_requests").select("id").eq("recipient_id", user.id).eq("status", "pending"),
    sc.from("circle_invites").select("id").eq("recipient_id", user.id).eq("status", "pending"),
    sc.from("trip_members").select("trip_id").eq("user_id", user.id).eq("role", "invited"),
  ]);

  const count = (frRows ?? []).length + (ciRows ?? []).length + (tiRows ?? []).length;
  res.status(200).json({ count });
});

export default router;
