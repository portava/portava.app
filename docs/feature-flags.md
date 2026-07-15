# Feature-Flag Launch Runbook

All flags seeded by migrations 0037, 0041, and 0042 start as `enabled = false`. Flip them on one at a time as each feature ships using the admin API:

```
# List all flags (requires admin role)
GET /api/admin/feature-flags

# Toggle a single flag
PATCH /api/admin/feature-flags/<flag-name>
Body: { "enabled": true }
```

Or directly via Supabase SQL:
```sql
UPDATE feature_flags SET enabled = true, updated_at = now() WHERE flag = '<flag-name>';
```

> **Tip:** Always call `GET /api/admin/feature-flags` first to confirm the exact canonical flag names stored in the database before toggling in production. The names below match migrations 0037, 0041, and 0042 exactly, but verifying live state avoids surprises.

## Recommended enable order

**Location intelligence** (enable phases in sequence — each phase builds on the previous):
| Flag | Feature | Enable when |
|------|---------|-------------|
| `location_phase1_gps` | GPS capture + `user_location_state` upsert | Location service wired up in the mobile app |
| `location_phase2_zones` | Geo-zone detection | `geo_zones` table has data; zone matching logic shipped |
| `location_phase3_geofence` | Plan geofencing + check-ins | `plan_geofences` UI shipped; `plan_checkins` flow tested |
| `location_phase4_discovery` | Discovery location context | Discovery screen wired to user location |
| `location_phase5_pulse` | Pulse geo-tags | `pulse_geo_tags` ingestion shipped |
| `location_phase6_crew` | Trip crew map (depends on flags below) | All three `trip_crew_*` flags already on |

**Trip crew location** (can enable independently from the phases above):
| Flag | Feature | Enable when |
|------|---------|-------------|
| `trip_crew_map_enabled` | Crew map tab on trip detail | Map UI merged |
| `trip_crew_live_share_enabled` | Live-share sessions | Session expiry + member filtering tested |
| `trip_crew_ghost_mode_enabled` | Ghost mode toggle | Ghost-mode UI + audit events verified |

**Passport stamps** (enable in order):
| Flag | Feature | Enable when |
|------|---------|-------------|
| `passport_stamps_enabled` | Stamp earning + display | `passport_stamps` screen shipped |
| `passport_map_enabled` | Stamps on a map | Map view of stamps shipped |
| `passport_memories_enabled` | Suggested trip memories | Memory suggestion pipeline wired up |
| `passport_contribution_enabled` | Contribution event logging | Append-only events verified non-disruptive |

**Other flags seeded in 0037** (toggle as needed):
| Flag | Default | Notes |
|------|---------|-------|
| `safe_return_enabled` | false | Enable with `safe_return_trusted_circle_alerts_enabled` |
| `plan_geofence_full_enabled` | false | Full check-in geofence (migration 0039) |
| `notifications_digest_enabled` | false | Notification digest batching |
| `hidden_gems_enabled` | **true** | Already live |
| `telegraph_suggestions_enabled` | **true** | Already live |
