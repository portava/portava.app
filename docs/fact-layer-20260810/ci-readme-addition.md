<!--
  APPEND TARGET: docs/ci/README.md
  PLACEMENT:     immediately BEFORE "## Where mechanical enforcement ends"
                 (at 13dcfe3 that heading is line 1551; insert after the `---`
                 that closes "## Suggested hardening", line 1549).
  Everything below the marker line is the section to insert, verbatim.

  MERGE PRECONDITION — READ BEFORE INSERTING.
  This section is a CITING document. It deliberately states no fact in its own
  words; every factual claim is a pointer into 00_VERIFIED_STATE.md by section
  number. That is the structural rule the P1 document set runs under: one fact
  layer, one wording, no restatements to diverge.

  docs/ci/README.md has no such fact layer. So on insertion, each
  "VERIFIED_STATE §N" pointer must be resolved — either by pasting that entry's
  text and anchors inline, or by linking a copy of 00_VERIFIED_STATE.md checked in
  alongside this README. Do NOT paraphrase the entries while resolving them; copy
  them. A paraphrase at merge time reintroduces exactly the divergence the
  citing style exists to prevent.
-->

---

## Why the allowlist checks the target: `SUPABASE_URL` alone decides which database is reached

Everything above describes *how* the allowlist and the two front doors work.
Nothing above says why the check lands on the **target** rather than on the
**credential**. That reasoning has lived only in conversation, and a mechanism
whose reason is unrecorded is a mechanism the next reader will try to simplify
away.

The established reason is narrow and mechanical: **for every process in this
repository that reaches Supabase, `SUPABASE_URL` is the only input that selects
which project is contacted.** The credential travels unchanged regardless.
Change the URL and nothing else, and the same process reaches a different
database — see **VERIFIED_STATE §9.13** for the six Management-API entry points
and the anchor for each of the four steps, and **§9.14** for what that endpoint
accepts once reached. The guard checks the one input that decides the answer:
**§9.15**.

There is a second, larger question sitting next to this one — whether the
credential *could* be scoped down as well. It is open, it is not settled by
anything in this repository, and this section does not answer it. See
[the open question](#open-question-the-scope-of-supabase_project_token) below.
Nothing in this section depends on how it resolves.

This section sits beside [Where mechanical enforcement ends](#where-mechanical-enforcement-ends)
on purpose. That section states a limit on what this repository can check about
itself; this one states which input the check has to land on, and why.

### Provenance, and how to read the citations in this section

**This section restates no fact.** Each factual claim is a pointer to a numbered
entry in `00_VERIFIED_STATE.md`, which is the single fact layer for this work.
Where you see **VERIFIED_STATE §N**, the wording, the tag and the `file:line`
anchors all live there — go read that entry rather than trusting a summary here.
The rule exists because the previous revision of these documents failed when
three of them restated the same facts and the three restatements diverged.

Two consequences worth stating plainly:

- **A claim here with no §N pointer and no explicit tag is a defect.** Report it.
- **The `file:line` anchors in the fact layer resolve at `13dcfe3` and nowhere
  else automatically.** That commit is behind the tip this section will land on.
  Re-resolve by grepping the quoted text, not by trusting the number. Citation
  drift at exactly this seam is what failed the previous revision.

Nothing in this section rests on a live database query.

### The token authenticates; the URL selects

Two independent inputs go into every Management API request these checks make,
and only one of them is a credential:

| what it fixes | supplied by | fact of record |
| --- | --- | --- |
| **which project** the request reaches | the ref in the request path, derived from `SUPABASE_URL`'s hostname | VERIFIED_STATE §9.13 |
| **which account** the request acts as | the token, sent as a bare `Authorization: Bearer` header | VERIFIED_STATE §9.13 |

Note the asymmetry the fact layer records: the *project* is a function of
`SUPABASE_URL`, computed in-process, on every one of the six entry points. The
*credential* is passed through untouched — no consumer validates a prefix, a
scope or a shape on either token name (**§9.18**, final bullet). Whatever is in
the variable is what gets sent.

Two further facts shape how much that matters:

- The endpoint is not a read API. It takes a `{ query }` body — arbitrary SQL.
  **VERIFIED_STATE §9.14.**
- The guard reads exactly three variables and inspects no credential at all.
  **VERIFIED_STATE §9.15.**

**That is the design in one line: the check lands on `SUPABASE_URL` because
`SUPABASE_URL` is what decides.** Whether the credential could *additionally* be
narrowed is the open question below; it does not change which input the guard
has to check, because a scoped credential would still be pointed at a project by
the same URL. This is also why the assertion had to move out of YAML and into
every process that can reach Supabase
([the execution path](#the-allowlist-is-enforced-in-the-execution-path)), and why
every ambiguous state is a refusal rather than a skip
([fail closed](#fail-closed-always-and-still-no-opt-out)).

### Open question: the scope of `SUPABASE_PROJECT_TOKEN`

**This is unresolved. Both readings are stated below; neither is asserted here,
and no in-tree line is corrected on the strength of either.**

The question: *does `SUPABASE_PROJECT_TOKEN` hold a credential that is bound to a
single Supabase project, or an account-level token that is accepted by every
project in the account?*

**The case that it is project-scoped** — **one document, copied.** An earlier
revision of this section counted files and lines ("thirteen files, twenty-one
lines describe the token that way") and presented that count as the weight of the
evidence. **That was a manufactured breadth argument and it is retracted.** An
occurrence count is not an evidence count, and here the difference is the whole
argument: `git log -S` over the live repo puts **every** occurrence — 29 lines
across 15 files under the pattern
`project-scoped|Project-scoped|Project API tokens` — at a **single origin
commit, `19f28c679` (2026-07-15)**, propagated to the TypeScript scripts as an
identical parenthetical by **`0b25c17c8` (2026-07-17)**, with **five files naming
`docs/eas-runbook.md` as their source rather than asserting it independently**
(`check-db-triggers.sh:15`, `check-engagement-indexes.sh:16`,
`pre-release-check.sh:615`, `print-github-secrets.sh:13`, `replit.md:78`).
Twenty-nine agreeing lines that all descend from one unverified sentence are one
piece of evidence, not twenty-nine — and this README would have been two more
copies of it. What the repository actually offers for "project-scoped" is a
single 2026-07-15 document, never verified, widely duplicated.
**VERIFIED_STATE §9.9** carries the full derivation.

**Read-only is no longer part of this question — it is settled, and settled
against the runbook.** The same 2026-07-15 commit is the sole origin of the
read-only claim too (ten sites across five files; every string traced with
`git log -S`), and `docs/ci/README.md:469-470` contradicts it outright: *"it does
not make the credential read-only. The Management API token in the environment
can write."* All ten sites were corrected on 2026-08-11. The credential is a
Management API token that **can write**, constrained by what the process does and
by the target allowlist, never by the credential. Do not re-import "read-only"
into the scoping question; they were one sentence at birth but only one of them
is still open.

**The case that it is account-level** — reported by the owner on 2026-08-10
against the Supabase dashboard, and **[UNVERIFIED]**: no repository can confirm a
vendor's product surface. What the tree offers is corroboration, not proof —
both token names reach the same endpoint in the same header, and the fallback
name `SUPABASE_ACCESS_TOKEN` is documented as an `sbp_…` account personal access
token (**§9.18**). A genuinely project-bound credential being byte-interchangeable
with an account token is possible but would be surprising.

**Why it is not settled by reading either document again.** The repository
records a belief and a click-path. It cannot record whether the click-path
exists, and it cannot record what the value currently in the variable actually
is. **VERIFIED_STATE §9.9** states the divergence in full and names the
resolution: inspect an actual `SUPABASE_PROJECT_TOKEN` value's prefix, and test
it against a second project's Management API endpoint. Ten minutes with the real
credential settles it; nothing short of that does.

**What each answer would change.**

| if the token is… | then the "project-scoped" wording is… | then the guard is… |
| --- | --- | --- |
| account-level | an overstatement toward *safer than it is* — the same shape as a denylist described as an allowlist — and correctable in one pass, since it descends from one 2026-07-15 sentence | the only thing on this axis standing between CI and production |
| genuinely project-scoped | accurate, and nothing needs correcting | still worth having, but as one of two barriers rather than the only one |

**Until that is settled, do not change the "project-scoped" wording in either
direction, and do not cite this section as authority that the credential cannot
be scoped.** Correcting documentation on an unverified premise is how the
overstatement got there in the first place. Note the scale of a correction if one
is ever warranted: 29 lines across 15 files, but **one** origin — so it is a
single edit repeated, not fifteen independent judgements to revisit.

One thing does **not** depend on the answer. "Read-only" is a property of the SQL
the six entry points happen to send (**VERIFIED_STATE §9.14**: the endpoint takes
arbitrary SQL, and nothing inspects it), not a property established anywhere in
this tree about the credential. This README already gets that right where it
counts:
[the read-only production audit mode](#the-read-only-production-audit-mode)
states that it "does not make the credential read-only … the Management API token
in the environment can write; the mode constrains what the *process* does." That
sentence stands whichever way the scope question resolves.

### What environment scoping narrowed, and what it did not

Two credential classes, two different answers. The difference matters because it
is easy to read the GitHub-side change as having solved the problem.

| credential | how far it was narrowed | what still bounds its reach |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` | values moved to the `ci-nonprod-supabase` environment; repository secrets emptied — **[UNVERIFIED]**, GitHub console state reported 2026-08-10, not observable from any repository | each key is handed to `createClient()` against whatever host `SUPABASE_URL` names |
| `SUPABASE_PROJECT_TOKEN` | read from environment-declaring jobs only (VERIFIED_STATE §9.16) | the guard's check of `SUPABASE_URL`, plus whatever the credential's own scope turns out to be — the open question above |

**On the workflow side, which is verifiable, the picture is not uniform — and one
name breaks the pattern.** **VERIFIED_STATE §9.16** gives the reference table.
Four of the five secret names are read only from inside jobs that declare
`environment: ci-nonprod-supabase`. The fifth, `CI_SUPABASE_PROJECT_REF`, is read
in the **workflow-level `env:` block, outside every job and every environment**.

That single exception matters twice:

1. **"No credential-free job can read any of them" is false as a blanket claim.**
   A workflow-level `env:` value is computed for the workflow, not for a job that
   opted into an environment.
2. **A workflow-level `env:` cannot resolve an environment secret at all.**
   Environment secrets are available only to jobs that declare the environment,
   so at workflow level the `secrets.CI_SUPABASE_PROJECT_REF` half of that
   expression has nothing to resolve against. The expression is
   `${{ vars.CI_SUPABASE_PROJECT_REF || secrets.CI_SUPABASE_PROJECT_REF }}`
   (§9.16), so in practice the **repository or organization variable** is what
   supplies the allowlist value there — which is consistent with the workflow's
   own comment that a repo variable is its normal home, and with
   [the allowlist policy itself](#the-allowlist-policy-itself) requiring it to
   fail closed when empty. If the intent was ever for an environment secret of
   that name to supply it in this workflow, that intent is not satisfied at
   `:144`.

**[UNVERIFIED]** — GitHub's precedence and availability rules for environment
versus repository secrets are platform behaviour and were not tested here.
Confirm against GitHub's "Using secrets in GitHub Actions" documentation before
relying on either point above. This is load-bearing for the argument that
emptying the repository secrets is what makes the environment declaration bind
rather than decorate, so it is tagged rather than asserted.

**What environment scoping buys, stated narrowly: it narrows which jobs in this
repository can read a value. It does not narrow what the value can do once
read.** A job that declares the environment gets the token, and the token
reaches whatever project `SUPABASE_URL` names.

Consequently stale regardless of the open question: `scripts/print-github-secrets.sh`
still sends the operator to the **repository** secrets page
(**VERIFIED_STATE §9.19**). If the values did move to environment scope,
following that script re-creates repository-scoped secrets.

### The narrow true claims

Stated the way this document states the others — the narrower version, not the
comfortable one:

- **What is scoped is the target.** The check lands on `SUPABASE_URL` because
  that is the input that selects the project (§9.13, §9.15). That is true
  independently of the credential question.
- **The credential CI holds is not constrained by anything in this repository.**
  No consumer validates a prefix, a scope or a shape (§9.18); the endpoint takes
  arbitrary SQL (§9.14). Whether it is constrained by *Supabase* is the open
  question. Do not read "unconstrained here" as "unconstrained".
- **If the account-level reading holds, this guard is not defence in depth on
  this axis — it is the only defence.** Removing it would not fall back to a
  weaker credential. **[UNVERIFIED]**, contingent on the open question; if the
  project-scoped reading holds instead, removing it falls back to whatever the
  token's own scope is, which is exactly the thing nobody has measured.
- **The sanctioned project's identity is a human declaration either way.**
  [Where mechanical enforcement ends](#where-mechanical-enforcement-ends) records
  that the allowlist proves only that the resolved ref equals a ref *someone
  declared*. That is why `CI_SUPABASE_PROJECT_REF` is operator-supplied and fails
  closed when empty rather than being a default this repo picks.

### If this is ever revisited

In order of how much they would change:

1. **Settle the token's scope.** VERIFIED_STATE §9.9 names the method: inspect a
   real token value and test it against a second project. Everything conditional
   above becomes unconditional, in one direction or the other, the moment that is
   done — including whether the "project-scoped" wording needs correcting across
   its 29 single-origin occurrences.
2. **Supabase's product surface may have changed since 2026-08-10.** Vendor
   roadmap facts go stale silently and in only one direction. Re-check rather
   than inheriting either reading.
3. **A separate Supabase account or organization for CI.** Whether the sanctioned
   CI project and production share an account today is **[UNVERIFIED]** — console
   state, recorded nowhere in this tree. If they do not share one, the
   account-level reading's blast radius already stops short of production.
   **Establish that before either relaxing the guard or citing this section as a
   reason not to.** Nothing here should be read as a claim about the account
   layout, in either direction.

The last two are infrastructure decisions, like the choice of the non-production
project itself. Neither is something this repository can make or verify, which is
the same reason [Setting up the non-production project](#setting-up-the-non-production-project)
opens by saying a human has to do it.
