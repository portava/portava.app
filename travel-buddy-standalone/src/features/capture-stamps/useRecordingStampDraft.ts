import { useRef, useState } from 'react';
import { issueRecordingStamp, recordedAsset, type CameraRecording, type CaptureTarget } from './recordingStamp.ts';
import type { ImagePickerAsset } from 'expo-image-picker';

type Publication = { recording: CameraRecording; type: CaptureTarget; id: string };

/** A publish followed by an interrupted issuance retries only the stamp, never the post. */
export function useRecordingStampDraft() {
  const [recording, setRecording] = useState<CameraRecording | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState<Publication | null>(null);
  const [stampError, setStampError] = useState('');
  const issuing = useRef(false);
  function select(asset: ImagePickerAsset | null) {
    if (pending) return;
    setRecording(asset ? recordedAsset(asset) : null);
    setEnabled(false); setStampError('');
  }
  async function finish(publication: Publication): Promise<boolean> {
    if (issuing.current) return false;
    issuing.current = true;
    setPending(publication);
    try {
      await issueRecordingStamp(publication.recording, publication.type, publication.id);
      setPending(null); setStampError('');
      return true;
    } catch (error) {
      setStampError(`Published. Recording stamp not confirmed. ${error instanceof Error ? error.message : 'Try again.'}`);
      return false;
    } finally { issuing.current = false; }
  }
  function reset() { setPending(null); setStampError(''); setEnabled(false); setRecording(null); }
  return { recording, enabled, setEnabled, select, reset, pending, stampError, finish,
    selected: enabled && recording?.session.owner.isCurrent() ? recording : null };
}
