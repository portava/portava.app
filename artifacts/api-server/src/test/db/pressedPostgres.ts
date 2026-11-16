/** Persistent transactions on one exclusively leased disposable database.
 * Snapshot files restore the original state between whole-database variants.
 * The target must already exist, be loopback-only, and contain no user fixtures.
 */
import { openSnapshotLease } from "./pressedSnapshot.js";
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
const last = (result: QueryResult | QueryResult[]): QueryResult => Array.isArray(result) ? result[result.length - 1]! : result;

export async function openIsolatedPressedPostgres(options: Options): Promise<{engine: Engine; report: ReplayReport; url: string}> {
  const server = pressedPostgresServer(options.url);
  const connection = pressedPostgresConnection(server.toString(), decodeURIComponent(server.pathname.slice(1)));
  const client = new Client({connectionString: connection});
  await client.connect();
  let lease: Awaited<ReturnType<typeof openSnapshotLease>> | undefined;
  try {
    lease = await openSnapshotLease(client, server);
    const versionNumber = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
    const major = Math.floor(versionNumber / 10000);
    const version = `postgresql@${versionNumber}`;
    const key = await options.key(version);
    if (!/^[a-f0-9]{24}$/.test(key)) throw new Error("Invalid pressed schema cache key");
    let report = await lease.cached(key);
    if (report && report.engine !== version) throw new Error('Pressed snapshot engine mismatch');
    if (!report) {
      await lease.clear();
      await client.query("CREATE SCHEMA public AUTHORIZATION postgres");
      report = {...await options.replay({
        exec: (sql) => client.query(sql),
        query: async (sql) => ({rows: last(await client.query(sql)).rows as Row[]}),
        close: async () => {},
      }, version, major), key};
      await lease.cache(key, report);
    }
    await client.query("SET TIME ZONE 'UTC'; SET search_path=public,extensions");
    const db = client;
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
        try { await lease!.restore(); }
        finally { await db.end(); }
      }),
    };
    return {engine, report, url: connection};
  } catch (error) {
    try { await lease?.restore(); }
    catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Pressed replay failed and recovery needs attention'); }
    finally { await client.end(); }
    throw error;
  }
}
