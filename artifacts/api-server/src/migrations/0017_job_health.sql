-- Migration: 0017_job_health.sql
-- Creates job_health table to persist background-job last-run timestamps.

CREATE TABLE IF NOT EXISTS job_health (
  job          text PRIMARY KEY,
  last_run_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
