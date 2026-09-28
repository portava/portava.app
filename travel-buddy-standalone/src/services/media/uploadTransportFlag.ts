/**
 * uploadTransportFlag — local, synchronous switch for the §37 upload transport:
 * the persisted upload queue (background upload), resumable parts, and OS
 * background transfer for each part.
 *
 * SHIPS OFF, and that is the point of it. The queue, the resume protocol and
 * the retry policy are complete and tested (src/services/media/__tests__), but
 * they have never run on a device, and an upload transport that misbehaves on
 * a real network loses users' posts. The existing single-PUT composer path is
 * what production keeps until this is flipped.
 *
 * Deliberately NOT a server feature flag: the resume half has to decide what to
 * do at APP LAUNCH, before any network — the same reason
 * config/accountScopedStorageFlag.ts is local. Flip DEFAULT_ENABLED once a
 * device run has shown (1) a part surviving an app kill and resuming from the
 * server's listing, and (2) a part completing while the app was backgrounded.
 */

const DEFAULT_ENABLED = false;

let _testOverride: boolean | null = null;

/** Test seam — force the switch on/off. Pass null to restore the shipped default. */
export function _setTestResumableUploadFlag(value: boolean | null): void {
  _testOverride = value;
}

export function isResumableMediaUploadEnabled(): boolean {
  if (_testOverride !== null) return _testOverride;
  return DEFAULT_ENABLED;
}
