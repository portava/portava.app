# Why `setup-git` kept being needed — root cause

**Investigated 2026-08-10, after `setup-git` had been run four times in one day.**

**Conclusion first: this was never an authentication failure, and `setup-git`
could never have fixed it. Two independent mechanisms were involved, and the one
that actually caused the repeated failures is a token-precedence problem that
`setup-git` makes no difference to.**

---

## Cause 1 (the real one) — `GITHUB_TOKEN` shadows the good credential

There are **two** GitHub credentials in this environment, and the weaker one wins.

| Source | Token | Scopes | `gh` says |
|---|---|---|---|
| `GITHUB_TOKEN` env var | `ghp_…` | **`repo` only** — missing `read:org` | **Active account: true** |
| `~/.config/gh/hosts.yml` | `gho_…` | `gist`, `read:org`, `repo`, `workflow` | Active account: **false** |

`gh` gives the `GITHUB_TOKEN` environment variable absolute precedence over its
own stored `hosts.yml`. Proven directly:

```
$ gh auth token                    -> ghp_…
$ env -u GITHUB_TOKEN gh auth token -> gho_…
```

The git credential helper configured by Replit is
`!… /bin/gh auth git-credential`, so **git inherits that same precedence** and
every git operation authenticated with the `repo`-only token.

### Why this produced exactly the observed symptom

- Plain `git push` / `git fetch` need only `repo` scope, so **they always
  worked**. (Every push in this session succeeded without intervention.)
- Anything needing `read:org` — org-scoped `gh` commands, org membership
  lookups — failed with a scope error that **reads like an auth failure**.
- The natural response is to re-run `setup-git`, which re-runs the OAuth flow
  and rewrites `hosts.yml`.
- **But `hosts.yml` is the losing side of the precedence rule.** The next command
  still picks up `GITHUB_TOKEN`. The symptom returns immediately.

That is the churn: not a credential that keeps being erased, but a credential
that is *permanently overridden*, being repaired in the one place the repair
cannot take effect. Four `setup-git` runs in a day is what a fix that cannot
work looks like.

## Cause 2 (real, but benign) — the global git config lives on tmpfs

```
GIT_CONFIG_GLOBAL=/run/replit/user/58825850/.config/git/config
$ df -T /run   ->  tmpfs   50M
```

Replit sets `GIT_CONFIG_GLOBAL` explicitly, which **overrides `XDG_CONFIG_HOME`**
— this is why git reads the `/run` path and completely ignores
`/home/runner/workspace/.config/git/config` even though `XDG_CONFIG_HOME` points
at the workspace.

`/run` is tmpfs, so that file is destroyed on every container restart. It *is*
genuine configuration churn, and it explains why global git config appears to
reset itself. But Replit regenerates it correctly on boot (user, email, and the
`gh` credential helper), so on its own it is benign — it was not what broke
`gh`.

**Consequence worth knowing:** because `GIT_CONFIG_GLOBAL` is forced to tmpfs,
writing a "global" git config to the persistent workspace path has no effect.
Git will not read it. The only persistent location git reliably reads here is
**repo-local `.git/config`**.

---

## The fix applied

Repo-local, in `.git/config` (persistent workspace disk, and the only persistent
scope git actually reads here):

```
[credential "https://github.com"]
	helper =
	helper = !env -u GITHUB_TOKEN gh auth git-credential
[credential "https://gist.github.com"]
	helper =
	helper = !env -u GITHUB_TOKEN gh auth git-credential
```

Two details matter:

1. **The empty `helper =` line is load-bearing.** Git accumulates credential
   helpers across config scopes and uses the **first one that returns
   credentials**. Without the reset, Replit's helper (from the tmpfs global
   config) still runs first and still returns the `ghp_` token — the new entry
   is simply never reached. Setting an empty value clears the inherited list so
   the deliberate helper wins.
2. **`env -u GITHUB_TOKEN`** unsets the shadowing variable for the duration of
   the helper call only. Nothing else in the environment changes.

### Verified

```
$ printf 'protocol=https\nhost=github.com\n\n' | git credential fill
username=portava
password=gho_…            <- full-scope token, not ghp_

$ env -u GITHUB_TOKEN gh auth status
  Token scopes: 'gist', 'read:org', 'repo', 'workflow'   <- read:org present

$ git ls-remote --heads origin bughunt-20260805   -> OK
```

Re-checked in a **fresh shell** (every tool invocation here starts one): the
helper resolves and git still receives `gho_`. It is in `.git/config` on the
persistent disk, so it survives container restarts — unlike anything in `/run`.

---

## Caveats — read before relying on this

- **`.git/config` is not tracked by git.** This fix cannot be committed. A fresh
  clone of this repo will not have it, and will be back to the `ghp_` token. If
  the repo is re-cloned, re-apply the two `git config --local` commands above.
- **It is scoped to this repository.** Other repos in this environment still get
  the `ghp_` token.
- **If `hosts.yml`'s `gho_` token is ever revoked**, this helper will fail where
  the old one would have fallen back to `GITHUB_TOKEN`. The fix trades a silent
  scope shortfall for a loud failure, which is the right trade, but it is a
  trade.
- **The clean fix is upstream**: either drop `GITHUB_TOKEN` from the injected
  environment, or grant it `read:org` so the two credentials stop disagreeing.
  That is a Replit environment setting, not something this repo can change.

## If it looks broken again

Run this **before** reaching for `setup-git` — it distinguishes the two causes
in one shot:

```
gh auth status                      # which account is Active? which scopes?
gh auth token | cut -c1-4           # ghp_ = shadowed, gho_ = correct
git config --get-all credential.https://github.com.helper
```

If the active token is `ghp_` and scopes are missing, `setup-git` will not help
— the precedence problem above is back, and the repo-local helper is missing or
was overridden.
