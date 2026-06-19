import { Router } from "express";
import { getServiceClient, isServiceClientReady } from "../lib/supabase";

const router = Router();

router.post("/trips", async (req, res) => {
  if (!isServiceClientReady) {
    res.status(503).json({ error: "Server not configured: SUPABASE_SERVICE_ROLE_KEY is missing" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const token = authHeader.slice(7);

  const client = getServiceClient()!;

  // Verify user JWT via Supabase Auth directly — this works regardless of
  // whether PostgREST supports ECC P-256 JWT verification.
  const { data: { user }, error: authError } = await client.auth.getUser(token);
  if (authError || !user) {
    res.status(401).json({ error: authError?.message ?? "Invalid or expired token" });
    return;
  }

  const { title, destinationCity, destinationCountry, startDate, endDate, status, visibility, coverUrl } = req.body;

  if (!title || !destinationCity) {
    res.status(400).json({ error: "title and destinationCity are required" });
    return;
  }

  const { data, error } = await client
    .from("trips")
    .insert({
      owner_id: user.id,
      title,
      destination_city: destinationCity,
      destination_country: destinationCountry ?? null,
      start_date: startDate ?? null,
      end_date: endDate ?? null,
      status: status ?? "planning",
      visibility: visibility ?? "private",
      cover_url: coverUrl ?? null,
    })
    .select("*")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to insert trip");
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(data);
});

export default router;
