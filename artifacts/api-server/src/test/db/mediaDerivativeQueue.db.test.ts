import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { HAVE_DB, currentDatabaseUrl, exec, psql, scalar, seedUser, deleteUser } from "./localDb.js";

function session(sql: string, onLine?: (line: string) => void, continuation?: Promise<string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", currentDatabaseUrl()], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pendingLines = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("local fixture session timed out")); }, 15000);
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
      pendingLines += String(chunk);
      const lines = pendingLines.split("\n");
      pendingLines = lines.pop() ?? "";
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr));
      else resolve(stdout.split("\n").filter(Boolean));
    });
    if (continuation) {
      child.stdin.write(sql);
      void continuation.then(tail => child.stdin.end(tail), error => { child.kill("SIGKILL"); reject(error); });
    } else child.stdin.end(sql);
  });
}

describe("persistent media derivative queue on real PostgreSQL", { skip: !HAVE_DB }, () => {
  let ownerId = "";
  let flagBefore = "false";
  before(() => {
    flagBefore = scalar("SELECT enabled FROM feature_flags WHERE flag='media_derivative_jobs_enabled'") ?? "false";
    ownerId = seedUser("media_derivative");
    exec("UPDATE feature_flags SET enabled=true WHERE flag='media_derivative_jobs_enabled'");
  });
  after(() => {
    if (ownerId) {
      exec(`DELETE FROM media_assets WHERE owner_user_id='${ownerId}'`);
      deleteUser(ownerId);
    }
    exec(`UPDATE feature_flags SET enabled=${flagBefore === "t" || flagBefore === "true" ? "true" : "false"} WHERE flag='media_derivative_jobs_enabled'`);
  });
  function fixture() {
    const assetId = randomUUID();
    const model = `fixture-${randomUUID()}`;
    exec(`INSERT INTO media_assets(id,owner_user_id,uploader_user_id,storage_bucket,storage_path,media_type,mime_type,size_bytes,width,height,moderation_status,processing_status)
      VALUES('${assetId}','${ownerId}','${ownerId}','post-media','${ownerId}/${assetId}.jpg','image','image/jpeg',100,800,600,'approved','ready')`);
    const version = Number(scalar(`SELECT version FROM media_assets WHERE id='${assetId}'`));
    const enqueue = `SELECT media_derivative_enqueue('${assetId}','${ownerId}',${version},'image_variants','${model}');`;
    return { assetId, model, version, enqueue };
  }

  it("two simultaneous enqueue transactions persist exactly one job", async () => {
    const source = fixture();
    const results = await Promise.all([session(`BEGIN; SET LOCAL ROLE service_role; ${source.enqueue} SELECT pg_sleep(0.2); COMMIT;`), session(`SET ROLE service_role; ${source.enqueue}`)]);
    assert.equal(results[0][0], results[1][0]);
    assert.equal(scalar(`SELECT count(*) FROM media_derivative_jobs WHERE asset_id='${source.assetId}'`), "1");
  });

  it("SKIP LOCKED claims never duplicate a leased job", async () => {
    const source = fixture();
    exec(source.enqueue);
    const claim = `SELECT id FROM media_derivative_claim('image_variants','${source.model}',1,120);`;
    const results = await Promise.all([session(`BEGIN; SET LOCAL ROLE service_role; ${claim} SELECT pg_sleep(0.2); COMMIT;`), session(`SET ROLE service_role; ${claim}`)]);
    assert.equal(results.flat().filter(line => /^[a-f0-9-]{36}$/.test(line)).length, 1);
    assert.equal(scalar(`SELECT attempts FROM media_derivative_jobs WHERE asset_id='${source.assetId}'`), "1");
  });

  it("a changed canonical generation prevents leased result publication", () => {
    const source = fixture();
    exec(source.enqueue);
    const claimed = JSON.parse(scalar(`SELECT row_to_json(claimed) FROM media_derivative_claim('image_variants','${source.model}',1,120) claimed`) ?? "null") as { id: string; lease_token: string };
    assert.ok(claimed?.id);
    exec(`UPDATE media_assets SET caption='edited' WHERE id='${source.assetId}'`);
    assert.equal(scalar(`SELECT media_derivative_finish('${claimed.id}','${claimed.lease_token}',true)`), "f");
    assert.equal(scalar(`SELECT state FROM media_derivative_jobs WHERE id='${claimed.id}'`), "cancelled");
    assert.equal(scalar(`SELECT result IS NULL FROM media_derivative_jobs WHERE id='${claimed.id}'`), "t");
  });

  it("anonymous and authenticated roles cannot read or operate the worker queue", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const sql of ["SELECT * FROM media_derivative_jobs", "SELECT * FROM media_derivative_job_events", "SELECT media_derivative_claim('image_variants','fixture',1,120)", "SELECT media_derivative_schema_status()"]) {
        const result = psql(`SET LOCAL ROLE ${role}; ${sql}`, { single: true });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /permission denied/);
      }
    }
  });

  for (const operation of ["finish", "renew"]) {
    it(`${operation} refuses a lease that expires while waiting for the canonical source lock`, async () => {
      const source = fixture();
      exec(source.enqueue);
      const claimed = JSON.parse(scalar(`SELECT row_to_json(claimed) FROM media_derivative_claim('image_variants','${source.model}',1,120) claimed`) ?? "null") as { id: string; lease_token: string };
      let release!: (sql: string) => void;
      let markLocked!: () => void;
      let markStarted!: () => void;
      const locked = new Promise<void>(resolve => { markLocked = resolve; });
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const continuation = new Promise<string>(resolve => { release = resolve; });
      const holder = session(`BEGIN; SET LOCAL ROLE service_role; SELECT id FROM media_assets WHERE id='${source.assetId}' FOR UPDATE; SELECT 'source_locked';\n`,
        line => { if (line === "source_locked") markLocked(); }, continuation);
      let completion: Promise<string[]> | undefined;
      try {
        await Promise.race([locked, holder.then(() => { throw new Error("source lock not acquired"); })]);
        const argumentsSql = operation === "finish" ? "true" : "120";
        completion = session(`BEGIN; SET LOCAL ROLE service_role; SELECT 'operation_started'; SELECT media_derivative_${operation}('${claimed.id}','${claimed.lease_token}',${argumentsSql}); COMMIT;`,
          line => { if (line === "operation_started") markStarted(); });
        await Promise.race([started, completion.then(() => { throw new Error("operation did not start"); })]);
        exec(`UPDATE media_derivative_jobs SET lease_until=clock_timestamp()+interval '50 milliseconds' WHERE id='${claimed.id}'`);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(scalar(`SELECT lease_until < clock_timestamp() FROM media_derivative_jobs WHERE id='${claimed.id}'`), "t");
        release("COMMIT;\n");
        assert.equal((await completion).at(-1), "f");
        assert.equal(scalar(`SELECT state FROM media_derivative_jobs WHERE id='${claimed.id}'`), "processing");
        assert.equal(scalar(`SELECT result IS NULL FROM media_derivative_jobs WHERE id='${claimed.id}'`), "t");
      } finally {
        release("ROLLBACK;\n");
        await Promise.allSettled([holder, ...(completion ? [completion] : [])]);
      }
    });
  }
});
