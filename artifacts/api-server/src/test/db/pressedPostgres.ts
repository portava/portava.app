/** Persistent transactions and disposable, fully replayed PostgreSQL databases.
 * This test harness accepts loopback only. It never alters the database named
 * in LOCAL_DB_URL; that URL supplies server credentials for generated databases.
 */
import { randomUUID } from "node:crypto";
import { Client, types, type QueryResult } from "pg";
import type { BridgeEngine, Row } from "./postgrestSqlBridge.js";
import type { ReplayReport } from "./pressedLayoverDb.js";

// Match PostgREST/PGlite JSON, without the pg driver's implicit local Date conversion.
types.setTypeParser(1184, (value) => value);
types.setTypeParser(1114, (value) => value);
type ReplayDatabase = { exec(sql: string): Promise<unknown>; query(sql: string): Promise<{rows: Row[]}>; close(): Promise<void> };
type Engine = BridgeEngine & { exec(sql: string): Promise<void>; close(): Promise<void> };
interface Options {
  url: string;
  without: readonly string[];
  prelude(role: string, claims: Record<string, unknown>): string;
  key(version: string): Promise<string>;
  replay(db: ReplayDatabase, version: string, major: number): Promise<ReplayReport>;
}

export function pressedPostgresServer(url: string): URL {
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("Pressed PostgreSQL tests require a loopback throwaway server");
  }
  // Connection-string parameters must not replace the validated host or route
  // this test helper through an alternate server/service/socket.
  for (const key of ["host", "hostaddr", "port", "service", "servicefile", "dbname", "database"]) {
    if (parsed.searchParams.has(key)) throw new Error("Pressed PostgreSQL connection overrides are not allowed");
  }
  return parsed;
}
/** pg-connection-string retains IPv6 brackets unless host is explicitly supplied.
 * Only this generated parameter may override the host, after input validation. */
export function pressedPostgresConnection(url: string, database: string): string {
  const parsed=pressedPostgresServer(url);parsed.pathname=`/${database}`;
  if(parsed.hostname==='[::1]')parsed.searchParams.set('host','::1');
  return parsed.toString();
}
const identifier = (name: string): string => {
  if (!/^pressed_(?:template|work)_[a-f0-9_]+$/.test(name)) throw new Error("Invalid generated test database name");
  return `"${name}"`;
};
const last = (result: QueryResult | QueryResult[]): QueryResult => Array.isArray(result) ? result[result.length - 1]! : result;

export async function openIsolatedPressedPostgres(options: Options): Promise<{engine: Engine; report: ReplayReport}> {
  const server = pressedPostgresServer(options.url);
  const connection = (database: string) => pressedPostgresConnection(server.toString(),database);
  const admin = new Client({connectionString: connection("postgres")});
  await admin.connect();
  let workName: string | null = null;
  let client: Client | null = null;
  try {
    const versionNumber = Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num);
    const major = Math.floor(versionNumber / 10000);
    const version = `postgresql@${versionNumber}`;
    const key = await options.key(version);
    if (!/^[a-f0-9]{24}$/.test(key)) throw new Error("Invalid pressed schema cache key");
    const template = `pressed_template_${key}`;
    // Serialize initialization/clone on this throwaway server. No template is
    // read before its complete replay report is atomically published as comment.
    await admin.query("SELECT pg_advisory_lock(hashtext($1))", [template]);
    let report: ReplayReport;
    try {
      const found = await admin.query("SELECT shobj_description(oid,'pg_database') AS report FROM pg_database WHERE datname=$1", [template]);
      const saved = found.rows[0]?.report;
      if (saved) {
        report = JSON.parse(saved) as ReplayReport;
        if (report.key !== key || report.engine !== version) throw new Error("Pressed template provenance mismatch");
      } else {
        if (found.rows.length) await admin.query(`DROP DATABASE ${identifier(template)}`);
        await admin.query(`CREATE DATABASE ${identifier(template)} TEMPLATE template0`);
        // Roles are cluster-wide, even though schema/data live in separate
        // databases. Different cold template keys must not race role DDL.
        await admin.query("SELECT pg_advisory_lock(hashtext('pressed-schema-replay'))");
        try {
          const builder = new Client({connectionString: connection(template)});
          try {
            await builder.connect();
            report = {...await options.replay({
              exec: (sql) => builder.query(sql),
              query: async (sql) => ({rows: last(await builder.query(sql)).rows as Row[]}),
              close: async () => {},
            }, version, major), key};
          } finally { await builder.end(); }
        } finally { await admin.query("SELECT pg_advisory_unlock(hashtext('pressed-schema-replay'))"); }
        // Utility statements have no bind parameters; quote only our JSON report.
        await admin.query(`COMMENT ON DATABASE ${identifier(template)} IS '${JSON.stringify(report).replaceAll("'", "''")}'`);
      }
      workName = `pressed_work_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE ${identifier(workName)} TEMPLATE ${identifier(template)}`);
    } finally { await admin.query("SELECT pg_advisory_unlock(hashtext($1))", [template]); }
    client = new Client({connectionString: connection(workName)});
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'; SET search_path=public,extensions");
    const db = client;
    const name = workName;
    // ReadyForQuery reports I=idle, T=transaction, E=failed transaction, even
    // when BEGIN was embedded in a multi-statement exec. Do not guess from SQL.
    let transactionStatus='I';
    (db as unknown as {connection:{on(event:string,listener:(message:{status:string})=>void):void}}).connection.on('readyForQuery',message=>{transactionStatus=message.status;});
    let tail: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const next = tail.then(work, work); tail = next.catch(() => {}); return next;
    };
    let closed = false;
    const engine: Engine = {
      query: (sql) => serial(async () => last(await db.query(sql)).rows as Row[]),
      exec: (sql) => serial(async () => { await db.query(sql); }),
      request: (statements, role, claims) => serial(async () => {
        if(transactionStatus!=='I')throw new Error('Pressed request refused inside an explicit transaction; COMMIT or ROLLBACK it first');
        await db.query("BEGIN");
        try {
          await db.query(options.prelude(role, claims));
          let result: QueryResult | undefined;
          for (const statement of statements) result = last(await db.query(statement));
          await db.query("COMMIT");
          const row = result?.rows[0]; const value = row ? Object.values(row)[0] : null;
          return typeof value === "string" ? value : JSON.stringify(value ?? null);
        } catch (error) { await db.query("ROLLBACK"); throw error; }
      }),
      close: () => serial(async () => {
        if (closed) return; closed = true;
        try { await db.end(); await admin.query(`DROP DATABASE ${identifier(name)}`); }
        finally { await admin.end(); }
      }),
    };
    return {engine, report};
  } catch (error) {
    try { await client?.end(); if (workName) await admin.query(`DROP DATABASE IF EXISTS ${identifier(workName)}`); }
    finally { await admin.end(); }
    throw error;
  }
}
