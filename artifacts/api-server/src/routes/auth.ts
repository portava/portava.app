import { Router } from "express";
import { getServiceClient } from "../lib/supabase";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger";

const router = Router();

/**
 * POST /api/auth/lookup-username
 * Body: { email: string }
 * Returns the profile handle (@username) associated with the email, if found.
 * Uses the admin API so we can look up by email without the user being signed in.
 * Rate-limited by intentional delay to discourage enumeration.
 */
router.post("/auth/lookup-username", async (req, res) => {
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
    // Query auth.users via the auth schema using the service role client.
    // The service role key bypasses RLS on all schemas including auth.
    const { data: authRows, error: authError } = await (client as any)
      .schema("auth")
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase())
      .limit(1);

    const userId: string | undefined = authRows?.[0]?.id;

    if (authError || !userId) {
      res.status(404).json({ error: "No account found with that email address." });
      return;
    }

    // Fetch their profile handle from the public schema
    const { data: profile, error: profileError } = await client
      .from("profiles")
      .select("handle")
      .eq("id", userId)
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
 * Both checks are fail-open — if the feature_flags table is unreachable,
 * the response defaults to signupsEnabled=true, inviteOnly=false.
 */
router.get("/auth/signup-status", async (_req, res) => {
  const client = getServiceClient();
  if (!client) {
    res.json({ signupsEnabled: true, inviteOnly: false });
    return;
  }

  const [disabledFlag, inviteOnlyFlag] = await Promise.all([
    isFlagEnabled(client, "disable_signups"),
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
 *  - flag DB query errors    → fail-open, signup is allowed through
 *  - success                 → 201 { user: { id, email } }
 *    (client must then call supabase.auth.signInWithPassword to get a session)
 *
 * Uses admin.createUser (service role) so the ECC P-256 JWT rotation that
 * breaks PostgREST RLS does not affect account creation.
 */
router.post("/auth/signup", async (req, res) => {
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

  // Check kill switch — fail-open: if the flag query errors isFlagEnabled returns false
  const signupsDisabled = await isFlagEnabled(client, "disable_signups");
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
