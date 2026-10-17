import { randomUUID } from "node:crypto";
import { executeMemoryCommand, memoryKernelClient } from "../../lib/memoryCommandBus.js";

export const RESURFACING_POLICY_FLAG = "memory_resurfacing_policy_enabled";

export type PolicyFailure = "invalid" | "not_owned" | "not_private" | "not_deployed" | "unavailable" | "key_reused";
export type PolicyWrite = { ok: true; value: any } | { ok: false; reason: PolicyFailure; detail: string };

export async function writeResurfacingPolicy(
  sc: any,
  ownerId: string,
  payload: { target: { kind: "memory" | "highlight" | "person" | "trip"; id: string }; control: string; on: boolean; confirmed?: boolean },
  idempotencyKey?: string,
): Promise<PolicyWrite | null> {
  try {
    const gate = await sc.from("feature_flags").select("enabled").eq("flag", RESURFACING_POLICY_FLAG).maybeSingle();
    if (!gate || gate.error !== null || !(gate.data === null || typeof gate.data?.enabled === "boolean")) {
      return { ok: false, reason: "unavailable", detail: "Resurfacing policy gate is unreadable" };
    }
    if (gate.data === null || gate.data.enabled === false) return null;
  } catch {
    return { ok: false, reason: "unavailable", detail: "Resurfacing policy gate is unreadable" };
  }
  const kernel = await memoryKernelClient(sc);
  if (!kernel) return { ok: false, reason: "unavailable", detail: "Memory kernel is unavailable for resurfacing policy commands" };
  const key = idempotencyKey?.trim();
  if (!key || key.length > 200) return { ok: false, reason: "invalid", detail: "Idempotency-Key must contain 1–200 characters" };
  const result = await executeMemoryCommand(kernel, { type: "SET_RESURFACING_POLICY", commandId: randomUUID(),
    memoryId: null, actorUserId: ownerId, idempotencyKey: key, payload });
  if (result.ok) return { ok: true, value: result.result };
  const reasons: Partial<Record<typeof result.reason, PolicyFailure>> = {
    MEMORY_COMMAND_MALFORMED: "invalid", MEMORY_NOT_FOUND: "not_owned", HIGHLIGHT_NOT_FOUND: "not_owned",
    MEMORY_AUTH_NOT_OWNER: "not_owned", HIGHLIGHT_AUTH_NOT_OWNER: "not_owned",
    RESURFACING_NOT_PRIVATE: "not_private", RESURFACING_NOT_DEPLOYED: "not_deployed", MEMORY_IDEMPOTENCY_KEY_REUSED: "key_reused",
  };
  return { ok: false, reason: reasons[result.reason] ?? "unavailable", detail: result.detail ?? result.reason };
}
