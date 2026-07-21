# Refreshing the schema-drift guards' live column lists

The api-server schema-drift tests (`artifacts/api-server/src/test/*SchemaDrift.test.ts`)
validate queried column names against a generated snapshot of the LIVE Supabase
public schema:

- Generated data: `artifacts/api-server/src/test/generated/liveColumns.json`
- Loader (fails loudly if the file is missing or a table is absent):
  `artifacts/api-server/src/test/helpers/liveColumns.ts`

## Refresh command

```
pnpm --filter @workspace/scripts run refresh:live-columns
```

This queries `information_schema.columns` (table_schema='public') on the live
database via the Supabase Management API (requires `SUPABASE_URL` and
`SUPABASE_ACCESS_TOKEN` in the environment) and rewrites the JSON snapshot for
ALL public tables/views, so one command refreshes every drift guard.

Run it whenever a column is renamed/added/dropped live, then commit the updated
JSON. Never edit the generated file by hand.
