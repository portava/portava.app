import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAccountRestriction } from "../../accountStateGate.js";
import { readFlagState } from "../../capability/schemaCapability.js";
import { UUID, validSource, type VisualSource } from "./contracts.js";
import type { VisualIndexContext } from "./localVisualIndexProvider.js";

export function ownsVisualStorage(source: VisualSource): boolean {
  const parts = source.path.split("/");
  return validSource(source) && UUID.test(source.ownerId) && parts.length >= 2 && parts[0] === source.ownerId &&
    parts.every(part => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
}

export async function visualIndexWorkEnabled(ctx: VisualIndexContext): Promise<boolean> {
  if (ctx.env.MEDIA_VISUAL_INDEX_ENABLED !== "1") return false;
  // Two literal reads, in order, through the shared four-state reader: an unreadable flag throws, anything but "on" is off.
  const vision = await readFlagState(ctx.sc, "media_vision_provider_enabled");
  if (vision === "unreadable") throw new Error("visual feature state unavailable");
  if (vision !== "on") return false;
  const derivatives = await readFlagState(ctx.sc, "media_derivative_jobs_enabled");
  if (derivatives === "unreadable") throw new Error("visual feature state unavailable");
  return derivatives === "on";
}

export async function assertVisualIndexOwnerActive(sc: SupabaseClient, ownerId: string): Promise<void> {
  const profile = await sc.from("profiles").select("id,account_status").eq("id", ownerId).maybeSingle();
  if (profile.error || profile.data?.id !== ownerId || profile.data?.account_status !== "active") throw new Error("visual owner unavailable");
  const account = await resolveAccountRestriction(sc, ownerId);
  if (account.state !== "ok" || account.accountStatus !== "active" || account.restriction.kind !== "none") throw new Error("visual owner unavailable");
}

export async function withVisualAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("visual operation cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
