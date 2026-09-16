import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("privacy-safe sensing migrations retain service-role-only RLS and OFF defaults", () => {
  const credential = readFileSync(new URL("../migrations/2260_privacy_safe_sensing_credentials.sql", import.meta.url), "utf8");
  const presence = readFileSync(new URL("../migrations/2261_presence_cleanup_flag.sql", import.meta.url), "utf8");
  const coverage = readFileSync(new URL("../migrations/2262_coverage_state.sql", import.meta.url), "utf8");
  assert.match(credential, /ENABLE ROW LEVEL SECURITY/);
  assert.match(credential, /service_role/);
  assert.match(credential, /is_sensing_device_eligible/);
  assert.match(credential, /p_actor_id uuid/);
  assert.match(credential, /device_id text NOT NULL/);
  assert.match(credential, /intel_sensing_credentials_enabled.*false/s);
  assert.match(presence, /presence_cleanup_enabled.*false/s);
  assert.match(coverage, /coverage_state/);
});