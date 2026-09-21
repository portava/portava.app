/**
 * Telegraph §28 / §30A.17 observability middleware.
 *
 * WHY A MIDDLEWARE AND NOT CALLS INSIDE THE HANDLERS
 * -------------------------------------------------
 * Three reasons, and the third is the one that decided it.
 *
 *  1. It measures what the USER waits for. A counter inside a handler starts
 *     after routing, body parsing and auth; this one wraps all of it, which is
 *     the number an availability target is actually about.
 *  2. It cannot be forgotten. A new Telegraph command surface is measured the
 *     day it is added, because the classifier matches paths, not call sites. A
 *     per-handler counter is a thing somebody has to remember, and the §28 rows
 *     exist because nobody did.
 *  3. It adds nothing to the files it measures. The messaging tree is held by
 *     another lane this week, and instrumentation that required editing
 *     routes/messaging.ts would be instrumentation that collided with the work
 *     it was measuring.
 *
 * WHAT COUNTS AS A FAILURE, WHICH IS THE WHOLE DESIGN
 * --------------------------------------------------
 * A 4xx REFUSAL is not an availability failure. 403, 404 and 422 are guards
 * doing their job, and counting them as failures would make every hardening
 * change look like an outage and every outage look like hardening — the metric
 * would move for the wrong reasons in both directions. So:
 *
 *   2xx                          ok
 *   5xx                          violation
 *   degraded_unavailable (503)   violation — this is the shape the tree uses
 *                                when a guard's INPUT failed, and it is exactly
 *                                the event an availability target is for
 *   403 / 404 / 422              neither; recorded as `unknown` so the
 *                                denominator does not quietly absorb them
 *   400                          neither — a malformed request is the client's
 *
 * PRIVACY
 * -------
 * Nothing is recorded but a metric key, an outcome and a duration. No path
 * parameters, no user id, no body. The recorder's signature cannot carry them.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { recordTelegraphMetric } from "../domain/telegraph/services/telegraphObservability.js";

/** Which SLO a request belongs to. */
type Surface =
  | "command"
  | "read_projection"
  | "seen"
  | "coordination_confirm"
  | null;

/**
 * Classify by METHOD + PATH SHAPE.
 *
 * The express req.path here is the full mounted path ("/api/threads/<uuid>/messages"),
 * so ids are matched with a segment wildcard rather than by reading req.params —
 * this middleware runs before any router has matched, so params do not exist yet.
 */
const SEG = "[^/]+";
const RULES: Array<{ method: string; re: RegExp; surface: Exclude<Surface, null> }> = [
  // Commands — anything that writes conversation state.
  { method: "POST", re: new RegExp(`^/api/threads/${SEG}/messages$`), surface: "command" },
  { method: "POST", re: new RegExp(`^/api/threads/${SEG}/media$`), surface: "command" },
  { method: "PATCH", re: new RegExp(`^/api/threads/${SEG}/messages/${SEG}$`), surface: "command" },
  { method: "POST", re: new RegExp(`^/api/threads/${SEG}/leave$`), surface: "command" },
  { method: "POST", re: new RegExp(`^/api/threads/${SEG}/report$`), surface: "command" },
  { method: "POST", re: new RegExp(`^/api/threads/${SEG}/messages/${SEG}/save$`), surface: "command" },
  { method: "POST", re: new RegExp(`^/api/users/${SEG}/open-thread$`), surface: "command" },
  { method: "POST", re: new RegExp(`^/api/users/${SEG}/message-request$`), surface: "command" },
  { method: "POST", re: new RegExp(`^/api/message-requests/${SEG}/(accept|decline|cancel)$`), surface: "command" },
  // Read projections — §24's two that exist.
  { method: "GET", re: /^\/api\/me\/threads$/, surface: "read_projection" },
  { method: "GET", re: new RegExp(`^/api/threads/${SEG}/messages$`), surface: "read_projection" },
  { method: "GET", re: /^\/api\/me\/unread-counts$/, surface: "read_projection" },
  // Seen convergence.
  { method: "POST", re: new RegExp(`^/api/threads/${SEG}/read$`), surface: "seen" },
  // The one place a conversation becomes a canonical write.
  { method: "POST", re: new RegExp(`^/api/telegraph/commands/${SEG}/confirm-action$`), surface: "coordination_confirm" },
];

function classify(method: string, path: string): Surface {
  for (const r of RULES) {
    if (r.method === method && r.re.test(path)) return r.surface;
  }
  return null;
}

/**
 * Seen (threadId, clientId) pairs, for the duplicate detector.
 *
 * Bounded by construction: a ring of the last N accepted pairs. It cannot see a
 * duplicate across instances or across a restart, which is stated in SLO-02 and
 * is why that SLO is `partially_measured` rather than `measured`. A Set that
 * grew without limit would be a memory leak in a long-lived process, which is a
 * worse failure than the one it would catch.
 */
const DUP_WINDOW = 2000;
const seenClientIds = new Set<string>();
const seenOrder: string[] = [];

function rememberClientId(key: string): boolean {
  if (seenClientIds.has(key)) return true;
  seenClientIds.add(key);
  seenOrder.push(key);
  if (seenOrder.length > DUP_WINDOW) {
    const evicted = seenOrder.shift();
    if (evicted !== undefined) seenClientIds.delete(evicted);
  }
  return false;
}

/** Test hook: forget every remembered clientId. Not called by production code. */
export function _resetTelegraphDuplicateWindow(): void {
  seenClientIds.clear();
  seenOrder.length = 0;
}

function outcomeFor(status: number): "ok" | "violation" | "unknown" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500) return "violation";
  if (status === 503) return "violation";
  return "unknown";
}

export function telegraphObservability(): RequestHandler {
  return function telegraphObservabilityMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const surface = classify(req.method, req.path);
    if (!surface) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    // The clientId is read BEFORE the handler runs, because a handler may
    // legitimately consume or rewrite req.body.
    const clientId =
      surface === "command" && typeof (req.body as any)?.clientId === "string"
        ? String((req.body as any).clientId).slice(0, 64)
        : null;
    const threadKey = req.path;

    res.on("finish", () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const outcome = outcomeFor(res.statusCode);

      switch (surface) {
        case "command":
          recordTelegraphMetric("message_command_success", outcome, elapsedMs);
          recordTelegraphMetric("message_acceptance_latency_ms", outcome, elapsedMs);
          // A duplicate only counts when the second send was ACCEPTED — two
          // refusals of the same retry are the system working, not a duplicate.
          if (clientId && outcome === "ok") {
            const isDuplicate = rememberClientId(`${threadKey}::${clientId}`);
            recordTelegraphMetric(
              "duplicate_canonical_messages",
              isDuplicate ? "violation" : "ok",
            );
          }
          break;
        case "read_projection":
          recordTelegraphMetric("projection_lag_ms", outcome, elapsedMs);
          recordTelegraphMetric("projection_freshness_ms", outcome, elapsedMs);
          break;
        case "seen":
          recordTelegraphMetric("seen_convergence_latency_ms", outcome, elapsedMs);
          break;
        case "coordination_confirm":
          recordTelegraphMetric("coordinated_actions_confirmed", outcome, elapsedMs);
          break;
      }
    });

    next();
  };
}
