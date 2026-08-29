/**
 * Guard: every ephemeral-port test server must BIND and DIAL the same explicit
 * loopback address — `listen(0, "127.0.0.1", …)` and `http://127.0.0.1:<port>`.
 *
 * WHY. `server.listen(0)` with no host binds the IPv6 wildcard `[::]`, and node
 * sets SO_REUSEADDR, so the kernel will hand out an ephemeral port (49152-65535)
 * that a FOREIGN process already holds on `127.0.0.1` — a dev server, an LSP, a
 * local proxy. The bind SUCCEEDS: the two sockets are in different address
 * families and never collide. `fetch("http://localhost:<port>")` then resolves
 * the NAME to both families and reaches the IPv4 one — the stranger. The test's
 * own server records zero connections and zero requests, and the test fails on
 * whatever that process answered: a bare `TypeError: fetch failed` with an EMPTY
 * cause when it replies 407, an unrelated body otherwise.
 *
 * Because the port is drawn at random, the victim is a uniformly random test in
 * the file. It looks like an unrelated intermittent, it never reproduces in
 * isolation, and it points the reader at whatever the branch happened to touch.
 * That is exactly how it was first misread — as a fire-and-forget write race in
 * livePulseImpressions.test.ts — before PR #206 identified it.
 *
 * THE LOAD-BEARING HALF IS THE LISTEN, not how the client dials: once bound to
 * `[::]`, a request to EITHER `localhost` or `127.0.0.1` can be served by the
 * foreign listener. The second scan below is defence in depth — `localhost`
 * resolving to `::1` first also costs a failed connection on every request.
 *
 * Scoped to port 0 on purpose. A fixed port either binds or reports EADDRINUSE;
 * only ephemeral assignment can be handed a port someone else already owns, so
 * `src/index.ts`'s real `.listen(port, …)` is none of this guard's business.
 *
 * ONE TRAP WHEN ADDING THE ADDRESS TO AN EXISTING CALL. `listen(0)` binds
 * synchronously, so `server.address()` is readable on the very next line.
 * `listen(0, host)` does not: node routes it through `lookupAndListen`, whose
 * `dns.lookup` calls back on a later tick even for an IP literal. `address()`
 * therefore returns NULL immediately after the call, and a helper that reads
 * `.port` from it dials port `undefined` and hangs. Await the bind —
 * `await new Promise<void>((r) => server.once("listening", r))`, the idiom
 * already used throughout this suite — or pass a listening callback. Eleven
 * call sites needed that when the address was swept in.
 *
 * Both scans cover ALL .ts files under src/ recursively, with no allowlist to
 * update — a new test file is covered the moment it is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The only host an ephemeral test server may bind, and the only one it may dial. */
const LOOPBACK = "127.0.0.1";

/** Recursively collect all .ts files under `dir`, excluding *.d.ts. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** `<anything>.listen(...)` — express apps and http.Server both reach it this way. */
function isListenCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "listen"
  );
}

/** The first argument is the numeric literal 0 — i.e. "give me any free port". */
function isEphemeralPort(call: ts.CallExpression): boolean {
  const first = call.arguments[0];
  return (
    first !== undefined &&
    ts.isNumericLiteral(first) &&
    first.text === "0"
  );
}

/** The second argument is the loopback address, spelled as a literal. */
function bindsLoopback(call: ts.CallExpression): boolean {
  const second = call.arguments[1];
  return (
    second !== undefined &&
    ts.isStringLiteral(second) &&
    second.text === LOOPBACK
  );
}

test(`every listen(0, …) under src/ binds ${LOOPBACK} explicitly`, () => {
  const offenders: string[] = [];

  for (const file of collectTsFiles(SRC_DIR)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (isListenCall(node) && isEphemeralPort(node) && !bindsLoopback(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push(
          `${path.relative(SRC_DIR, file)}:${line + 1}  ${node.getText(sf).split("\n")[0]}`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  assert.deepEqual(
    offenders,
    [],
    `Host-less ephemeral bind: these servers call listen(0, …) without an address, ` +
      `so they bind the IPv6 wildcard and the kernel may hand them a port a foreign ` +
      `process already holds on ${LOOPBACK}. A request then reaches the stranger, and ` +
      `a random test in the file fails on whatever it answered. Pass the address: ` +
      `listen(0, "${LOOPBACK}", …) — and note that doing so makes the bind DEFERRED ` +
      `(node resolves the host first), so await the "listening" event before reading ` +
      `server.address(). See livePulseImpressions.test.ts:\n  ` +
      offenders.join("\n  "),
  );
});

/**
 * The dialling half. Restricted to test code: `src/lib/discoveryWarmup.ts` and
 * `src/routes/trips.ts` legitimately self-call `http://localhost:<port>` at a
 * FIXED port the server itself owns, which is not this hazard.
 */
function isTestFile(relative: string): boolean {
  return relative.startsWith(`test${path.sep}`) || relative.endsWith(".test.ts");
}

test(`every test dialling an ephemeral port uses ${LOOPBACK}, never the name "localhost"`, () => {
  const offenders: string[] = [];

  for (const file of collectTsFiles(SRC_DIR)) {
    const relative = path.relative(SRC_DIR, file);
    if (!isTestFile(relative)) continue;
    // This guard's own prose names the pattern it forbids; so does the comment
    // block in livePulseImpressions.test.ts. Match code, not commentary.
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (ts.isTemplateExpression(node) && node.head.text.endsWith("http://localhost:")) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        offenders.push(`${relative}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  assert.deepEqual(
    offenders,
    [],
    `Interpolated "http://localhost:<port>" in a test: the name resolves to BOTH ` +
      `address families, so the request can be served by a foreign listener holding ` +
      `that port on ${LOOPBACK} — and even when it is not, the ::1 attempt is a wasted ` +
      `failed connection. Dial the literal: http://${LOOPBACK}:\${port}.\n  ` +
      offenders.join("\n  "),
  );
});
