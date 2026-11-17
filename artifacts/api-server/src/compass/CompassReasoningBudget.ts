/** One model-time budget shared by every round, including the final summary.
 * Starts at request arrival so slow context assembly consumes the allowance.
 * This does not cancel database writes or claim an end-to-end route deadline. */
export const COMPASS_REASONING_DEADLINE_MS = 65_000;
export const COMPASS_MODEL_ROUND_MS = 25_000;
const FINAL_ANSWER_RESERVE_MS = 30_000;

export class CompassReasoningTimeout extends Error {
  constructor() { super("compass_reasoning_timeout"); this.name = "CompassReasoningTimeout"; }
}

export class CompassReasoningBudget {
  constructor(
    private readonly startedAtMs: number,
    private readonly clientSignal?: AbortSignal,
    private readonly clock: () => number = Date.now,
    private readonly totalMs = COMPASS_REASONING_DEADLINE_MS,
  ) {}

  remainingMs(): number { return Math.max(0, this.totalMs - (this.clock() - this.startedAtMs)); }
  shouldFinish(): boolean { return this.remainingMs() <= FINAL_ANSWER_RESERVE_MS; }

  check(): void {
    if (this.clientSignal?.aborted) throw this.clientSignal.reason ?? new Error("client_disconnected");
    if (this.remainingMs() <= 0) throw new CompassReasoningTimeout();
  }

  /** The race also bounds transports that ignore AbortSignal. Late completion
   * is observed but cannot reach the caller, persist an answer, or emit deltas. */
  async run<T>(work: (signal: AbortSignal, timeoutMs: number) => Promise<T>): Promise<T> {
    this.check();
    const timeoutMs = Math.min(COMPASS_MODEL_ROUND_MS, this.remainingMs());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const disconnected = () => controller.abort(this.clientSignal?.reason ?? new Error("client_disconnected"));
    this.clientSignal?.addEventListener("abort", disconnected, { once: true });
    timer = setTimeout(() => controller.abort(new CompassReasoningTimeout()), timeoutMs);
    try {
      // Check again after listener registration to close the disconnect race.
      if (this.clientSignal?.aborted) disconnected();
      const result = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return work(controller.signal, timeoutMs);
      });
      const answer = await Promise.race([result, aborted]);
      this.check();
      return answer;
    } finally {
      clearTimeout(timer);
      this.clientSignal?.removeEventListener("abort", disconnected);
    }
  }
}
