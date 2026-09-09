-- LOCAL REHEARSAL SCAFFOLD. Not a migration, not shipped.
-- Column lists copied verbatim from portava-ci 2026-09-09 via pg_attribute.
-- The four enum types are stubbed as text DOMAINS: this harness checks that the
-- kernel function COMPILES and that the 2764 round-trip is byte-exact, not that
-- any enum label is valid. Nothing here asserts behaviour.
-- Supabase's four standard roles. 2760 REVOKEs from anon and authenticated and
-- then asserts the revoke took, so they must exist for the migration to be
-- rehearsed as written rather than in a reduced form.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE ROLE authenticator;
CREATE SCHEMA IF NOT EXISTS authz;
CREATE DOMAIN member_role AS text;
CREATE DOMAIN trip_status AS text;
CREATE DOMAIN trip_visibility AS text;
CREATE DOMAIN tag_permission_level AS text;
