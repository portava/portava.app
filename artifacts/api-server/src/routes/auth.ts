import { Router } from "express";
import rateLimit from "express-rate-limit";
import { getServiceClient } from "../lib/supabase";
import { isFlagEnabled, isKillSwitchEngaged } from "../lib/featureFlags.js";
import { logger } from "../lib/logger";

const router = Router();

// ── Rate limiters ─────────────────────────────────────────────────────────────

/**
 * Per-IP rate limiter for the lookup-username endpoint.
 * 10 requests per 15 minutes — supplements the intentional 800 ms delay.
 */
export const lookupUsernameLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } },
});

/**
 * Per-IP rate limiter for the signup endpoint.
 * 5 requests per hour — tight cap to deter automated account creation.
 */
export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many signup attempts. Please try again later." } },
});

/**
 * Reset rate-limit stores — for use in tests ONLY.
 * Clears the in-memory hit counters so each test starts from a clean state.
 * express-rate-limit exposes `resetKey(ip)` directly on the middleware function.
 */
export function _resetAuthRateLimits(): void {
  // Cover the loopback variants node:http uses on different OSes
  for (const ip of ["::1", "127.0.0.1", "::ffff:127.0.0.1"]) {
    (lookupUsernameLimiter as any).resetKey(ip);
    (signupLimiter as any).resetKey(ip);
  }
}

/**
 * POST /api/auth/lookup-username
 * Body: { email: string }
 * Returns the profile handle (@username) associated with the email, if found.
 * Uses the admin API so we can look up by email without the user being signed in.
 * Rate-limited by intentional delay and per-IP cap to discourage enumeration.
 */
router.post("/auth/lookup-username", lookupUsernameLimiter, async (req, res) => {
  const { email } = req.body ?? {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }

  // Intentional delay to slow down enumeration attempts
  await new Promise((r) => setTimeout(r, 800));

  const client = getServiceClient();
  if (!client) {
    res.status(503).json({ error: "Service not available." });
    return;
  }

  try {
    // Query auth.users via the admin API. The auth schema is not exposed through
    // PostgREST, so the service-role client cannot use client.schema("auth").
    // Paginate. A single page:1 lookup silently misses every account past the
    // first 1000 and answers "no account found" — a false negative on account
    // RECOVERY that only appears once the user base crosses 1000 and then
    // worsens. Same loop shape as the email lookup in routes/admin.ts.
    const needle = email.toLowerCase();
    let user: { id: string } | null = null;
    let lookupError: unknown = null;
    for (let page = 1; ; page++) {
      const { data: usersPage, error: pageError } = await (client as any).auth.admin.listUsers({
        page,
        perPage: 1000,
      });
      if (pageError) { lookupError = pageError; break; }
      const users = (usersPage?.users ?? []) as any[];
      if (users.length === 0) break;
      const match = users.find(
        (u: any) => typeof u.email === "string" && u.email.toLowerCase() === needle,
      );
      if (match) { user = match; break; }
      if (users.length < 1000) break; // last page — not found
    }

    if (lookupError || !user?.id) {
      res.status(404).json({ error: "No account found with that email address." });
      return;
    }

    // Fetch their profile handle from the public schema
    const { data: profile, error: profileError } = await client
      .from("profiles")
      .select("handle")
      .eq("id", user.id)
      .single();

    if (profileError || !profile?.handle) {
      res.status(404).json({ error: "No account found with that email address." });
      return;
    }

    res.json({ handle: profile.handle });
  } catch (err) {
    logger.error({ err }, "lookup-username error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

/**
 * GET /api/auth/signup-status
 * Returns whether new signups are currently allowed.
 * The mobile app MUST call this before initiating Supabase Auth sign-up and
 * show an appropriate message when either kill switch is active.
 * Response: { signupsEnabled: boolean, inviteOnly: boolean }
 * disable_signups is an emergency stop and is fail-CLOSED: if the flag query
 * errors the state is unknown, the stop engages, and this reports
 * signupsEnabled=false — matching what POST /auth/signup will actually do, so
 * the app never shows a signup form that is about to 403. invite_only_beta is
 * an ordinary capability flag and stays fail-open (defaults to false).
 */
router.get("/auth/signup-status", async (_req, res) => {
  const client = getServiceClient();
  if (!client) {
    res.json({ signupsEnabled: true, inviteOnly: false });
    return;
  }

  const [disabledFlag, inviteOnlyFlag] = await Promise.all([
    isKillSwitchEngaged(client, "disable_signups"),
    isFlagEnabled(client, "invite_only_beta"),
  ]);

  res.json({
    signupsEnabled: !disabledFlag,
    inviteOnly:     inviteOnlyFlag,
  });
});

/**
 * POST /api/auth/signup
 * Body: { email: string, password: string }
 *
 * Server-side signup guard.  The mobile app MUST route new registrations
 * through this endpoint instead of calling Supabase Auth directly so that
 * the `disable_signups` kill switch is enforced server-side.
 *
 * Behaviour:
 *  - disable_signups = true  → 403 { error: "feature_disabled" }
 *  - flag DB query errors    → fail-CLOSED, the stop engages and signup is blocked
 *  - success                 → 201 { user: { id, email } }
 *    (client must then call supabase.auth.signInWithPassword to get a session)
 *
 * Uses admin.createUser (service role) so the ECC P-256 JWT rotation that
 * breaks PostgREST RLS does not affect account creation.
 */
router.post("/auth/signup", signupLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "invalid_payload", message: "A valid email address is required." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    res.status(400).json({ error: "invalid_payload", message: "Password must be at least 6 characters." });
    return;
  }

  const client = getServiceClient();
  if (!client) {
    res.status(503).json({ error: "service_unavailable" });
    return;
  }

  // Check kill switch — fail-CLOSED: an unreadable stop engages (isKillSwitchEngaged).
  const signupsDisabled = await isKillSwitchEngaged(client, "disable_signups");
  if (signupsDisabled) {
    res.status(403).json({ error: "feature_disabled" });
    return;
  }

  try {
    const { data, error } = await (client as any).auth.admin.createUser({
      email: email.toLowerCase().trim(),
      password,
    });

    if (error) {
      const msg: string = error.message ?? "";
      if (error.status === 422 || msg.toLowerCase().includes("already registered") || msg.toLowerCase().includes("already exists")) {
        res.status(409).json({ error: "email_taken", message: msg });
      } else {
        logger.error({ err: error }, "auth/signup admin.createUser error");
        res.status(500).json({ error: "signup_failed" });
      }
      return;
    }

    res.status(201).json({ user: { id: data.user.id, email: data.user.email } });
  } catch (err) {
    logger.error({ err }, "auth/signup unexpected error");
    res.status(500).json({ error: "signup_failed" });
  }
});

export default router;
