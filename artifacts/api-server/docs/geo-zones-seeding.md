# geo_zones seeding — the second Crowd Flow blocker

**Status (2026-09-07):** `geo_zones` holds **0 rows in production**. Map §10 Crowd
Flow (`routes/mapProjection.ts`) refuses with `crowdFlow.refusal = "no_zone_model"`
whenever no curated zone of a flow type covers the viewport, and it is right to:
`lib/mapProjection`'s producer takes zone identity from the caller and never falls
back to a coordinate. The Map census records the flag (`map_crowd_flow_enabled`)
and the k-gates; it does not record this. The schema already exists (migration
0034; 2159 revoked every client write grant). **The blocker is data. Populating
it is an ops action, not a migration.** Nothing in this repository invents
production zones.

## Seed format (`lib/geoZoneSeed.ts`, `GeoZoneSeedFileSchema`)

```json
{
  "version": 1,
  "source": "curated by <who> on <date> from <where>",
  "zones": [
    { "name": "An Thuong", "zoneType": "neighborhood", "city": "Da Nang", "countryCode": "VN",
      "centerLat": 16.05, "centerLng": 108.2, "radiusMeters": 600 },
    { "name": "My Khe", "zoneType": "neighborhood", "city": "Da Nang", "countryCode": "VN",
      "polygonGeojson": { "type": "Polygon", "coordinates": [[[108.235,16.062],[108.248,16.062],[108.248,16.078],[108.235,16.078],[108.235,16.062]]] } }
  ]
}
```

Optional per zone: `safetyRating` (`safe|moderate|caution|avoid`), `isSystem`
(default true), `verified` (default true), `featured` (default false), `metadata`
(object; `seed_source` is added from the file's `source`). Unknown keys are refused.

## The four rules (enforced identically by both doors)

1. `zoneType` ∈ the **live** CHECK `geo_zones_zone_type_check`:
   `city | neighborhood | venue | custom | airport | hotel`. (Not the enum 0034
   declared; not `district`/`venue_area`/`safety_zone`, which `routes/admin.ts`
   used to accept and the database never did.)
2. Exactly one geometry: circle (`centerLat`+`centerLng`+`radiusMeters`) **or** a
   closed GeoJSON Polygon outer ring.
3. A `city`/`neighborhood` zone must be ≥ `MIN_FLOW_ZONE_EXTENT_METERS` (250 m)
   across, i.e. it must survive `lib/mapProjection.parseFlowZones` — the same
   parser Crowd Flow reads with. A seed the layer would drop is refused.
4. Names unique (case/whitespace-insensitive) within the batch **and** against
   rows already stored. A duplicated name resolves to **no** zone for the
   next-stop family (`lib/mapProjection` rule 3), so a second "Downtown" would
   silently disable the first.

`radius_meters` is stored rounded — the live column is `integer` (0034 said
`double precision`; the live schema wins).

## Door 1 — the admin API (preferred; validated, dry-run, audited)

```
POST /admin/geo-zones/import        role: admin|owner (requireAdmin)
body: <seed file> + "dryRun": true|false
```

* `dryRun: true` → `200 { dryRun, wouldInsert, report: { total, flowEligible, byType } }`, nothing written.
* Any rule violation → `400 { error: "invalid_payload", issues: [{ index, name, code, message }] }`, nothing written. All issues are reported at once.
* Success → `201 { inserted, zones: [{ id, name, zone_type }], report }`.

Writes go through the service role (2159 leaves no client write grant). The
projection route caches the zone model for 30 s (`loadFlowZones`), so the map
sees a fresh import within that window. The existing single-zone
`POST /admin/geo-zones` also now accepts `polygonGeojson` and the live type list.

## Door 2 — the owner's manual SQL

`db/seed/geo_zones_production_seed_template.sql`. Replace the `__FILL_ME__` row
with curated rows, run with the trailing `ROLLBACK;` first (the validation block
raises on any rule violation and the POST query shows what would be written),
then change it to `COMMIT;`. It refuses to run while the placeholder is present.

## Sample fixture (NON-production)

`src/test/fixtures/geo-zones.sample.json` — five Da Nang areas chosen to coincide
with `src/test/mapCrowdFlowLayer.test.ts`'s zones. `src/test/geoZoneSeed.test.ts`
proves it validates, that four of the five are flow-eligible (the airport is not
a flow type), and — through the real `/map/projection` route — that Crowd Flow
**refuses (`no_zone_model`) with no zones and activates (`refusal: null`,
`zoneModel.zones = 4`) with the fixture**. It is labelled "do not import into
production" in its own `source` field.

## The exact manual action required (owner)

1. Curate the production zone list (city + neighbourhood polygons or circles for
   the launch geography). Nobody but the owner decides these.
2. Either `POST /admin/geo-zones/import` with `dryRun: true`, read the report,
   then again with `dryRun: false`; **or** fill and run the SQL template.
3. Verify: `SELECT zone_type, count(*) FROM public.geo_zones GROUP BY 1;` then
   `GET /map/projection?bbox=<area>&zoom=14&kinds=crowd_flow` →
   `crowdFlow.refusal` moves from `no_zone_model` to `null`.

The flag `map_crowd_flow_enabled` is a separate, deliberate switch (Map census);
seeding zones does not flip it.
