import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const actor = '10000000-0000-4000-8000-000000000001', other = '10000000-0000-4000-8000-000000000002';
const post = '20000000-0000-4000-8000-000000000001', op = '30000000-0000-4000-8000-000000000001';
async function database() {
    const db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text,public boolean);INSERT INTO storage.buckets VALUES('post-media',false);
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${actor}'),('${other}');
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid',true),'')::uuid $$;
 CREATE TABLE profiles(id uuid PRIMARY KEY,account_status text);INSERT INTO profiles VALUES('${actor}','active'),('${other}','active');
 CREATE TYPE public.post_visibility AS ENUM('public','private','trip_only');
 CREATE TABLE posts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),author_id uuid,visibility post_visibility DEFAULT 'public',post_status text DEFAULT 'published',status text DEFAULT 'active',deleted_at timestamptz,trip_id uuid,content text,media_urls text[] DEFAULT '{}',media_count integer DEFAULT 0,location_name text,location_city text,location_country text,location_lat double precision,location_lng double precision,location_place_id text,original_lat double precision,original_lng double precision,public_lat double precision,public_lng double precision,published_at timestamptz,updated_at timestamptz);
 CREATE TABLE trips(id uuid PRIMARY KEY,owner_id uuid);CREATE TABLE trip_members(trip_id uuid,user_id uuid,role text,status text);
 CREATE TABLE post_media(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),post_id uuid,user_id uuid,processing_status text,moderation_status text,updated_at timestamptz,media_type text,storage_bucket text,storage_path text,public_url text,mime_type text,sort_order integer,thumbnail_storage_path text,thumbnail_url text,duration_seconds double precision);
 CREATE TABLE media_assets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid,storage_bucket text,storage_path text,deleted_at timestamptz);
 CREATE TABLE passport_postcards(post_id uuid,user_id uuid,status text,visibility post_visibility);
 GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
    await db.exec(readFileSync(new URL('../migrations/4028_postcard_private_draft_publication.sql', import.meta.url), 'utf8'));
    return db;
}
async function rpc(db: PGlite, name: string, a = actor, p = post) { return (await db.query<{
    result: {
        ok: boolean;
        error?: string;
        repeated?: boolean;
    };
}>(`SELECT ${name}($1,$2) result`, [a, p])).rows[0]!.result; }
async function shell(db: PGlite) { await db.exec(`INSERT INTO posts(id,author_id,visibility,post_status,postcard_draft_state,postcard_requested_visibility,content) VALUES('${post}','${actor}','private','draft','draft','public','private words');`); }
async function commit(db: PGlite, operation: string, options: { actor?: string; id?: string; mediaType?: string } = {}) {
 const a=options.actor??actor,id=options.id??post;
 const p={id,author_id:a,content:'only published if every attachment commits',visibility:'public',post_status:'published',composer_upload_operation_id:operation};
 const m=[{post_id:id,user_id:a,media_type:options.mediaType??'image',storage_bucket:'post-media',storage_path:`${a}/${operation}.jpg`,public_url:`post-media/${a}/${operation}.jpg`,mime_type:'image/jpeg',processing_status:'ready',moderation_status:'pending',sort_order:0}];
 return (await db.query<{result:{id:string;repeated:boolean}}>('SELECT commit_composer_post($1,$2,$3) result',[a,JSON.stringify(p),JSON.stringify(m)])).rows[0]!.result;
}
test('private postcard: readiness, owner authorization, publish retry, cancellation in both race orders', async () => {
    const db = await database();
    try {
        await shell(db);
        await assert.rejects(db.exec(`INSERT INTO passport_postcards(post_id,user_id,status,visibility) VALUES('${post}','${actor}','active','public')`), /postcard_not_published/);
        assert.equal((await rpc(db, 'publish_postcard_draft')).error, 'media_not_ready');
        assert.equal((await rpc(db, 'publish_postcard_draft', other)).error, 'not_found');
        await db.exec(`INSERT INTO post_media(post_id,user_id,processing_status,moderation_status) VALUES('${post}','${actor}','ready','approved')`);
        assert.equal((await rpc(db, 'publish_postcard_draft')).ok, true);
        assert.equal((await rpc(db, 'publish_postcard_draft')).repeated, true);
        await db.exec(`INSERT INTO passport_postcards(post_id,user_id,status,visibility) VALUES('${post}','${actor}','active','public')`);
        assert.equal((await rpc(db, 'cancel_postcard_draft')).ok, true);
        assert.equal((await db.query('SELECT * FROM passport_postcards')).rows.length,0);
        await assert.rejects(db.exec(`INSERT INTO passport_postcards(post_id,user_id,status,visibility) VALUES('${post}','${actor}','active','public')`), /postcard_not_published/);
        assert.equal((await rpc(db, 'publish_postcard_draft')).error, 'draft_cancelled');
        const row = (await db.query<any>('SELECT * FROM posts')).rows[0];
        assert.equal(row.visibility, 'private');
        assert.equal(row.content, '');
        assert.equal(row.status, 'deleted');
        assert.equal(row.postcard_cleanup_pending, true);
        assert.equal((await db.query<any>('SELECT processing_status FROM post_media')).rows[0].processing_status, 'pending');
        await assert.rejects(db.exec("UPDATE post_media SET processing_status='ready'"), /draft_cancelled/);
        await db.exec('DELETE FROM post_media');
        assert.equal((await db.query<any>('SELECT postcard_cleanup_pending FROM posts')).rows[0].postcard_cleanup_pending, false);
        await db.exec('DELETE FROM posts');
        await shell(db);
        await rpc(db, 'cancel_postcard_draft');
        assert.equal((await rpc(db, 'publish_postcard_draft')).error, 'draft_cancelled');
        await assert.rejects(db.exec(`INSERT INTO post_media(post_id,user_id,processing_status) VALUES('${post}','${actor}','pending')`), /draft_cancelled/);
    }
    finally {
        await db.close();
    }
});
test('trip revocation and flagged media never publish; public draft state violates constraint', async () => {
    const db = await database();
    try {
        await shell(db);
        await assert.rejects(db.exec("UPDATE posts SET visibility='public'"), /posts_postcard_draft_private_check/);
        await db.exec(`UPDATE posts SET trip_id='40000000-0000-4000-8000-000000000001';INSERT INTO trips VALUES('40000000-0000-4000-8000-000000000001','${actor}');INSERT INTO trip_members VALUES('40000000-0000-4000-8000-000000000001','${actor}','owner','removed');`);
        assert.equal((await rpc(db, 'publish_postcard_draft')).error, 'not_member');
        await db.exec(`UPDATE trip_members SET status='accepted';INSERT INTO post_media(post_id,user_id,processing_status,moderation_status) VALUES('${post}','${actor}','ready','flagged');`);
        assert.equal((await rpc(db, 'publish_postcard_draft')).error, 'media_not_ready');
        const perms = (await db.query<{
            allowed: boolean;
        }>("SELECT has_function_privilege('authenticated','publish_postcard_draft(uuid,uuid)','EXECUTE') allowed")).rows[0];
        assert.equal(perms!.allowed, false);
    }
    finally {
        await db.close();
    }
});
test('main upload: cancel before reservation blocks late upload, private RLS, atomic publish claim and ownership', async () => {
    const db = await database();
    try {
        const reserve = async (id = op, a = actor) => (await db.query<any>('SELECT reserve_composer_upload($1,$2,$3,$4) result', [a, id, [`${a}/${id}.jpg`], 'digest'])).rows[0].result;
        await rpc(db, 'cancel_composer_upload', actor, op);
        assert.equal((await reserve()).error, 'draft_cancelled');
        const next = '30000000-0000-4000-8000-000000000002';
        assert.equal((await reserve(next)).ok, true);
        assert.equal((await reserve(next, other)).ok, false);
        assert.equal((await rpc(db, 'finish_composer_upload', actor, next)).ok, true);
        await assert.rejects(commit(db,next,{actor:other}), /draft_upload_unavailable/);
        await assert.rejects(db.exec(`INSERT INTO posts(id,author_id,composer_upload_operation_id) VALUES('${post}','${actor}','${next}')`), /requires_atomic_commit/);
        await commit(db,next);
        assert.equal((await rpc(db, 'cancel_composer_upload', actor, next)).error, 'already_published');
        assert.equal((await db.query<any>(`SELECT post_id,state FROM composer_upload_intents WHERE id='${next}'`)).rows[0].post_id, post);
        await db.exec(`UPDATE profiles SET account_status='deleted' WHERE id='${actor}'`);
        assert.equal((await reserve('30000000-0000-4000-8000-000000000003')).error, 'account_unavailable');
        await db.exec('SET ROLE authenticated');
        await assert.rejects(db.exec('SELECT * FROM composer_upload_intents'), /permission denied/);
    }
    finally {
        await db.close();
    }
});

test('main post publication atomically rolls back failed attachments and retries a committed operation exactly once', async()=>{
 const db=await database();try{
  await db.query('SELECT reserve_composer_upload($1,$2,$3,$4)',[actor,op,[`${actor}/${op}.jpg`],'digest']);
  await rpc(db,'finish_composer_upload',actor,op);
  await db.exec("ALTER TABLE post_media ADD CONSTRAINT media_kind_test CHECK (media_type IN ('image','video'))");
  await assert.rejects(commit(db,op,{mediaType:'broken'}),/media_kind_test/);
  assert.equal((await db.query('SELECT * FROM posts')).rows.length,0);
  assert.equal((await db.query<{state:string}>('SELECT state FROM composer_upload_intents')).rows[0]!.state,'ready');
  const first=await commit(db,op);assert.equal(first.repeated,false);
  const again=await commit(db,op,{id:'20000000-0000-4000-8000-000000000099'});assert.equal(again.id,post);assert.equal(again.repeated,true);
  assert.equal((await db.query('SELECT * FROM posts')).rows.length,1);assert.equal((await db.query('SELECT * FROM post_media')).rows.length,1);
  assert.equal((await rpc(db,'cancel_composer_upload',actor,op)).error,'already_published');
  const privileges=await db.query<{allowed:boolean}>("SELECT has_function_privilege('authenticated','commit_composer_post(uuid,jsonb,jsonb)','EXECUTE') allowed");assert.equal(privileges.rows[0]!.allowed,false);
 }finally{await db.close();}
});

test('main upload cancellation before atomic publication prevents every post and attachment write',async()=>{
 const db=await database();try{
  await db.query('SELECT reserve_composer_upload($1,$2,$3,$4)',[actor,op,[`${actor}/${op}.jpg`],'digest']);await rpc(db,'finish_composer_upload',actor,op);
  await rpc(db,'cancel_composer_upload',actor,op);await assert.rejects(commit(db,op),/draft_upload_unavailable/);
  assert.equal((await db.query('SELECT * FROM posts')).rows.length,0);assert.equal((await db.query('SELECT * FROM post_media')).rows.length,0);
 }finally{await db.close();}
});
test('activation refuses a public storage bucket, and clients cannot forge postcard lifecycle state', async () => {
    const unsafe = new PGlite();
    try {
        await unsafe.exec("CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text,public boolean);INSERT INTO storage.buckets VALUES('post-media',true)");
        await assert.rejects(unsafe.exec(readFileSync(new URL('../migrations/4028_postcard_private_draft_publication.sql', import.meta.url), 'utf8')), /post-media must be private/);
    }
    finally {
        await unsafe.close();
    }
    const db = await database();
    try {
        await shell(db);
        await db.exec('GRANT SELECT,UPDATE ON posts TO authenticated;SET ROLE authenticated');
        await assert.rejects(db.exec("UPDATE posts SET postcard_draft_state='published',visibility='public',post_status='published'"), /server_owned_postcard_lifecycle/);
    }
    finally {
        await db.close();
    }
});

test('late canonical writes cannot resurrect discarded or erased-account draft metadata',async()=>{
 const db=await database();try{
 const path=`${actor}/composer-drafts/${op}.jpg`;
 const insert=()=>db.query("INSERT INTO media_assets(owner_user_id,storage_bucket,storage_path) VALUES($1,'post-media',$2)",[actor,path]);
 await assert.rejects(insert(),/draft_upload_unavailable/);
 await db.query('SELECT reserve_composer_upload($1,$2,$3,$4)',[actor,op,[path],'digest']);await insert();
 await rpc(db,'cancel_composer_upload',actor,op);await assert.rejects(insert(),/draft_upload_unavailable/);
 await db.exec('DELETE FROM composer_upload_intents');await assert.rejects(insert(),/draft_upload_unavailable/);
 }finally{await db.close();}
});
