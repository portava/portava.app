-- weather_cache: persist Open-Meteo results so the Daily Brief survives
-- server restarts and temporary Open-Meteo downtime.
--
-- destination  — lowercased destination name (geocode input)
-- date_key     — "startDate:endDate" range string used as in-memory cache key
-- brief_summary — 1–2 sentence narrative injected into AI prompt / shown in UI
-- forecasts_json — full DailyWeather[] array so the in-memory cache can be
--                  fully repopulated from a single DB read
-- fetched_at   — when Open-Meteo was last called; freshness checked server-side
--                (rows older than 6 h are treated as a miss and re-fetched)

CREATE TABLE IF NOT EXISTS weather_cache (
  destination    TEXT        NOT NULL,
  date_key       TEXT        NOT NULL,
  brief_summary  TEXT        NOT NULL,
  forecasts_json JSONB       NOT NULL DEFAULT '[]',
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (destination, date_key)
);
