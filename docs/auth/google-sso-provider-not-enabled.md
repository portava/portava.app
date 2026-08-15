# Google SSO — provider not enabled in Supabase

**Status: CONFIRMED DEFECT, open. Owner ruling 2026-08-15.**
**Tracked on its own. NOT part of Phase B, and NOT to be repaired inside Phase B.**

| | |
|---|---|
| **What** | Sign in with Google fails: the **Google provider is not enabled** in the Supabase project |
| **Found by** | the browser agent, while attempting to authenticate for the Phase B Discovery probe |
| **Confirmed** | 2026-08-15 |
| **Relationship to Phase B** | it **blocked** the probe. It is **not** a Phase B acceptance criterion |

---

## The ruling that governs this file

> **Google SSO is a SEPARATE CONFIRMED AUTHENTICATION DEFECT — track it on its
> own, and do NOT repair it inside Phase B merely to get the probe through.
> Google auth is not part of Phase B's acceptance criteria.**

The temptation this forbids is specific and worth naming: the defect was
discovered *because* it stood between an agent and a probe it was told to run.
Fixing it there would have folded an **authentication** repair into a
**discovery reachability** phase, leaving Phase B's evidence entangled with a
change that has nothing to do with what Phase B measures.

**Two independent states, never conflated:**

| | State |
|---|---|
| **Phase B** | **BLOCKED** — authentication prerequisite failed, no probe evidence exists, exit criterion unmet |
| **Google SSO** | **CONFIRMED DEFECT** — this document |

Neither resolves the other. Enabling the provider would not produce one row of
Discovery evidence, and collecting Discovery evidence by another route would not
fix Google sign-in.

---

## This is not a new mystery — it is a documented step that was never performed

**`docs/auth/oauth-sso-completion-report.md` already specifies the fix**, and has
since 2026-07-22:

```
docs/auth/oauth-sso-completion-report.md:43   ## D. Supabase Dashboard — Required Manual Configuration
docs/auth/oauth-sso-completion-report.md:53   ### 2. Enable Google Provider
docs/auth/oauth-sso-completion-report.md:55   2. Toggle **Enable Sign in with Google**.
```

The report's Section D lists **required manual dashboard configuration** —
enabling the Apple provider, enabling the **Google** provider, and registering
redirect URLs. Those are **operator actions in a hosted dashboard**, not code,
so no amount of merged code performs them and no test in this repository can
observe that they are missing.

### The line that made it look done

```
docs/auth/oauth-sso-completion-report.md:4
**Status:** Implementation complete. EAS rebuild required before SSO is functional on device.
```

**"Implementation complete" is true and misleading in the same sentence.** The
*code* was complete. The status line names **one** outstanding prerequisite (the
EAS rebuild) and does **not** name the **unperformed dashboard configuration**
that Section D of the very same document requires. A reader checking status
stops at line 4; the blocking item is at line 53.

This is the roadmap's own distinction, in a different subsystem:

> **"The gate exists" and "the gate has been opened" are one sentence apart, and
> a reader skimming for status must not have to infer which happened.**

And it is the governing invariant again — **absence of evidence must never
silently become evidence of absence.** Nothing in CI, and nothing in the repo,
distinguishes *"the Google provider is enabled"* from *"nobody has ever checked."*
The configuration lives in a dashboard this repository cannot see.

---

## The fix

**An operator action, not agent work.** Per the rails, production configuration
is staged for the operator and never applied by an agent.

1. Supabase → **Authentication → Providers → Google** → enable.
2. Enter the **Google Client ID** (web application client) and **Client Secret** —
   `oauth-sso-completion-report.md` §E covers how these are created.
3. Register the redirect URLs from §H.
4. **Then verify by signing in through the real login UI** — not by re-reading the
   dashboard toggle. The toggle is the change; a successful sign-in is the
   evidence.

**Check Apple at the same time.** §D.1 is the identical shape of unperformed
dashboard step, and it has not been shown to be done either. It is listed here as
**unverified, not as broken** — nobody has reported an Apple failure, and this
document will not manufacture one. *(The distinction is the point: "not observed
to work" is not "observed to fail".)*

---

## What must NOT happen

- **Do not repair this inside Phase B** to unblock the probe.
- **Do not treat a successful login as Phase B evidence.** It removes a blocker;
  it produces no Discovery rows. See `../discovery/ROADMAP.md`, Phase B.
- **Do not amend `oauth-sso-completion-report.md`'s status line to say "done"**
  when the provider is enabled — amend it to distinguish *code complete* from
  *dashboard configured*, so the next reader is not misled the same way.
