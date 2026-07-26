#!/usr/bin/env python3
"""
Apply the Portava AI Header Generation server core into your Replit tree.

Run from the bundle folder (the one containing this script and the `files/` dir):
    python3 apply.py

It copies the new (drift-safe) files into ~/workspace/artifacts/{api-server,travel-buddy}
and idempotently registers the visuals router in api-server/src/routes/index.ts.
Nothing existing is overwritten except that one registration edit.
"""
import os, shutil, sys

HOME = os.path.expanduser("~")
WS = os.path.join(HOME, "workspace")
BUNDLE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BUNDLE, "files")

def copy_tree():
    copied = 0
    for root, _, names in os.walk(SRC):
        for n in names:
            src = os.path.join(root, n)
            rel = os.path.relpath(src, SRC)          # e.g. api-server/src/lib/visuals/x.ts
            dst = os.path.join(WS, "artifacts", rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            existed = os.path.exists(dst)
            shutil.copy2(src, dst)
            print(f"  {'~' if existed else '+'} {rel}")
            copied += 1
    print(f"  copied {copied} file(s)")

def register_router():
    p = os.path.join(WS, "artifacts", "api-server", "src", "routes", "index.ts")
    if not os.path.exists(p):
        print("  ! routes/index.ts not found — register the router manually")
        return
    s = open(p, encoding="utf-8").read()
    if "visualsRouter" in s:
        print("  = router already registered")
        return
    imp_anchor = 'import tripDraftRouter from "./tripDraft";'
    use_anchor = "router.use(tripDraftRouter);"
    ok = True
    if imp_anchor in s:
        s = s.replace(imp_anchor, imp_anchor + '\nimport visualsRouter from "./visuals";', 1)
    else:
        # fallback: add import after the last route import line
        idx = s.rfind('from "./')
        line_end = s.find("\n", idx)
        s = s[:line_end+1] + 'import visualsRouter from "./visuals";\n' + s[line_end+1:]
        print("  (used fallback import anchor)")
    if use_anchor in s:
        s = s.replace(use_anchor, use_anchor + "\nrouter.use(visualsRouter);", 1)
    else:
        idx = s.rfind("router.use(")
        line_end = s.find("\n", idx)
        s = s[:line_end+1] + "router.use(visualsRouter);\n" + s[line_end+1:]
        print("  (used fallback mount anchor)")
    open(p, "w", encoding="utf-8").write(s)
    print("  + registered visualsRouter in routes/index.ts")

def main():
    if not os.path.isdir(WS):
        print(f"! {WS} not found — run this from your Replit shell where ~/workspace exists")
        sys.exit(1)
    print("Portava AI Header Generation — applying server core\n")
    copy_tree()
    register_router()
    print("\nDone. Next:")
    print("  cd ~/workspace/artifacts/api-server")
    print("  npx tsc -p tsconfig.json --noEmit && echo tsc OK")
    print("  SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \\")
    print("    node --import tsx/esm --test --test-force-exit src/test/visuals.test.ts")
    print("  # then apply the migration: src/migrations/0189_generated_visuals.sql")

if __name__ == "__main__":
    main()
