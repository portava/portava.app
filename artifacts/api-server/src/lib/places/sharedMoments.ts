import { isLivePlacesCapabilityEnabled } from "../featureFlags.js";

export type MomentRole = "owner" | "manager" | "member";

export async function areSharedMomentsEnabled(sc: any): Promise<boolean> {
  return isLivePlacesCapabilityEnabled(sc, "shared_moments_enabled");
}

export async function momentRole(sc: any, momentId: string, userId: string): Promise<MomentRole | null> {
  const { data } = await sc.from("shared_moment_memberships")
    .select("role, status").eq("moment_id", momentId).eq("user_id", userId).maybeSingle();
  return (data as any)?.status === "accepted" ? (data as any).role as MomentRole : null;
}

export async function appendMomentAudit(sc: any, momentId: string, actorId: string, eventType: string, metadata: Record<string, unknown> = {}): Promise<void> {
  const { error } = await sc.from("shared_moment_audit_events").insert({
    moment_id: momentId, actor_id: actorId, event_type: eventType, metadata,
  });
  if (error) throw error;
}