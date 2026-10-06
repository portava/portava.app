/**
 * REV-020 — every server write of an event's ticket link is behind the host
 * allowlist (docs/architecture/08_Portava_Revenue_Model.md §3.5).
 *
 * The behavioural proof is eventsTicketUrlOnUpdate.test.ts, over the real
 * router. This file is the part that needs no server: it reads the tree and
 * pins WHO writes `events.price_url` / `events.ticket_url`, so that a new
 * writer (an admin route, an importer, an AI suggestion) cannot arrive without
 * the check and without this list being edited by someone who read it.
 *
 *   A. Outside routes/events.ts, nothing under src/ writes either column,
 *      except the one demo-seed script named below.
 *   B. routes/events.ts has exactly four write sites, and each sits behind
 *      checkTicketUrl or can only REMOVE the link: the two INSERTs (create,
 *      draft publish), the PATCH assignment, which goes through
 *      refuseTicketUrlOnUpdate BEFORE the handler's state write, and the PATCH
 *      `= null` a free event gets.
 *   C. The update refusal has the envelope create's has, refuses a CHANGE (not
 *      the stored value sent back), and holds a published draft to the link
 *      the request leaves.
 *   D. checkTicketUrl refuses every scheme but https, and create's schema
 *      holds a draft to https as well.
 *
 * Every scan counts what it inspected and fails on zero.
 *
 * Run: node --import tsx/esm --test src/test/eventsTicketUrlWriters.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../scripts/lib/stripComments.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS = join(SRC, "routes", "events.ts");

/** A write shape: an object key (`price_url: …`) or an assignment (`x.price_url = …`). Reads (`ev.price_url ??`) match neither. */
const WRITE_RE = /\b(?:price_url|ticket_url)\b\s*(?::|=(?!=))/g;

/**
 * Files allowed to carry a write shape besides routes/events.ts, each with the
 * reason it is not a route a user can reach.
 */
const NON_ROUTE_WRITERS: Record<string, string> = {
  // The generated table types: `price_url: string | null` is a type member, not a write.
  "lib/database.types.ts": "generated Supabase types",
  // A developer seed for the demo account, run by hand with the service key;
  // it is not mounted on the router and takes no request input.
  "scripts/seed-demo-profile.ts": "manual demo seed, no request input",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "test" || name === "__tests__" || name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Code only: comments removed, so prose quoting the defect cannot satisfy or fail a scan. */
const code = (file: string) => stripComments(readFileSync(file, "utf8"));

describe("REV-020 — who writes events.price_url / events.ticket_url", () => {
  it("A. outside routes/events.ts, only the named non-route files carry a write shape", () => {
    const files = sourceFiles(SRC);
    assert.ok(files.length > 500, `scanned only ${files.length} source files — the walker is broken`);
    const writers = files
      .filter((f) => f !== EVENTS)
      .filter((f) => (code(f).match(WRITE_RE) ?? []).length > 0)
      .map((f) => relative(SRC, f).split("\\").join("/"))
      .sort();
    assert.deepEqual(
      writers,
      Object.keys(NON_ROUTE_WRITERS).sort(),
      "a file other than routes/events.ts writes an event's ticket link. Route it through " +
        "checkTicketUrl (REV-020) and, if it is not reachable by a request, name it in NON_ROUTE_WRITERS with the reason.",
    );
  });

  const events = code(EVENTS);

  it("B. routes/events.ts has exactly four write sites: two INSERTs, the PATCH assignment, and the PATCH removal for a free event", () => {
    assert.ok(events.length > 100_000, "routes/events.ts did not load");
    // Each site up to the `,` or `;` that ends it.
    const sites = [...events.matchAll(WRITE_RE)].map((m) => events.slice(m.index!, m.index! + 60).split("\n")[0]!.replace(/([,;]).*$/, "$1").trim());
    // The helper's own parameter type (`price_url?: string | null`) is `?:`, which WRITE_RE does not match.
    assert.deepEqual(
      sites.map((s) => s.replace(/\s+/g, " ")),
      ["price_url: b.priceUrl ?? null,", "price_url: b.priceUrl ?? null,", "price_url = b.priceUrl;", "price_url = null;"],
      "the set of ticket-link write sites changed; each one must sit behind checkTicketUrl, or be able only to remove the link",
    );
    // The fourth is the removal, and it is taken only when the body names no link and makes the event free.
    assert.ok(
      /if \(b\.priceUrl\s+!== undefined\) patch\.price_url\s+= b\.priceUrl; else if \(b\.priceType === "free"\) patch\.price_url = null;/.test(events),
      "the PATCH no longer removes the link of an event that is made free without naming one",
    );
  });

  it("B. each INSERT is preceded, in its own handler, by checkTicketUrl", () => {
    const handlers = events.split(/\n(?=router\.(?:get|post|put|patch|delete)\()/);
    const inserting = handlers.filter((h) => /\bprice_url\s*:\s*b\.priceUrl/.test(h));
    assert.equal(inserting.length, 2, `expected two inserting handlers, found ${inserting.length}`);
    for (const h of inserting) {
      const check = h.indexOf("checkTicketUrl(");
      const write = h.search(/\bprice_url\s*:\s*b\.priceUrl/);
      assert.ok(check >= 0 && check < write, `a handler inserts price_url without checking it first: ${h.slice(0, 60)}`);
    }
  });

  it("B. PATCH /events/:id refuses through refuseTicketUrlOnUpdate before it writes state or the link", () => {
    const start = events.indexOf('router.patch("/events/:id"');
    assert.ok(start > 0, "the PATCH route is not in this file");
    const end = events.indexOf("\nrouter.", start + 10);
    const handler = events.slice(start, end);
    const guard = handler.indexOf("if (refuseTicketUrlOnUpdate(res, b, current)) return;");
    assert.ok(guard > 0, "PATCH /events/:id no longer calls refuseTicketUrlOnUpdate and returns on a refusal");
    const stateWrite = handler.indexOf("writeEventState(");
    const linkWrite = handler.search(/patch\.price_url\s*=/);
    assert.ok(stateWrite > 0 && linkWrite > 0, "the handler's state write or link assignment moved; re-anchor this test");
    assert.ok(guard < stateWrite, "the ticket-link refusal runs after the state write: a refused request would still change the event's state");
    assert.ok(guard < linkWrite, "the ticket-link refusal runs after the link is assembled into the patch");
  });

  it("C. the update refusal checks a CHANGED link and the link a published draft is left with, with create's envelope", () => {
    const i = events.indexOf("function refuseTicketUrlOnUpdate(");
    assert.ok(i > 0, "refuseTicketUrlOnUpdate is gone");
    const body = events.slice(i, events.indexOf("\n}\n", i));
    assert.ok(body.length > 400 && body.length < 2500, "the helper's body was not isolated; re-anchor this test");
    // What the link will be once the request is applied: null, a free event, the body's value, or the stored one.
    assert.ok(body.includes('const clears = body.priceUrl === null || (body.priceUrl === undefined && body.priceType === "free");'), "the two ways of removing the link are not both recognised");
    assert.ok(body.includes("const nextUrl = clears ? null : body.priceUrl ?? storedUrl;"), "the link the request leaves is not computed from the body and the stored row");
    // A change is checked; the stored value sent back is not a change.
    assert.ok(body.includes("if (!clears && body.priceUrl !== undefined && body.priceUrl !== storedUrl) {"), "an unchanged stored link is treated as a new write, or a changed one is not checked");
    assert.ok(body.includes("checkTicketUrl(body.priceUrl)"), "the body's link is not checked");
    // Publishing by PATCH is held to the link the request LEAVES, not only the one it carries.
    assert.ok(/stored\.state === "draft" && body\.state === "open"/.test(body), "the publish-by-PATCH case is not recognised");
    assert.ok(body.includes("checkTicketUrl(stored.ticket_url ?? nextUrl)"), "a draft published by PATCH is not held to the publish rule");
    assert.ok(body.includes("Remove the ticket link or replace it with an allowed one, then publish."), "the publish refusal does not tell the host the way out");
    const envelope = 'sendError(res, "invalid_payload", changeErr)';
    assert.ok(body.includes(envelope), "the update refusal does not use create's envelope");
    // Create's own line, so "the same shape as create" is a fact about create too.
    const create = events.slice(events.indexOf('router.post("/events",'), events.indexOf('router.post("/events",') + 4000);
    assert.ok(create.includes('sendError(res, "invalid_payload", ticketErr)'), "create no longer answers a refused ticket link with invalid_payload + the check's message");
  });

  it("D. checkTicketUrl refuses every scheme but https, before it looks at the host; create's schema holds a draft to https too", () => {
    // (The message says "https link", not "https://": stripComments does not parse
    // strings, and a `//` inside one would cut the rest of that line for every
    // scan of this file that strips comments first — this one included.)
    const i = events.indexOf("function checkTicketUrl(");
    assert.ok(i > 0, "checkTicketUrl is gone");
    const body = events.slice(i, events.indexOf("\n}\n", i));
    const scheme = body.indexOf('if (parsed.protocol !== "https:") return "Ticket URL must be an https link";');
    const host = body.indexOf("ALLOWED_TICKET_HOSTS.some(");
    assert.ok(scheme > 0, "checkTicketUrl no longer refuses a scheme that is not https: `javascript://eventbrite.com/…` carries an allowlisted host");
    assert.ok(host > scheme, "the scheme is checked after the host, or the host check is gone");
    // Every checker's messages begin "Ticket URL": the app recognises a link refusal by it.
    for (const m of body.matchAll(/return\s+[`"]([^`"]+)/g)) assert.ok(m[1]!.startsWith("Ticket URL"), `checkTicketUrl answers "${m[1]}"`);

    const schema = events.slice(events.indexOf("const CreateEventSchema = z.object({"), events.indexOf("const UpdateEventSchema = z.object({"));
    assert.ok(schema.includes('priceUrl: z.string().url().refine(isHttpsUrl, "Ticket URL must be an https link").optional().nullable(),'.replace("priceUrl: ", "priceUrl:        ")),
      "create no longer holds the link to https at the schema, so a DRAFT can store another scheme");
    // …and the UPDATE schema deliberately does not: the stored link is sent back with every edit, and a
    // stored non-https link must not make the event uneditable (refuseTicketUrlOnUpdate decides instead).
    const update = events.slice(events.indexOf("const UpdateEventSchema = z.object({"), events.indexOf("const RsvpSchema = z.object({"));
    assert.ok(/priceUrl:\s+z\.string\(\)\.url\(\)\.nullable\(\)\.optional\(\),/.test(update), "the update schema changed; re-read whether a re-sent stored link still passes it");
    assert.ok(/function isHttpsUrl\(url: string\): boolean \{\s*try \{ return new URL\(url\)\.protocol === "https:"; \} catch \{ return false; \}\s*\}/.test(events), "isHttpsUrl no longer tests the parsed scheme");
  });
});
