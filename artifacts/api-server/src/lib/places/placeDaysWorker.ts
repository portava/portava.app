import { getServiceClient } from "../supabase.js";
import { logger } from "../logger.js";
import { runPlaceDayLifecycleTick } from "./placeDays.js";

const INTERVAL_MS = 15 * 60 * 1_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function startPlaceDayLifecycleWorker(): void {
  if (timer) return;
  const tick = async () => {
    const result = await runPlaceDayLifecycleTick(getServiceClient());
    logger.info(result, "place-day lifecycle tick complete");
  };
  void tick().catch((err) => logger.warn({ err }, "place-day lifecycle tick failed"));
  timer = setInterval(() => void tick().catch((err) => logger.warn({ err }, "place-day lifecycle tick failed")), INTERVAL_MS);
  timer.unref?.();
}