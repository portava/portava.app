-- KeyPackage publication retries must never mint a second copy of a one-use key.
-- Ledger rows contain only a SHA-256 fingerprint of PUBLIC key-package bytes.
BEGIN;
LOCK TABLE public.devices, public.key_packages IN SHARE ROW EXCLUSIVE MODE;
CREATE SCHEMA IF NOT EXISTS telegraph_crypto_private;
REVOKE ALL ON SCHEMA telegraph_crypto_private FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS telegraph_crypto_private.key_package_publications (
 device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
 fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
 PRIMARY KEY(device_id,fingerprint)
);
REVOKE ALL ON TABLE telegraph_crypto_private.key_package_publications FROM PUBLIC, anon, authenticated;

-- Decode first: alternate base64 padding/alphabet must not evade deduplication.
CREATE OR REPLACE FUNCTION telegraph_crypto_private.key_package_fingerprint(p_value text)
RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE v_text text; v_bytes bytea;
BEGIN
 IF length(p_value)<4 OR length(p_value)>65536 OR p_value !~ '^[A-Za-z0-9_+/=-]+$' THEN RETURN NULL; END IF;
 v_text=translate(rtrim(p_value,'='),'-_','+/');
 IF length(v_text)%4=1 THEN RETURN NULL; END IF;
 BEGIN v_bytes=decode(v_text || repeat('=',(4-length(v_text)%4)%4),'base64');
 EXCEPTION WHEN invalid_parameter_value THEN RETURN NULL; END;
 IF replace(encode(v_bytes,'base64'),E'\n','')<>v_text || repeat('=',(4-length(v_text)%4)%4) THEN RETURN NULL; END IF;
 RETURN sha256(v_bytes);
END; $$;
REVOKE ALL ON FUNCTION telegraph_crypto_private.key_package_fingerprint(text) FROM PUBLIC, anon, authenticated;

-- Invalid old pool entries cannot form MLS groups. Retain one valid copy of
-- each public package, and seed the receipt ledger before accepting retries.
DELETE FROM public.key_packages WHERE telegraph_crypto_private.key_package_fingerprint(key_package_b64) IS NULL;
DELETE FROM public.key_packages k USING (
 SELECT id,row_number() OVER(PARTITION BY device_id,telegraph_crypto_private.key_package_fingerprint(key_package_b64) ORDER BY created_at,id) n
 FROM public.key_packages
) duplicate WHERE k.id=duplicate.id AND duplicate.n>1;
INSERT INTO telegraph_crypto_private.key_package_publications(device_id,fingerprint)
 SELECT device_id,telegraph_crypto_private.key_package_fingerprint(key_package_b64) FROM public.key_packages
 ON CONFLICT DO NOTHING;
UPDATE public.devices d SET key_package_count=(SELECT count(*) FROM public.key_packages k WHERE k.device_id=d.id);

CREATE OR REPLACE FUNCTION public.publish_key_packages(p_owner_id uuid,p_device_id uuid,p_packages text[])
RETURNS TABLE(uploaded integer,total_pool integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_value text; v_fingerprint bytea; v_inserted integer; v_count integer; v_new integer=0;
BEGIN
 IF p_owner_id IS NULL OR p_device_id IS NULL OR p_packages IS NULL OR cardinality(p_packages) NOT BETWEEN 1 AND 50 THEN
   RAISE EXCEPTION 'invalid key package batch' USING ERRCODE='22023';
 END IF;
 -- Publication and consumption acquire this lock FIRST, so counter updates
 -- and one-use receipts cannot race or deadlock by locking rows in reverse.
 PERFORM 1 FROM public.devices WHERE id=p_device_id AND user_id=p_owner_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'device not owned' USING ERRCODE='42501'; END IF;
 FOREACH v_value IN ARRAY p_packages LOOP
   v_fingerprint=telegraph_crypto_private.key_package_fingerprint(v_value);
   IF v_fingerprint IS NULL THEN RAISE EXCEPTION 'invalid key package encoding' USING ERRCODE='22023'; END IF;
   INSERT INTO telegraph_crypto_private.key_package_publications(device_id,fingerprint) VALUES(p_device_id,v_fingerprint) ON CONFLICT DO NOTHING;
   GET DIAGNOSTICS v_inserted=ROW_COUNT;
   IF v_inserted=1 THEN
     INSERT INTO public.key_packages(device_id,key_package_b64) VALUES(p_device_id,v_value);
     v_new=v_new+1;
   END IF;
 END LOOP;
 SELECT count(*) INTO v_count FROM public.key_packages WHERE device_id=p_device_id;
 IF v_count>100 THEN RAISE EXCEPTION 'key package pool full' USING ERRCODE='54000'; END IF;
 UPDATE public.devices SET key_package_count=v_count WHERE id=p_device_id;
 RETURN QUERY SELECT v_new,v_count;
END; $$;
REVOKE ALL ON FUNCTION public.publish_key_packages(uuid,uuid,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_key_packages(uuid,uuid,text[]) TO service_role;

CREATE OR REPLACE FUNCTION public.consume_key_package(p_device_id uuid)
RETURNS TABLE(id uuid,key_package_b64 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_id uuid; v_b64 text;
BEGIN
 PERFORM 1 FROM public.devices WHERE devices.id=p_device_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 DELETE FROM public.key_packages k WHERE k.id=(
   SELECT k2.id FROM public.key_packages k2 WHERE k2.device_id=p_device_id ORDER BY k2.created_at,k2.id LIMIT 1
 ) RETURNING k.id,k.key_package_b64 INTO v_id,v_b64;
 UPDATE public.devices d SET key_package_count=(SELECT count(*) FROM public.key_packages k WHERE k.device_id=p_device_id) WHERE d.id=p_device_id;
 -- Publication fingerprints survive consumption: a response-loss retry may
 -- acknowledge the old package, but must never put it back in the pool.
 IF v_id IS NULL THEN RETURN; END IF;
 id=v_id; key_package_b64=v_b64; RETURN NEXT;
END; $$;
REVOKE ALL ON FUNCTION public.consume_key_package(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_key_package(uuid) TO service_role;
COMMIT;
