import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isUuid } from '../../lib/followDecisions.js';

export type RecordingTarget = 'story' | 'post';
type Token = {id: string; hash: string};
function digest(value: Buffer | string) { return createHash('sha256').update(value).digest('hex'); }
function parseToken(input: unknown): Token | null {
  if (typeof input !== 'string') return null;
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(input);
  return match && isUuid(match[1]) ? { id: match[1], hash: digest(match[2]) } : null;
}
export async function openRecordingCapture(sc: any, owner: string) {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  const result = await sc.rpc('open_recording_capture', {p_owner: owner, p_id: id, p_hash: digest(secret)});
  if (result.error) throw result.error;
  if (typeof result.data !== 'string') throw new Error('capture_unavailable');
  return {captureToken: `${id}.${secret}`, expiresAt: result.data};
}
/** The hash covers the actual privacy-scrubbed bytes sent to storage. */
export async function sealRecordingUpload(sc: any, owner: string, tokenValue: unknown, bytes: Buffer, extension: string) {
  const token = parseToken(tokenValue);
  if (!token) throw new Error('capture_refused');
  const result = await sc.rpc('seal_recording_capture', {p_owner:owner, p_id:token.id, p_hash:token.hash, p_sha:digest(bytes), p_extension:extension});
  if (result.error) throw result.error;
  if (result.data !== `${owner}/capture-stamps/${token.id}.${extension}`) throw new Error('capture_refused');
  return result.data as string;
}
export async function issueRecordingStamp(sc: any, owner: string, tokenValue: unknown, targetType: RecordingTarget, targetId: string) {
  const token = parseToken(tokenValue);
  if (!token) throw new Error('capture_refused');
  const result = await sc.rpc('issue_recording_capture', {p_owner:owner, p_id:token.id, p_hash:token.hash, p_type:targetType, p_target:targetId});
  if (result.error) throw result.error;
  if (typeof result.data !== 'string' || !isUuid(result.data) || result.data === token.id) throw new Error('capture_unavailable');
  return result.data;
}
export function recordingStampDescriptor(row: {id: string; issued_at: string}, targetType: RecordingTarget, targetId: string) {
  return {id:row.id, code:`PV-${row.id.replaceAll('-', '').toUpperCase()}`, targetType, targetId, issuedAt:row.issued_at, kind:'portava_recording' as const};
}
