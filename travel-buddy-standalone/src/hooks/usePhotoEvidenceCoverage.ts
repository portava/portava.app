/**
 * usePhotoEvidenceCoverage — does the server say THIS account's consent covers
 * keeping a map photo? (census-map §45.12)
 *
 * Reads GET /v1/intel/consent (services/intelConsent.getIntelConsent) and
 * answers with `photoStepOffered`. It is false:
 *   - while `enabled` is false (map capture is off, so nothing is asked);
 *   - until the read resolves;
 *   - when the read fails or returns nothing;
 *   - whenever the server does not answer `coversPhotoEvidence: true`.
 *
 * Read once per time capture becomes enabled on this screen. A consent granted
 * elsewhere while the map stays mounted is seen the next time the map mounts;
 * until then the photo step stays hidden, which is the safe direction.
 */
import { useEffect, useState } from 'react';
import { getIntelConsent } from '../services/intelConsent.ts';
import { photoStepOffered } from '../features/map/truth/photoEvidenceCoverage.ts';

export function usePhotoEvidenceCoverage(enabled: boolean): boolean {
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    getIntelConsent().then(
      (state) => { if (live) setCovered(photoStepOffered(state)); },
      () => { if (live) setCovered(false); },
    );
    // Forget the answer when capture turns off or the screen goes, so a later
    // re-enable starts from "no" until the new read lands.
    return () => { live = false; setCovered(false); };
  }, [enabled]);

  return enabled && covered;
}
