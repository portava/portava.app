import { createDubbingPlaybackLifetime, type DubbingPlaybackResource, type DubbingReleaseOutcome } from '../dubbingPlaybackLifetime.ts';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function resource(controller = {}) {
  return {
    controller,
    ownsMute: jest.fn(() => true),
    cancel: jest.fn(),
    release: jest.fn(async (): Promise<DubbingReleaseOutcome> => 'released'),
  };
}

test('active resources retain exact-controller ownership without blocking unrelated active controllers', () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource(); const second = resource();
  expect(owner.retain(first)).not.toBeNull(); expect(owner.retain(second)).not.toBeNull();
  expect(owner.canAdmit(first.controller)).toBe(false); expect(owner.retain(resource(first.controller))).toBeNull();
  expect(owner.canAdmit({})).toBe(true); expect(owner.inspect(first.controller).blocked).toBe(false);
});

test('retirement cancels synchronously and owns pending work before an asynchronous release begins', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource(); const held = deferred<DubbingReleaseOutcome>();
  first.release.mockReturnValue(held.promise); const lease = owner.retain(first)!;
  const pending = lease.retire();
  expect(first.cancel).toHaveBeenCalledTimes(1); expect(first.release).not.toHaveBeenCalled();
  expect(owner.inspect(first.controller)).toEqual({ blocked: true, pending: true, ownsMute: true });
  expect(owner.inspect({})).toEqual({ blocked: true, pending: true, ownsMute: false });
  expect(owner.retain(resource())).toBeNull();
  held.resolve('released'); expect(await pending).toBe('released'); expect(owner.canAdmit({})).toBe(true);
});

test('overlapping retirement requests share one cancellation and release', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource(); const held = deferred<DubbingReleaseOutcome>();
  first.release.mockReturnValue(held.promise); const lease = owner.retain(first)!;
  const original = lease.retire(); expect(lease.retire()).toBe(original); expect(first.cancel).toHaveBeenCalledTimes(1);
  held.resolve('released'); await original; expect(first.release).toHaveBeenCalledTimes(1);
  expect(await lease.retire()).toBe('released'); expect(first.release).toHaveBeenCalledTimes(1);
});

test('native uncertainty cannot be cleared by later callbacks returning released', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource();
  first.release.mockResolvedValueOnce('native_uncertain'); const lease = owner.retain(first)!;
  expect(await lease.retire()).toBe('native_uncertain');
  first.release.mockResolvedValue('released');
  expect(await lease.retire()).toBe('native_uncertain'); expect(first.release).toHaveBeenCalledTimes(1);
  expect(owner.canAdmit({})).toBe(false); expect(owner.inspect(first.controller)).toEqual({ blocked: true, pending: false, ownsMute: true });
});

test('a rejected release remains quarantined with no implicit retry', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource();
  first.release.mockRejectedValueOnce(Error('native failure')); const lease = owner.retain(first)!;
  expect(await lease.retire()).toBe('native_uncertain'); expect(await lease.retire()).toBe('native_uncertain');
  expect(first.release).toHaveBeenCalledTimes(1); expect(owner.canAdmit({})).toBe(false);
});

test.each([undefined, null, true, { isLoaded: false }, 'unloaded'])('unknown release result %j cannot certify cleanup', async outcome => {
  const owner = createDubbingPlaybackLifetime(); const first = resource();
  first.release.mockResolvedValue(outcome as DubbingReleaseOutcome);
  expect(await owner.retain(first)!.retire()).toBe('native_uncertain'); expect(owner.canAdmit({})).toBe(false);
});

test('cancellation failure still attempts owned release but does not certify admission', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource(); first.cancel.mockImplementation(() => { throw Error('cancel'); });
  expect(await owner.retain(first)!.retire()).toBe('native_uncertain');
  expect(first.release).toHaveBeenCalledTimes(1); expect(owner.canAdmit({})).toBe(false);
});

test('original restoration failure is retryable only through the retained exact resource', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource(); first.release.mockResolvedValueOnce('restoration_failed');
  const lease = owner.retain(first)!; expect(await lease.retire()).toBe('restoration_failed');
  expect(owner.inspect(first.controller).ownsMute).toBe(true); expect(owner.inspect({}).ownsMute).toBe(false);
  expect(owner.retain(resource())).toBeNull(); expect(await lease.retire()).toBe('released');
  expect(first.release).toHaveBeenCalledTimes(2); expect(owner.canAdmit(first.controller)).toBe(true);
});

test('retiring one resource never cancels or owns mute on an unrelated active resource', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource(); const second = resource();
  const firstLease = owner.retain(first)!; const secondLease = owner.retain(second)!;
  first.release.mockResolvedValueOnce('native_uncertain'); await firstLease.retire();
  expect(second.cancel).not.toHaveBeenCalled(); expect(second.release).not.toHaveBeenCalled();
  expect(owner.inspect(second.controller).ownsMute).toBe(false);
  expect(await secondLease.retire()).toBe('released'); expect(owner.canAdmit({})).toBe(false);
});

test('throwing observers cannot drop retained work and unsubscribed observers are not called', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource(); const observer = jest.fn();
  owner.subscribe(() => { throw Error('observer'); }); const unsubscribe = owner.subscribe(observer);
  const initial = owner.getRevision(); await owner.retain(first)!.retire();
  expect(observer).toHaveBeenCalledTimes(2); expect(owner.getRevision()).toBe(initial + 2);
  unsubscribe(); await owner.retain(resource())!.retire(); expect(observer).toHaveBeenCalledTimes(2);
});

test('unreadable mute ownership stays conservative only for its exact controller', async () => {
  const owner = createDubbingPlaybackLifetime(); const first = resource();
  first.release.mockResolvedValueOnce('native_uncertain'); first.ownsMute.mockImplementation(() => { throw Error('ownership'); });
  await owner.retain(first)!.retire();
  expect(owner.inspect(first.controller).ownsMute).toBe(true); expect(owner.inspect({}).ownsMute).toBe(false);
});

test('a synchronous release exception is retained rather than escaping the retirement promise', async () => {
  const owner = createDubbingPlaybackLifetime(); const first: DubbingPlaybackResource = resource();
  first.release = () => { throw Error('release'); };
  expect(await owner.retain(first)!.retire()).toBe('native_uncertain'); expect(owner.canAdmit({})).toBe(false);
});
