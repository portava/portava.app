/**
 * discoveryStopGate — the stop reaches every path the Discovery rollout turns
 * on, not only DISCOVERY_ENGINE_MODE. census-discovery §97 (lane W11-S),
 * register D-W11S-1.
 *
 * `12` "Stop conditions": "Stop rollout if: event rejection rises,
 * recommendation logging gaps appear, creator concentration spikes …". Until
 * §97 the halt was taken in one place, lib/discoveryEngineMode.ts, which
 * resolves the engine mode to `legacy`. But the rollout reaches users through
 * more switches than the mode:
 *   3455 `discovery_for_you_pde_enabled`     for_you ordered by PDE, any mode
 *   3456 `discovery_cache_a_ranked_enabled`  Cache A hits ranked, any mode
 *   §78's six design flags (3450–3454)       read by lib/discoveryRankFlags
 *   §85's pipeline flags (3480–3484)         read by lib/discoveryCandidates/pipelineFlags
 * and every one of them was read without the stop state, so a trip left them in
 * force and the recovery was a manual flag flip (owner approval request,
 * action 8). Each of those readers now asks this module, and ONLY when its own
 * flag reads ON: a flag-off request never reaches here, so its reads and its
 * bytes are exactly what they were.
 *
 * WHAT HALTS
 * ==========
 * - A tripped `12` condition (lib/discoveryStopConditions `evaluateStopConditions`),
 *   the same verdict the engine-mode resolver takes. In-process, no read.
 * - The manual stop, `disable_discovery_pde` TRUE, read fail-CLOSED through
 *   `isKillSwitchEngaged` (an error ENGAGES it), as the resolver reads it for
 *   `pde` (ruling D3=B). Every path above is PDE serving, so the switch that
 *   says "disable PDE" disables it on each of them.
 * A halt is "the flag reads OFF", never a new behaviour: the caller then serves
 * exactly its flag-off output. It is not a latch. When the stop clears, the
 * flags read as set again, as the engine mode returns to its configured state.
 *
 * WHY THE GATE ALSO MEASURES
 * ==========================
 * The resolver refreshes 3391's database conditions only for a non-legacy mode.
 * 3455 and 3456 serve PDE in `legacy` too, and there the four database
 * conditions were never measured. While either is ON, their reader asks this
 * module to run the same single-flight refresh (`measure: true`), at most once
 * per 30 s per client, so the stop watches what those flags serve whatever the
 * mode. The §78 and §85 readers do NOT measure: they are handed a
 * write-suppressed client on every shadow run, whose `rpc` answers inertly, and
 * a refresh through it would record four bogus `unreadable` readings (which
 * halt once armed). Their flags are activated in `pde` cohorts (approval
 * request action 10), where the resolver already measures.
 */
import { isKillSwitchEngaged } from "./featureFlags.js";
import { logger } from "./logger.js";
import { evaluateStopConditions } from "./discoveryStopConditions.js";
import { refreshDiscoveryStopMeasurements } from "./discoveryStopMeasurements.js";

const TTL_MS = 30_000;

/** Per client object: the last measurement refresh, the cached manual-stop read and the last halt log. */
interface ClientGateState { refreshedAt: number; kill: { value: boolean; at: number } | null; loggedAt: number }
const _state = new WeakMap<object, ClientGateState>();
const NO_CLIENT: ClientGateState = { refreshedAt: -Infinity, kill: null, loggedAt: -Infinity };

function stateFor(sc: unknown): ClientGateState {
  if (!sc || typeof sc !== "object") return NO_CLIENT;
  let s = _state.get(sc);
  if (!s) { s = { refreshedAt: -Infinity, kill: null, loggedAt: -Infinity }; _state.set(sc, s); }
  return s;
}

export type DiscoveryStopHalt = "stop_condition" | "kill_switch_engaged" | null;

/**
 * Why a rollout flag that reads ON must be served as OFF right now, or null.
 * Called only by a reader whose flag is ON. Never throws: anything unexpected
 * is a halt, because a halt only returns the flag-off output users already had.
 */
export async function discoveryStopHalt(sc: unknown, opts: { measure?: boolean } = {}, nowMs: number = Date.now()): Promise<DiscoveryStopHalt> {
  const s = stateFor(sc);
  try {
    if (opts.measure === true && sc && nowMs - s.refreshedAt >= TTL_MS) {
      s.refreshedAt = nowMs;
      void refreshDiscoveryStopMeasurements(sc);
    }
    let halt: DiscoveryStopHalt = null;
    if (evaluateStopConditions().tripped.length > 0) halt = "stop_condition";
    else {
      if (!s.kill || nowMs - s.kill.at >= TTL_MS) {
        s.kill = { value: sc ? await isKillSwitchEngaged(sc, "disable_discovery_pde") : false, at: nowMs };
      }
      if (s.kill.value) halt = "kill_switch_engaged";
    }
    if (halt && nowMs - s.loggedAt >= TTL_MS) {
      s.loggedAt = nowMs;
      logger.warn({ halt }, "discoveryStopGate: the Discovery stop is engaged — rollout flags (3455, 3456, §78, §85) read OFF");
    }
    return halt;
  } catch (err) {
    logger.warn({ err }, "discoveryStopGate: the stop check threw — rollout flags read OFF");
    return "stop_condition";
  }
}

/** `flagOn && !halted`. The one shape every gated reader uses; a flag that reads OFF costs nothing here. */
export async function unlessDiscoveryStopped(sc: unknown, flagOn: boolean, opts: { measure?: boolean } = {}): Promise<boolean> {
  return flagOn && (await discoveryStopHalt(sc, opts)) === null;
}
