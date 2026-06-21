import { Router } from "express";
import { getServiceClient } from "../lib/supabase";
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

export default router;
