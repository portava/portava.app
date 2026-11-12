import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from '../../services/messagingOwnerRequest.ts';

export type CaptureTarget = 'post' | 'story';
export interface RecordingStamp { id: string; code: string; targetType: CaptureTarget; targetId: string; issuedAt: string; kind: 'portava_recording' }
export interface CaptureSession { captureToken: string; expiresAt: string; owner: MessagingOwnerRequest }
export interface CameraRecording { uri: string; session: CaptureSession }
const issuedCaptures = new WeakSet<CameraRecording>();
const captured = new WeakMap<object, CameraRecording>();
type CameraAsset = { uri: string; type?: string | null; mimeType?: string | null };

async function api(owner: MessagingOwnerRequest, path: string, body?: unknown, timeout = 8000) {
  const request = new AbortController();
  const timer = setTimeout(() => request.abort(), timeout);
  try {
    const token = await messagingOwnerToken(owner);
    if (!token || request.signal.aborted || !owner.isCurrent()) throw new Error('Sign in again to check this recording.');
    const response = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL}/api/capture-stamps${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: request.signal,
    });
    const result = await response.json().catch(() => null);
    if (!owner.isCurrent()) throw new Error('Your signed-in session changed.');
    if (!response.ok || !result) throw new Error(result?.message || 'The recording stamp could not be checked.');
    return result;
  } finally { clearTimeout(timer); }
}
export async function beginCaptureSession(): Promise<CaptureSession | null> {
  const owner = captureMessagingOwnerRequest();
  if (!owner || !process.env.EXPO_PUBLIC_API_BASE_URL) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([api(owner, '/sessions', {}, 1800),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1800); })]);
    if (owner.isCurrent() && typeof result?.captureToken === 'string' && result.captureToken && Date.parse(result.expiresAt) > Date.now()) {
      return Object.freeze({ captureToken: result.captureToken, expiresAt: result.expiresAt, owner });
    }
  } catch { /* Recording is always available even if issuance is offline. */ }
  finally { clearTimeout(timer); }
  owner.invalidate();
  return null;
}

/** Only call with the result of the camera invocation that this session preceded. */
export function bindCameraRecording(session: CaptureSession | null, original: CameraAsset | null, picked: CameraAsset | null) {
  if (!session) return;
  if (!original || !picked || original.uri !== picked.uri || !session.owner.isCurrent() || Date.parse(session.expiresAt) <= Date.now()
    || !(original.type === 'video' || original.mimeType?.startsWith('video/'))) { session.owner.invalidate(); return; }
  const recording = Object.freeze({ uri: picked.uri, session });
  captured.set(picked, recording); issuedCaptures.add(recording);
}
export function recordedAsset(asset: CameraAsset): CameraRecording | null {
  const capture = captured.get(asset);
  return capture && capture.uri === asset.uri && capture.session.owner.isCurrent() ? capture : null;
}
export function captureCanUpload(capture: CameraRecording, uri: string) {
  return issuedCaptures.has(capture) && capture.uri === uri && capture.session.owner.isCurrent() && Date.parse(capture.session.expiresAt) > Date.now();
}
function checkedStamp(input: unknown, targetType: CaptureTarget, targetId: string): RecordingStamp | null {
  const s = input as Partial<RecordingStamp> | null;
  return s?.kind === 'portava_recording' && s.targetType === targetType && s.targetId === targetId && typeof s.id === 'string'
    && typeof s.code === 'string' && s.code.length > 0 && Number.isFinite(Date.parse(s.issuedAt ?? '')) ? s as RecordingStamp : null;
}
export async function readRecordingStamp(owner: MessagingOwnerRequest, targetType: CaptureTarget, targetId: string) {
  const result = await api(owner, `/${targetType}/${encodeURIComponent(targetId)}`);
  return checkedStamp(result.stamp, targetType, targetId);
}
export async function issueRecordingStamp(capture: CameraRecording, targetType: CaptureTarget, targetId: string) {
  if (!issuedCaptures.has(capture) || !capture.session.owner.isCurrent()) throw new Error('This recording is unavailable.');
  const { owner, captureToken } = capture.session;
  const result = await api(owner, '/issue', { captureToken, targetType, targetId });
  const stamp = checkedStamp(result.stamp, targetType, targetId);
  if (!stamp) throw new Error('Recording stamp issuance was not confirmed.');
  return stamp;
}
