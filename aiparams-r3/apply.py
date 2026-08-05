#!/usr/bin/env python3
# Portava - gpt-5-mini parameter fix (r3). Idempotent, anchored.
#   python3 apply.py --dry-run     -> expect: 13 applied / 0 already / 0 missed
#   python3 apply.py
import argparse, io, os, sys

S = "api-server/src/"
T = S + "test/"

# (relpath, old, new, label) - anchor must appear exactly once
PATCHES = [
 (S+"lib/translation.ts",
  "      max_tokens: 20,\n      temperature: 0,\n    });",
  "      max_completion_tokens: 200,\n      reasoning_effort: 'minimal' as const,\n    });",
  "translation.detectLanguage"),
 (S+"lib/translation.ts",
  "      max_tokens: 1000,\n      temperature: 0.3,\n    });",
  "      max_completion_tokens: 2000,\n      reasoning_effort: 'minimal' as const,\n    });",
  "translation.translateText"),
 (S+"lib/reservationExtract.ts",
  '      model:                 "gpt-5-mini",\n      temperature:           0,\n      max_completion_tokens: 700,',
  '      model:                 "gpt-5-mini",\n      max_completion_tokens: 1500,\n      reasoning_effort:      "minimal" as const,',
  "reservationExtract params"),
 (S+"services/compass/CompassIntentClassifier.ts",
  '      model:                 "gpt-5-mini",\n      temperature:           0,\n      max_completion_tokens: 60,',
  '      model:                 "gpt-5-mini",\n      max_completion_tokens: 256,',
  "CompassIntentClassifier params"),
 (T+"tripReservations.test.ts",
  '    assert.equal(sent.model, "gpt-5-mini");\n    assert.equal(sent.temperature, 0);',
  '    assert.equal(sent.model, "gpt-5-mini");\n    // No temperature assertion: gpt-5 reasoning models reject any\n    // non-default temperature, so the route no longer sends one.',
  "tripReservations.test temperature assertion"),
 (S+"lib/reservationExtract.ts",
  " * Strict-JSON, temperature-zero gpt-5-mini call (same discipline as",
  " * Strict-JSON gpt-5-mini call (same discipline as",
  "reservationExtract doc comment"),
 (S+"services/compass/CompassIntentClassifier.ts",
  " * temperature-zero LLM call (gpt-5-mini, ~60 tokens).",
  " * single LLM call (gpt-5-mini, minimal reasoning). gpt-5 reasoning\n * models reject any non-default temperature, so none is sent.",
  "CompassIntentClassifier doc comment"),
 (S+"routes/tripDraft.ts",
  " * Extraction discipline matches reservationExtract: gpt-5-mini, temperature 0,",
  " * Extraction discipline matches reservationExtract, but on gpt-4o-mini so\n * temperature 0 is still available here:",
  "tripDraft doc comment"),
 (T+"compass-ask.test.ts",
  "    // The classifier call (max_completion_tokens=60, temperature=0) gets a",
  "    // The classifier call (max_completion_tokens=256) gets a",
  "compass-ask.test comment"),
 (T+"compass-trip-context.test.ts",
  " * Classifier calls (max_completion_tokens=60, temperature=0) get the supplied",
  " * Classifier calls (max_completion_tokens=256) get the supplied",
  "compass-trip-context.test comment"),
]

OLD_P = "opts.max_completion_tokens === 60 && opts.temperature === 0"
NEW_P = "opts.max_completion_tokens === 256"

# (relpath, old, new, expected_count, label) - replaces every occurrence
GLOBALS = [
 (T+"compass-ask.test.ts", OLD_P, NEW_P, 3, "compass-ask.test predicate x3"),
 (T+"compass-tools.test.ts", OLD_P, NEW_P, 7, "compass-tools.test predicate x7"),
 (T+"compass-trip-context.test.ts", OLD_P, NEW_P, 1, "compass-trip-context.test predicate x1"),
]

def rd(p):
    with io.open(p, "r", encoding="utf-8", newline="") as f: return f.read()

def wr(p, t):
    with io.open(p, "w", encoding="utf-8", newline="") as f: f.write(t)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=os.path.expanduser("~/workspace/artifacts"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    root = os.path.abspath(os.path.expanduser(a.root))
    print("root: %s" % root)
    print("mode: %s\n" % ("DRY RUN" if a.dry_run else "APPLY"))

    applied = already = missed = 0
    pending = {}
    def load(p): return pending[p] if p in pending else rd(p)

    for rel, old, new, label in PATCHES:
        p = os.path.join(root, rel)
        if not os.path.exists(p):
            print("MISS %s\n     file not found: %s" % (label, rel)); missed += 1; continue
        t = load(p)
        if new in t:
            print("==   %s" % label); already += 1; continue
        n = t.count(old)
        if n != 1:
            print("MISS %s\n     anchor found %d times in %s" % (label, n, rel)); missed += 1; continue
        pending[p] = t.replace(old, new, 1)
        print("OK   %s" % label); applied += 1

    for rel, old, new, exp, label in GLOBALS:
        p = os.path.join(root, rel)
        if not os.path.exists(p):
            print("MISS %s\n     file not found: %s" % (label, rel)); missed += 1; continue
        t = load(p)
        n = t.count(old)
        if n == 0:
            print("==   %s" % label); already += 1; continue
        if n != exp:
            print("MISS %s\n     expected %d occurrences, found %d in %s" % (label, exp, n, rel))
            missed += 1; continue
        pending[p] = t.replace(old, new)
        print("OK   %s" % label); applied += 1

    print("\n%d applied / %d already present / %d missed" % (applied, already, missed))
    if missed:
        print("\nA miss means the live tree has drifted from the tree these anchors")
        print("were cut against. STOP - do not hand-edit around it. Report the miss.")
        return 1
    if a.dry_run:
        print("dry run - nothing written"); return 0
    for p, t in pending.items(): wr(p, t)
    print("wrote %d file(s)" % len(pending))
    return 0

sys.exit(main())
