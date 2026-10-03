/** lib/intel/captureErrors — which refusals a retry can fix. */
import { intelWriteErrorCopy, isConsentRefusal } from '../captureErrors.ts';

describe('intelWriteErrorCopy', () => {
  it('consent refusals (403 on capture, invalid_payload on confirm) are not retryable and name Settings', () => {
    for (const f of [{ code: 'forbidden', error: 'consent_required' }, { code: 'invalid_payload', error: 'consent_required' }]) {
      expect(isConsentRefusal(f)).toBe(true);
      const c = intelWriteErrorCopy(f, 'send');
      expect(c.retryable).toBe(false);
      expect(c.message).toMatch(/Settings/);
    }
  });
  it('a refused shape, a missing row, a disabled surface and an admin gate are not retryable', () => {
    for (const f of [{ code: 'invalid_payload', error: 'x' }, { code: 'not_found' }, { code: 'feature_disabled' }, { code: 'forbidden', error: 'Admin role required' }, { error: 'not_configured' }]) {
      expect(intelWriteErrorCopy(f, 'propose').retryable).toBe(false);
    }
    expect(intelWriteErrorCopy({ code: 'forbidden', error: 'Admin role required' }, 'submit').message).not.toMatch(/Settings/);
  });
  it('a db_error or a network failure is retryable and says so', () => {
    for (const f of [{ code: 'db_error' }, { error: 'network_error' }, {}]) {
      const c = intelWriteErrorCopy(f, 'record');
      expect(c.retryable).toBe(true);
      expect(c.message).toBe('Couldn’t record — tap to try again.');
    }
  });
});
