import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { persistMediaEventBatch } from '../lib/mediaAnalytics.js';

test('awaited batch receipt reflects actual4031 creator/actor erasure trigger refusals',async()=>{
 const db=new PGlite();
 const A='10000000-0000-4000-8000-000000000001', B='10000000-0000-4000-8000-000000000002';
 const P='20000000-0000-4000-8000-000000000001', Q='20000000-0000-4000-8000-000000000002';
 try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
   CREATE TABLE profiles(id uuid PRIMARY KEY,account_status text); INSERT INTO profiles VALUES('${A}','active'),('${B}','deleted');
   CREATE TABLE posts(id uuid PRIMARY KEY,author_id uuid,created_by uuid); INSERT INTO posts VALUES('${P}','${A}','${A}'),('${Q}','${B}','${B}');
   CREATE TABLE media_assets(id uuid PRIMARY KEY,owner_user_id uuid,uploader_user_id uuid);
   CREATE TABLE hidden_gems(id uuid PRIMARY KEY,submitted_by uuid);
   CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean,description text,metadata jsonb);`);
  for(const file of ['2039_media_events','4031_media_event_erasure_and_retention']) {
   await db.exec(readFileSync(new URL(`../migrations/${file}.sql`,import.meta.url),'utf8'));
  }
  await db.exec("INSERT INTO feature_flags(flag,enabled) VALUES('MEDIA_ANALYTICS_ENABLED',true) ON CONFLICT(flag) DO UPDATE SET enabled=true");
  const sc={from(table:string){let inserted:unknown=null;const b={select(){return b;},eq(){return b;},
   maybeSingle:async()=>({data:(await db.query("SELECT enabled FROM feature_flags WHERE flag='MEDIA_ANALYTICS_ENABLED'")).rows[0],error:null}),
   insert(rows:unknown){inserted=rows;return b;},
   then(resolve:any,reject:any){assert.equal(table,'media_events');return db.query('INSERT INTO media_events(event_type,payload) SELECT event_type,payload FROM jsonb_to_recordset($1::jsonb) AS input(event_type text,payload jsonb) RETURNING id',[JSON.stringify(inserted)]).then(result=>({data:result.rows,error:null})).then(resolve,reject);},
  };return b;}};
  const events=[P,Q].map(media_id=>({type:'place_open' as const,payload:{viewer_id:A,media_id}}));
  assert.deepEqual(await persistMediaEventBatch(events,sc),{accepted:1,discarded:1,failed:0,disabled:false});
  await db.query('SELECT erase_media_events_for_actor($1,500)',[A]);
  assert.deepEqual(await persistMediaEventBatch(events,sc),{accepted:0,discarded:2,failed:0,disabled:false});
  assert.equal((await db.query<any>('SELECT count(*)::int n FROM media_events')).rows[0].n,0);
 } finally {await db.close();}
});
