// Production schema/state verification — run from ~/workspace/artifacts/api-server
// Uses the service client; prints PRESENT/MISSING only, never secrets.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.log('ENV MISSING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in this shell'); process.exit(1); }
const sc = createClient(url, key, { auth: { persistSession: false } });

async function col(table, column) {
  const { error } = await sc.from(table).select(column, { head: true, count: 'exact' }).limit(1);
  if (!error) return console.log(`  OK      ${table}.${column}`);
  const msg = (error.message || '').toLowerCase();
  if (msg.includes('does not exist') || error.code === '42703' || error.code === 'PGRST204' || error.code === '42P01')
    console.log(`  MISSING ${table}.${column}  (${error.code ?? ''} ${error.message})`);
  else console.log(`  ??      ${table}.${column}  (${error.code ?? ''} ${error.message})`);
}
async function tbl(table) {
  const { count, error } = await sc.from(table).select('*', { head: true, count: 'exact' });
  if (!error) return console.log(`  OK      ${table}  (${count} rows)`);
  console.log(`  MISSING ${table}  (${error.code ?? ''} ${error.message})`);
}

console.log('— Stamp catalog (migration 0125 family) —');
await tbl('universal_stamp_catalog');
await tbl('stamp_generation_queue');
await tbl('stamp_reconciliation_log');

console.log('— 0150-family + known columns —');
await col('trips', 'cover_media_type');
await col('passport_stamps', 'visibility');
await col('profiles', 'passport_tab_order');
await col('profiles', 'show_telegraph_dm');
await col('profiles', 'date_of_birth');

console.log('— Calling (0155) —');
await tbl('call_sessions');

console.log('— 0160 passthrough (run AFTER applying migration 0160) —');
await col('rent_buddy_bookings', 'decline_reason');
await col('rent_buddy_waitlist', 'desired_date');
await col('rent_buddy_packages', 'stops');
await col('rent_buddy_reviews', 'category_ratings');
await tbl('rent_buddy_review_notes');

console.log('— Feature flags —');
const { data: flags } = await sc.from('feature_flags').select('flag, enabled').in('flag', ['rent_buddy_enabled', 'calling_enabled']);
for (const f of flags ?? []) console.log(`  FLAG    ${f.flag} = ${f.enabled}`);
if (!flags?.length) console.log('  (no matching flags found)');
process.exit(0);
