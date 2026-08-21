#!/usr/bin/env node
/**
 * Seed the @portava official publisher account.
 *
 * Creates (or updates) the Portava service-identity profile with:
 *   - handle: "portava"
 *   - is_official: true   (only the service role can set this)
 *   - distinctive avatar, bio, and display name
 *
 * This script is IDEMPOTENT — safe to run multiple times.
 * It uses the service-role client so the is_official flag can be set
 * without triggering the anti-elevation trigger.
 *
 * Usage from artifacts/api-server:
 *   node --env-file-if-exists=.env --import tsx/esm src/scripts/seed-portava-account.ts
 *
 * Required environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional environment variables:
 *   PORTAVA_ACCOUNT_EMAIL  — email for the auth user (default: portava@internal.portava.app)
 *   PORTAVA_ACCOUNT_UUID   — fixed UUID to use (auto-generated if omitted and no existing user found)
 *   SEED_DRY_RUN=true      — print actions without writing to the DB
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";

const DRY_RUN = process.env.SEED_DRY_RUN === "true";

export const PORTAVA_EMAIL_DEFAULT = "portava@internal.portava.app";
export const PORTAVA_HANDLE = "portava";
export const PORTAVA_DISPLAY_NAME = "Portava";
export const PORTAVA_BIO = "Your travel community. Curated places, stories, and inspiration from around the world. 🌍✈️";
export const PORTAVA_AVATAR_URL = "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?w=400&h=400&fit=crop&crop=center";

// ── Step 1: Resolve or create the auth user ────────────────────────────────────

async function resolveAuthUser(sc: SupabaseClient): Promise<string> {
  const PORTAVA_EMAIL = process.env.PORTAVA_ACCOUNT_EMAIL ?? PORTAVA_EMAIL_DEFAULT;

  // Check for an explicit UUID override first.
  const override = process.env.PORTAVA_ACCOUNT_UUID;
  if (override) {
    console.log(`Using explicit UUID override: ${override}`);
    return override;
  }

  // Try to find an existing auth user by email.
  const { data: list, error: listErr } = await sc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) {
    console.error("Could not list auth users:", listErr.message);
    process.exit(1);
  }
  const existing = (list?.users ?? []).find(
    (u: any) => u.email?.toLowerCase() === PORTAVA_EMAIL.toLowerCase(),
  );
  if (existing) {
    console.log(`Found existing auth user for ${PORTAVA_EMAIL}: ${existing.id}`);
    return existing.id;
  }

  // Create a new auth user for the Portava service account.
  console.log(`Creating auth user for ${PORTAVA_EMAIL}...`);
  if (DRY_RUN) {
    console.log("[DRY-RUN] would create auth user — returning placeholder UUID");
    return "00000000-0000-0000-0000-000000000001";
  }
  const { data: created, error: createErr } = await sc.auth.admin.createUser({
    email: PORTAVA_EMAIL,
    email_confirm: true,
    // No password — this account is service-only and never authenticates via password.
    app_metadata: { is_service_account: true, role: "official_publisher" },
  });
  if (createErr || !created?.user) {
    console.error("Could not create auth user:", createErr?.message);
    process.exit(1);
  }
  console.log(`Created auth user ${created.user.id}`);
  return created.user.id;
}

// ── Step 2: Upsert the profile row ────────────────────────────────────────────

/**
 * Creates or updates the @Portava profile row.
 *
 * @param userId - The auth user UUID to upsert the profile for.
 * @param client - Supabase client to use (defaults to the service-role client
 *   created from env vars; tests may pass a fake client here).
 */
export async function upsertPortavaProfile(
  userId: string,
  client?: SupabaseClient,
): Promise<void> {
  const sc = client ?? _getDefaultClient();

  // Check whether the profile already exists.
  const { data: existing } = await sc
    .from("profiles")
    .select("id, handle, is_official")
    .eq("id", userId)
    .maybeSingle();

  if (existing) {
    console.log(
      `Profile row already exists (handle=${(existing as any).handle}, ` +
      `is_official=${(existing as any).is_official}). Patching...`,
    );
    if (DRY_RUN) {
      console.log("[DRY-RUN] would PATCH profile to ensure is_official=true, correct handle/bio/avatar");
      return;
    }
    const { error } = await sc
      .from("profiles")
      .update({
        handle: PORTAVA_HANDLE,
        username: PORTAVA_HANDLE,
        name: PORTAVA_DISPLAY_NAME,
        display_name: PORTAVA_DISPLAY_NAME,
        bio: PORTAVA_BIO,
        avatar_url: PORTAVA_AVATAR_URL,
        is_official: true,
        is_private: false,
        open_to_meet: false,
        passport_visibility: "public",
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);
    if (error) {
      console.error("Failed to update profile:", error.message);
      process.exit(1);
    }
    console.log("Profile updated successfully.");
    return;
  }

  // Profile does not exist — insert it.
  console.log(`Inserting new profile for userId=${userId}...`);
  if (DRY_RUN) {
    console.log("[DRY-RUN] would INSERT profile with is_official=true");
    return;
  }
  const { error } = await sc.from("profiles").insert({
    id: userId,
    handle: PORTAVA_HANDLE,
    username: PORTAVA_HANDLE,
    name: PORTAVA_DISPLAY_NAME,
    display_name: PORTAVA_DISPLAY_NAME,
    bio: PORTAVA_BIO,
    avatar_url: PORTAVA_AVATAR_URL,
    is_official: true,
    is_private: false,
    open_to_meet: false,
    passport_visibility: "public",
    verification_status: "verified",
    verified: true,
    verified_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("Failed to insert profile:", error.message);
    process.exit(1);
  }
  console.log("Profile inserted successfully.");
}

// ── Step 3: Ensure canonical user_location_preferences row ───────────────────

async function ensureLocationPreferences(sc: SupabaseClient, userId: string): Promise<void> {
  if (DRY_RUN) {
    console.log("[DRY-RUN] would ensure user_location_preferences row");
    return;
  }
  const { error } = await sc
    .from("user_location_preferences")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  if (error) {
    // Non-fatal: log and continue.
    console.warn("user_location_preferences upsert warning (non-fatal):", error.message);
  } else {
    console.log("user_location_preferences row ensured.");
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

let _defaultClient: SupabaseClient | undefined;

function _getDefaultClient(): SupabaseClient {
  if (_defaultClient) return _defaultClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set. " +
      "Pass an explicit client argument or set the env vars.",
    );
  }
  _defaultClient = createClient(url, key, { auth: { persistSession: false } });
  return _defaultClient;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      "WARNING: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set — " +
        "skipping @portava account seeding. Run manually once credentials are available.",
    );
    process.exit(0);
  }

  const sc = _getDefaultClient();
  console.log(DRY_RUN ? "=== DRY RUN — no writes will occur ===" : "=== Seeding @portava official account ===");

  const userId = await resolveAuthUser(sc);
  await upsertPortavaProfile(userId, sc);
  await ensureLocationPreferences(sc, userId);

  console.log(`\n✓ @portava account seeded. userId=${userId}`);
  if (DRY_RUN) {
    console.log("(dry run — no actual DB changes)");
  }
}

// Only run main when this file is executed directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
}
