/**
 * A CONFIRMED entry corridor for a fake layover world (LAYOVER 165, lane B2-CURATE).
 *
 * Since 2026-10-18 an unconfirmed corridor closes landside in every flag state
 * (owner decision: unknown critical safety information fails closed; spec §6.1,
 * §21.1 "Unknown entry permission → No landside recommendation"). A suite that
 * tests something ELSE about a landside layover — routing, discovery, crews,
 * buddies, the map — must therefore STATE that its traveller may enter the
 * country, exactly as production needs a curated corridor
 * (POST /admin/entry-requirements). This adds the three things
 * `resolveLayoverEntry` reads: the entry-intelligence flag, the traveller's
 * passport, and a visa-free corridor row.
 *
 * It mutates and returns `tables` so a world builder can wrap its own object.
 */
type Row = Record<string, any>;

export const ENTRY_INTELLIGENCE_FLAG = "passport_entry_intelligence_enabled"; // lib/entryRequirements.ts ENTRY_FLAG

export function withConfirmedCorridor<T extends Record<string, Row[]>>(
  tables: T,
  opts: { userIds: string[]; destination: string; passport?: string },
): T {
  const passport = opts.passport ?? "US";
  const t = tables as Record<string, Row[]>;
  t.feature_flags = t.feature_flags ?? [];
  if (!t.feature_flags.some((f) => f.flag === ENTRY_INTELLIGENCE_FLAG)) t.feature_flags.push({ flag: ENTRY_INTELLIGENCE_FLAG, enabled: true });
  t.traveler_passports = t.traveler_passports ?? [];
  for (const id of opts.userIds) {
    if (!t.traveler_passports.some((p) => p.user_id === id)) {
      t.traveler_passports.push({ id: `passport-${id}`, user_id: id, issuing_country: passport, is_primary: true, created_at: "2026-01-01T00:00:00.000Z" });
    }
  }
  t.entry_requirements = t.entry_requirements ?? [];
  if (!t.entry_requirements.some((r) => r.passport_country === passport && r.destination_country === opts.destination)) {
    t.entry_requirements.push({
      id: `corridor-${passport}-${opts.destination}`, passport_country: passport, destination_country: opts.destination,
      status: "visa_free", allowed_stay_days: 30, official_source_url: "https://example.test/official-corridor", notes: null,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  }
  return tables;
}
