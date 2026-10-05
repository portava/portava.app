/**
 * REV-041 — nothing about a user's data is sold: the intel API has no external
 * surface (docs/architecture/08_Portava_Revenue_Model.md §6.5).
 *
 * routes/intelApi.ts is, in its own words, "the INTERNAL shape of the intel API
 * product — what an external partner endpoint would serve once one exists".
 * Whether one is ever offered is an owner decision that has not been taken, and
 * until it is the route must stay what it is: admin-gated, under
 * `/v1/internal/`, issuing no credential. This pins those three facts so that a
 * partner endpoint cannot be stood up on the projection by adding a route to
 * this file, or by loosening the one that is there, without this test being
 * edited by someone who read it.
 *
 * It reads the file; it needs no server.
 *
 * Run: node --import tsx/esm --test src/test/intelApiInternalOnly.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripComments } from "../scripts/lib/stripComments.js";

const FILE = fileURLToPath(new URL("../routes/intelApi.ts", import.meta.url));
const code = stripComments(readFileSync(FILE, "utf8"));

/** Each `router.<verb>("<path>", …)` in the file, with the handler text up to the next route. */
function routes(): Array<{ verb: string; path: string; body: string }> {
  const re = /router\.(get|post|put|patch|delete|all|use)\(\s*(["'`])([^"'`]*)\2/g;
  const found = [...code.matchAll(re)];
  return found.map((m, i) => ({
    verb: m[1]!,
    path: m[3]!,
    body: code.slice(m.index!, found[i + 1]?.index ?? code.length),
  }));
}

describe("REV-041 — the intel API is internal only", () => {
  it("has at least one route, and every route sits under /v1/internal/intel/", () => {
    const all = routes();
    assert.ok(all.length >= 1, "no route was found in routes/intelApi.ts — the scan is reading nothing");
    for (const r of all) {
      assert.ok(r.path.startsWith("/v1/internal/intel/"), `${r.verb.toUpperCase()} ${r.path} is not under /v1/internal/intel/: an external intel surface is an owner decision (08 §6.5)`);
    }
  });

  it("every route answers only an administrator: requireAdmin runs first and a refusal returns", () => {
    for (const r of routes()) {
      const gate = r.body.indexOf("await requireAdmin(req, res)");
      assert.ok(gate > 0, `${r.verb.toUpperCase()} ${r.path} does not call requireAdmin`);
      assert.match(r.body.slice(gate, gate + 120), /if \(!ctx\) return;/, `${r.path}: a refused requireAdmin does not end the request`);
      // Nothing reads the database before the gate.
      const firstRead = r.body.search(/\.from\(/);
      assert.ok(firstRead === -1 || gate < firstRead, `${r.path} reads the database before it has established the caller is an administrator`);
    }
  });

  it("issues and accepts no partner credential", () => {
    for (const word of ["api_key", "apiKey", "x-api-key", "partner_token", "partnerToken", "client_secret"]) {
      assert.ok(!code.includes(word), `routes/intelApi.ts names \`${word}\`: an external credential is not built and is an owner decision`);
    }
  });
});
