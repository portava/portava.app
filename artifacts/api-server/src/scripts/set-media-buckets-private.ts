/**
 * set-media-buckets-private — flip the media buckets (post-media, profile-media)
 * to PRIVATE so raw /object/public/ URLs stop serving bytes and access is gated
 * by signed URLs through /api/media/file + /api/media/sign (audit SEC-02).
 *
 * ⚠ SAFETY GUARD: refuses to make buckets private unless
 * `media_private_buckets_enabled` is ON — because with it OFF the app still
 * serves raw public URLs, and a private bucket would break ALL media. This
 * enforces the cutover ordering: (1) client migrates to signed-URL hydration →
 * (2) flip the flag ON → (3) run THIS script. Idempotent.
 *
 *   Forward:  node --import tsx/esm src/scripts/set-media-buckets-private.ts
 *   Rollback: node --import tsx/esm src/scripts/set-media-buckets-private.ts --rollback
 *   Override: add --force to skip the flag guard (NOT recommended).
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set."); process.exit(1); }

const rollback = process.argv.includes("--rollback");
const force = process.argv.includes("--force");
const targetPublic = rollback; // rollback → public=true ; forward → public=false (private)
const sc = createClient(url, key, { auth: { persistSession: false } });

const BUCKETS = ["post-media", "profile-media"];

async function main() {
  const { data: flag } = await sc
    .from("feature_flags").select("enabled").eq("flag", "media_private_buckets_enabled").maybeSingle();
  const flagOn = (flag as any)?.enabled === true;

  if (!rollback && !flagOn && !force) {
    console.error(
      "REFUSING: media_private_buckets_enabled is OFF.\n" +
      "Making buckets private now would break all media (the app still emits raw public URLs).\n" +
      "Correct order: (1) ship the client signed-URL hydration, (2) flip the flag ON, (3) re-run this.\n" +
      "Pass --force only if you fully understand the consequence.",
    );
    process.exit(1);
  }

  for (const id of BUCKETS) {
    const { error } = await sc.storage.updateBucket(id, { public: targetPublic });
    console.log((error ? "✖ " : "✔ ") + id + " → public=" + targetPublic + (error ? `  ERR ${error.message}` : ""));
  }

  console.log("");
  if (rollback) {
    console.log("Rolled back: buckets are PUBLIC again. (You may also flip the flag OFF to fully revert.)");
  } else {
    console.log("Buckets are now PRIVATE. Verify: an authorized client still loads media via signed URLs,");
    console.log("and a raw https://<host>/storage/v1/object/public/post-media/... URL now returns 400/403.");
  }
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
