/**
 * seed-test-profiles.ts
 *
 * Creates 5 fully-functional test accounts in Supabase Auth and fills out
 * their profiles so every feature (follow, message, trips, blocking, etc.)
 * can be exercised right away.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed:profiles
 *
 * Reads credentials from artifacts/api-server/.env
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Load .env from the api-server artifact
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../artifacts/api-server/.env');

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      out[key] = val;
    }
  } catch {
    console.error(`Could not read ${path} — make sure api-server/.env exists.`);
    process.exit(1);
  }
  return out;
}

const env = loadEnv(envPath);
const SUPABASE_URL = env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in api-server/.env');
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------------------------------------------------------------------------
// Test-user definitions  (password is the same for all — easy to remember)
// ---------------------------------------------------------------------------
const PASSWORD = 'TestPass123!';

const TEST_USERS = [
  {
    email: 'maya.santos@traveltest.dev',
    username: 'mayasantos',
    display_name: 'Maya Santos',
    bio: 'Chasing sunsets and street food 🌮  |  34 countries & counting',
    location: 'Barcelona, Spain',
    travel_styles: ['backpacker', 'foodie'],
    travel_pace: 'slow',
    budget_style: 'mid-range',
    avatar_seed: 'maya',
  },
  {
    email: 'luca.ferrari@traveltest.dev',
    username: 'lucaferrari',
    display_name: 'Luca Ferrari',
    bio: 'Adventure photographer 📷  |  Always finding the next mountain',
    location: 'Milan, Italy',
    travel_styles: ['adventure', 'photography'],
    travel_pace: 'fast',
    budget_style: 'budget',
    avatar_seed: 'luca',
  },
  {
    email: 'priya.nair@traveltest.dev',
    username: 'priyanair',
    display_name: 'Priya Nair',
    bio: 'Solo traveller 🌏  |  Culture, temples, and chai stops',
    location: 'Mumbai, India',
    travel_styles: ['cultural', 'solo'],
    travel_pace: 'moderate',
    budget_style: 'budget',
    avatar_seed: 'priya',
  },
  {
    email: 'james.okafor@traveltest.dev',
    username: 'jamesokafor',
    display_name: 'James Okafor',
    bio: 'Luxury travel blogger ✈️  |  5-star experiences on a 4-star budget',
    location: 'Lagos, Nigeria',
    travel_styles: ['luxury', 'foodie'],
    travel_pace: 'slow',
    budget_style: 'luxury',
    avatar_seed: 'james',
  },
  {
    email: 'sophie.chen@traveltest.dev',
    username: 'sophiechen',
    display_name: 'Sophie Chen',
    bio: 'Digital nomad & remote worker 💻  |  Coffee shop connoisseur',
    location: 'Taipei, Taiwan',
    travel_styles: ['digital-nomad', 'cultural'],
    travel_pace: 'slow',
    budget_style: 'mid-range',
    avatar_seed: 'sophie',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function upsertProfile(userId: string, u: typeof TEST_USERS[number]) {
  const { error } = await admin.from('profiles').upsert(
    {
      id: userId,
      username: u.username,
      // 'name' is the original column; 'display_name' is an alias added later
      name: u.display_name,
      bio: u.bio,
      // Use a deterministic DiceBear avatar — no file upload needed
      avatar_url: `https://api.dicebear.com/9.x/adventurer/svg?seed=${u.avatar_seed}&backgroundColor=b6e3f4,c0aede,d1d4f9`,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) throw new Error(`Profile upsert failed for ${u.username}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('🌍  Travel Buddy — seeding 5 test profiles\n');

const results: Array<{ email: string; username: string; userId: string; created: boolean }> = [];

for (const u of TEST_USERS) {
  process.stdout.write(`  • ${u.display_name} (${u.email}) … `);

  // Check if the user already exists by listing auth users and searching
  const { data: existing } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existingUser = existing?.users?.find((au) => au.email === u.email);

  let userId: string;
  let created: boolean;

  if (existingUser) {
    userId = existingUser.id;
    created = false;
    process.stdout.write('already exists, updating profile … ');
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: u.email,
      password: PASSWORD,
      email_confirm: true,   // pre-confirmed — no inbox needed
    });
    if (error || !data.user) {
      console.error(`FAILED — ${error?.message ?? 'unknown error'}`);
      continue;
    }
    userId = data.user.id;
    created = true;
  }

  await upsertProfile(userId, u);
  results.push({ email: u.email, username: u.username, userId, created });
  console.log('✓');
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  TEST ACCOUNTS — all use the same password below');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Password: ${PASSWORD}\n`);

for (const r of results) {
  const tag = r.created ? '(new)' : '(updated)';
  console.log(`  ${r.email.padEnd(38)}  @${r.username.padEnd(16)} ${tag}`);
}

console.log('\n  Sign in via the Travel Buddy app with any of the emails above.');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
