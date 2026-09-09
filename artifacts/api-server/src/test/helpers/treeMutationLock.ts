/**
 * Serialise the suites that MUTATE the real source tree against the suites that
 * SCAN it.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * `guardCoverageReachability.test.ts` proves check:guard-coverage by writing a
 * probe file into src/lib/ and deleting it again — the only way to test a checker
 * whose whole job is scanning the real tree. `securityCheckSuite.test.ts` runs
 * check:guard-coverage as a subprocess. node:test runs files CONCURRENTLY, so the
 * second saw the first's probe and reported an unguarded reacher that exists for
 * about a second.
 *
 * Measured: securityCheckSuite passes 17/17 alone and fails its CONTROL when run
 * in the same invocation as guardCoverageReachability. A suite whose result
 * depends on which other suites share the process is a false red, and a false red
 * is how a test gets deleted rather than fixed.
 *
 * ── WHY A LOCK AND NOT A SEAM ────────────────────────────────────────────────
 * The alternative was to let the probe live somewhere check:guard-coverage does
 * not look. That would mean the proof no longer runs against the real tree, which
 * is the one thing the proof is for. Better to make the two suites take turns.
 *
 * `mkdir` is the primitive because it is atomic on every platform that matters:
 * it either creates the directory or fails with EEXIST, with no read-then-write
 * window. The lock records its owner and a timestamp so a stale one can be
 * identified rather than guessed at, and it is BREAKABLE after a timeout — a
 * suite that crashed without releasing must not wedge every later run. Breaking
 * is logged, never silent.
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LOCK_DIR = join(tmpdir(), "portava-tree-mutation.lock");
const OWNER_FILE = join(LOCK_DIR, "owner.json");
/** Longer than the slowest of these suites, so a live holder is never mistaken for a corpse. */
const STALE_AFTER_MS = 180_000;
const POLL_MS = 120;

function tryAcquire(owner: string): boolean {
  try {
    mkdirSync(LOCK_DIR);
    writeFileSync(OWNER_FILE, JSON.stringify({ owner, pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

function breakIfStale(): void {
  if (!existsSync(LOCK_DIR)) return;
  let age = Number.POSITIVE_INFINITY;
  let holder = "(unknown)";
  try {
    const raw = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { owner?: string; at?: number };
    age = Date.now() - (raw.at ?? 0);
    holder = raw.owner ?? holder;
  } catch {
    // No readable owner record: fall back to the directory's own mtime rather
    // than treating "cannot tell" as "safe to break".
    try { age = Date.now() - statSync(LOCK_DIR).mtimeMs; } catch { return; }
  }
  if (age > STALE_AFTER_MS) {
    console.error(
      `[treeMutationLock] breaking a lock held by ${holder} for ${Math.round(age / 1000)}s — ` +
        "it exceeded the stale threshold, so its owner is assumed dead. If this appears while a suite is genuinely " +
        "running, the threshold is too low, not the lock wrong.",
    );
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

/** Block until the tree is ours. Returns a release function. */
export async function acquireTreeLock(owner: string): Promise<() => void> {
  const deadline = Date.now() + STALE_AFTER_MS + 60_000;
  for (;;) {
    if (tryAcquire(owner)) {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(LOCK_DIR, { recursive: true, force: true });
      };
    }
    breakIfStale();
    if (Date.now() > deadline) {
      // Never silently proceed without the lock: that reintroduces exactly the
      // interference this exists to remove, and the next failure would look like
      // a real finding.
      throw new Error(
        `[treeMutationLock] ${owner} could not acquire the tree lock within the deadline. Another suite is holding ` +
          "it and did not release. Refusing to run unserialised rather than produce a result nobody can trust.",
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
