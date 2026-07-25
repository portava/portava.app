/**
 * check-media-bucket-privacy — report the public/private state of the media
 * buckets and the media_private_buckets_enabled flag (audit SEC-02). READ-ONLY.
 *
 * Run: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *        node --import tsx/esm src/scripts/check-media-bucket-privacy.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."); process.exit(1); }
const sc = createClient(url, key, { auth: { persistSession: false } });

const BUCKETS = ["post-media", "profile-media"];

async function main() {
  const { data: flag } = await sc
    .from("feature_flags").select("enabled").eq("flag", "media_private_buckets_enabled").maybeSingle();
  const flagOn = (flag as any)?.enabled === true;
  console.log(`flag media_private_buckets_enabled = ${flagOn}`);

  const states: Record<string, boolean | null> = {};
  for (const id of BUCKETS) {
    const { data, error } = await sc.storage.getBucket(id);
    if (error || !data) { console.log(`  ${id}: (not found) ${error?.message ?? ""}`); states[id] = null; continue; }
    states[id] = data.public;
    console.log(`  ${id}: public=${data.public}`);
  }

  const anyPublic = BUCKETS.some((b) => states[b] === true);
  const anyPrivate = BUCKETS.some((b) => states[b] === false);
  console.log("");
  if (!flagOn && anyPublic && !anyPrivate) console.log("STATE: pre-cutover (flag OFF + buckets public) — safe, media served publicly.");
  else if (flagOn && anyPrivate && !anyPublic) console.log("STATE: cutover complete (flag ON + buckets private) — safe, media served via signed URLs.");
  else if (anyPrivate && !flagOn) console.log("⚠ DANGER: a bucket is PRIVATE while the flag is OFF — media will 404. Flip the flag ON or roll the bucket back to public.");
  else console.log("⚠ MIXED STATE — verify the cutover ordering (flag ON must precede buckets private).");
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
