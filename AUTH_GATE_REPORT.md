# AUTH_GATE_REPORT.md — Email + password auth gate

First real auth on the Supabase spine. Sign-up / sign-in / sign-out + a session gate.
Trips wiring is the NEXT pass (deliberately not here).

## What's built
- src/context/SessionContext.tsx — SessionProvider + useSession(): single auth-truth source
  (userId, isAuthed, loading, configured, signOut). Subscribes to auth changes.
- app/(auth)/sign-in.tsx — email + password screen, toggles Sign in / Create account.
  Loading spinner, inline errors, email-confirm notice. Name captured on sign-up (feeds the
  profile trigger). Branded (Plane logo, Travel Buddy).
- app/index.tsx — session GATE: while resolving → spinner; configured + not authed →
  /(auth)/sign-in; authed (or backend not configured → mock fallback) → /(tabs).
- app/settings.tsx — "Log out" now wired to signOut() → returns to sign-in. Rows are
  pressable; Log out only shows when actually signed in.
- app/_layout.tsx — SessionProvider added OUTERMOST (wraps Availability/Attachment providers).

## Flow
First launch (backend configured, no session) → sign-in screen. Create account → Supabase
auth.signUp → DB trigger auto-creates the profile row → into the app. Sign out from Settings
→ back to sign-in. Session persists across reloads (supabase persistSession).

## Honest fallback
If Supabase keys are absent, configured=false and the gate sends users straight to /(tabs)
on mock — the app still runs exactly as before. Nothing is faked as authed.

## IMPORTANT — Supabase email confirmation setting
By default Supabase requires email confirmation on sign-up. Two options:
- EASIEST FOR TESTING: dashboard → Authentication → Providers → Email → turn OFF
  "Confirm email". Then sign-up logs you straight in.
- KEEP IT ON: after sign-up you'll see "Check your email to confirm…", confirm via the
  emailed link, then Sign in. The screen handles both (shows the notice, switches to Sign in).
Dashboard path:
  https://supabase.com/dashboard/project/<ref>/auth/providers  (Email provider)

## Verify it worked (after applying)
1. Launch → you should see the SIGN-IN screen (not the tabs).
2. Create account with an email + password (6+ chars).
3. In Supabase: Table editor → profiles → you should see a NEW ROW with your id + name.
   (That proves auth + the profile trigger + RLS all work end to end.)
4. Settings → Log out → back to sign-in. Sign in again → back in the app.

## Static checks (this env)
- Escaped-backtick scan: CLEAN
- Whole-project missing-import audit: 0
- Auth files balanced; providers nest correctly (SessionProvider outermost)
- NOTE: @supabase/supabase-js resolves on your Mac (already installed), not in this env.

## Files added / changed
NEW:  src/context/SessionContext.tsx, app/(auth)/sign-in.tsx, AUTH_GATE_REPORT.md
EDIT: app/index.tsx (session gate), app/settings.tsx (log out wired), app/_layout.tsx (SessionProvider)

## Next pass (after you can log in + see your profile row)
Wire the Trips tab to useMyTrips() behind this gate, and trip-create to createTrip().
Then /trip/[id] to useTrip(id). Then attachments + availability onto tables.

## Summary
The app now has a real front door: email+password sign-up/sign-in on Supabase, a session
gate that routes you to sign-in or the app, and a working sign-out. Creating an account
writes a real profile row via the DB trigger — the first true end-to-end backend moment.
Mock still works if keys are absent. Trips wiring is next.
