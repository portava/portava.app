import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import * as telemetry from '../mapTelemetry.ts';
import type { MapTelemetryBatch, FetchTelemetryTransportOptions } from '../mapTelemetry.ts';

const screenPath = new NodeURL('../../../../../app/map/index.tsx', import.meta.url);
const screenSource = readFileSync(screenPath, 'utf8');
const screenAst = ts.createSourceFile(screenPath.pathname, screenSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects: string[] = [];
function findTelemetryEffect(node: ts.Node): void {
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(screenAst) === 'useEffect'
    && node.getText(screenAst).includes("emitMapEvent('map_opened'")) {
    effects.push(node.getText(screenAst));
  }
  ts.forEachChild(node, findTelemetryEffect);
}
findTelemetryEffect(screenAst);
assert.equal(effects.length, 1, 'execute the single real screen telemetry effect');
const effectCode = ts.transpileModule(effects[0]!, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function accessToken(owner: string, version = ''): string {
  return `header.${Buffer.from(JSON.stringify({ sub: owner, version })).toString('base64url')}.signature`;
}

function harness(initialOwner = 'account-A', notifyInitialOwner = true) {
  let owner: string | null = initialOwner;
  const listeners = new Set<(userId: string | null) => void>();
  const appStateListeners = new Set<(state: string) => void>();
  const requests: Array<{ token: string; batch: MapTelemetryBatch }> = [];
  let getToken = async (): Promise<string | null> => owner ? accessToken(owner) : null;
  let send = async (_batch: MapTelemetryBatch): Promise<void> => {};
  const onAuthChange = (listener: (userId: string | null) => void) => {
    listeners.add(listener);
    if (notifyInitialOwner) listener(owner);
    return () => { listeners.delete(listener); };
  };
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const batch = JSON.parse(String(init.body)) as MapTelemetryBatch;
    const token = (init.headers as Record<string, string>).Authorization;
    requests.push({ token, batch });
    await send(batch);
    return { ok: true, status: 200 };
  }) as typeof fetch;
  return {
    requests,
    listeners,
    appStateListeners,
    bindings() {
      return {
        ...telemetry,
        createFetchTelemetryTransport: (options: FetchTelemetryTransportOptions) =>
          telemetry.createFetchTelemetryTransport({ ...options, fetchImpl }),
        freshToken: () => getToken(),
        onAuthChange,
        process: { env: { EXPO_PUBLIC_API_BASE_URL: 'https://telemetry.invalid' } },
        entryPoint: 'tab',
        machine: { mode: 'LIVE' },
        cameraZoom: 14,
        paramZoom: 14,
        entityTypes: [],
        setTelemetryOwner: () => {},
        AppState: {
          addEventListener(_event: string, listener: (state: string) => void) {
            appStateListeners.add(listener);
            return { remove() { appStateListeners.delete(listener); } };
          },
        },
      };
    },
    tokenLookup(lookup: typeof getToken) { getToken = lookup; },
    delivery(deliver: typeof send) { send = deliver; },
    changeOwner(userId: string | null) {
      owner = userId;
      for (const listener of listeners) listener(userId);
    },
    screen() {
      let dependencies: unknown[] | undefined;
      let cleanup: (() => void) | void;
      let telemetryOwner: ReturnType<typeof telemetry.captureMapTelemetryOwner> = null;
      return {
        get telemetryOwner() { return telemetryOwner; },
        render(renderedOwner = owner) {
          const bindings = {
            ...telemetry,
            createFetchTelemetryTransport: (options: FetchTelemetryTransportOptions) =>
              telemetry.createFetchTelemetryTransport({ ...options, fetchImpl }),
            freshToken: () => getToken(),
            onAuthChange,
            userId: renderedOwner,
            setTelemetryOwner: (owner: typeof telemetryOwner) => { telemetryOwner = owner; },
            process: { env: { EXPO_PUBLIC_API_BASE_URL: 'https://telemetry.invalid' } },
            entryPoint: 'tab',
            machine: { mode: 'LIVE' },
            cameraZoom: 14,
            paramZoom: 14,
            entityTypes: [],
            AppState: {
              addEventListener(_event: string, listener: (state: string) => void) {
                appStateListeners.add(listener);
                return { remove() { appStateListeners.delete(listener); } };
              },
            },
            useEffect(effect: () => (() => void) | void, nextDependencies: unknown[]) {
              if (dependencies && dependencies.length === nextDependencies.length
                && dependencies.every((value, index) => Object.is(value, nextDependencies[index]))) return;
              cleanup?.();
              dependencies = nextDependencies;
              cleanup = effect();
            },
          };
          new Function(...Object.keys(bindings), effectCode)(...Object.values(bindings));
        },
        unmount() { cleanup?.(); cleanup = undefined; dependencies = undefined; },
      };
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  telemetry._resetMapTelemetryForTests();
  let id = 0;
  telemetry.configureMapTelemetry({
    batchSize: 1000,
    scheduler: { setTimeout: () => 1, clearTimeout: () => {} },
    newId: (prefix) => `${prefix}-${++id}`,
  });
});
afterEach(() => telemetry._resetMapTelemetryForTests());

describe('mapTelemetry — real screen owner lifecycle effect', () => {
  it('rebinds a mounted screen after a coalesced same-ID logout/login', async () => {
    const auth = harness();
    const bindings = { ...auth.bindings(), useEffect: React.useEffect };
    const Screen = new Function(...Object.keys(bindings),
      `return function Screen({ userId }) { ${effectCode}; return null; };`,
    )(...Object.values(bindings)) as React.ComponentType<{ userId: string | null }>;
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    let root: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => { root = TestRenderer.create(React.createElement(Screen, { userId: 'account-A' })); });
      await telemetry.flushMapTelemetry();
      const oldSession = telemetry.currentMapSessionId();
      const oldBackgroundCallback = [...auth.appStateListeners][0]!;
      await act(async () => {
        auth.changeOwner(null);
        root!.update(React.createElement(Screen, { userId: null }));
        auth.changeOwner('account-A');
        root!.update(React.createElement(Screen, { userId: 'account-A' }));
      });
      assert.equal(telemetry.mapTelemetryDiagnostics().hasTransport, true);
      assert.notEqual(telemetry.currentMapSessionId(), oldSession);
      assert.equal(auth.appStateListeners.size, 1);
      const before = telemetry.mapTelemetryDiagnostics();
      oldBackgroundCallback('background');
      assert.deepEqual(telemetry.mapTelemetryDiagnostics(), before);
      telemetry.emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
      [...auth.appStateListeners][0]!('background');
      await settle();
      assert.deepEqual(auth.requests.at(-1)?.batch.events.map((event) => event.name), ['map_opened', 'compass_requested']);
      assert.equal(telemetry.mapTelemetryDiagnostics().queueDepth, 0);
    } finally {
      if (root) await act(async () => root!.unmount());
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  it('discards A failed unmount retries before B sends, including A drop/session state', async () => {
    const auth = harness();
    auth.delivery(async () => { throw new Error('offline'); });
    const first = auth.screen();
    first.render();
    const firstSession = telemetry.currentMapSessionId();
    telemetry.emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    telemetry.configureMapTelemetry({ maxQueueSize: 3 });
    for (let round = 1; round <= 3; round += 1) {
      telemetry.emitMapEvent('alternative_requested', { reason: 'unspecified', round });
    }
    first.unmount();
    await settle();
    assert.equal(telemetry.mapTelemetryDiagnostics().queueDepth, 3);
    auth.changeOwner('account-B');
    const second = auth.screen();
    auth.delivery(async () => {});
    second.render();
    await telemetry.flushMapTelemetry();
    const sent = auth.requests.filter((request) => request.token === `Bearer ${accessToken('account-B')}`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.batch.events.length, 1);
    assert.notEqual(sent[0]?.batch.events[0]?.mapSessionId, firstSession);
    assert.equal(sent[0]?.batch.meta.droppedTotal, 0);
    assert.equal(sent[0]?.batch.meta.dropped, 0);
    assert.equal(telemetry.currentDecisionId(), null);
    assert.equal(telemetry.containsDisallowedKey(sent[0]?.batch), false);
    second.unmount();
  });

  it('ignores an old failure while B is in flight without unlocking B or requeueing A', async () => {
    const auth = harness();
    const oldDelivery = deferred<void>();
    auth.delivery(() => oldDelivery.promise);
    const screen = auth.screen();
    screen.render();
    const oldFlush = telemetry.flushMapTelemetry();
    await settle();
    auth.changeOwner('account-B');
    const newDelivery = deferred<void>();
    auth.delivery(() => newDelivery.promise);
    screen.render();
    const newFlush = telemetry.flushMapTelemetry();
    await settle();
    assert.equal(auth.requests.length, 2, 'B must not wait on abandoned A');
    const before = telemetry.mapTelemetryDiagnostics();
    oldDelivery.reject(new Error('late A failure'));
    await oldFlush;
    assert.deepEqual(telemetry.mapTelemetryDiagnostics(), before);
    telemetry.emitMapEvent('map_opened', {
      entry: 'tab', mode: 'LIVE', hasTripContext: false, hasCrewContext: false,
    });
    void telemetry.flushMapTelemetry();
    await settle();
    assert.equal(auth.requests.length, 2, 'A completion must not unlock B delivery');
    newDelivery.resolve();
    await newFlush;
    await settle();
    assert.equal(auth.requests.length, 3);
    assert.equal(auth.requests[2]?.token, `Bearer ${accessToken('account-B')}`);
    screen.unmount();
  });

  it('does not send an old batch when delayed token lookup resolves after an account switch', async () => {
    const auth = harness();
    const token = deferred<string | null>();
    auth.tokenLookup(() => token.promise);
    const first = auth.screen();
    first.render();
    const firstSession = telemetry.currentMapSessionId();
    const oldFlush = telemetry.flushMapTelemetry();
    first.unmount();
    auth.changeOwner('account-B');
    auth.tokenLookup(async () => accessToken('account-B'));
    const second = auth.screen();
    second.render();
    await telemetry.flushMapTelemetry();
    token.resolve(accessToken('account-B'));
    await oldFlush;
    await settle();
    assert.equal(auth.requests.length, 1);
    assert.equal(auth.requests[0]?.token, `Bearer ${accessToken('account-B')}`);
    assert.equal(auth.requests[0]?.batch.events.length, 1);
    assert.notEqual(auth.requests[0]?.batch.events[0]?.mapSessionId, firstSession);
    second.unmount();
  });

  it('ignores an old success without subtracting A reported drops from B counters', async () => {
    const auth = harness();
    telemetry.configureMapTelemetry({ maxQueueSize: 1 });
    const screen = auth.screen();
    screen.render();
    telemetry.emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    const oldDelivery = deferred<void>();
    auth.delivery(() => oldDelivery.promise);
    const oldFlush = telemetry.flushMapTelemetry();
    await settle();
    assert.equal(auth.requests[0]?.batch.meta.dropped, 1);
    auth.changeOwner('account-B');
    screen.render();
    telemetry.emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    telemetry.emitMapEvent('alternative_requested', { reason: 'unspecified', round: 1 });
    const before = telemetry.mapTelemetryDiagnostics();
    assert.equal(before.droppedPending, 2);
    oldDelivery.resolve();
    await oldFlush;
    assert.deepEqual(telemetry.mapTelemetryDiagnostics(), before);
    auth.delivery(async () => {});
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.at(-1)?.batch.meta.dropped, 2);
    assert.equal(auth.requests.at(-1)?.batch.meta.droppedTotal, 2);
    screen.unmount();
  });

  it('invalidates the old epoch even when A returns after an offscreen B switch', async () => {
    const auth = harness();
    const token = deferred<string | null>();
    auth.tokenLookup(() => token.promise);
    const first = auth.screen();
    first.render();
    const oldSession = telemetry.currentMapSessionId();
    const oldFlush = telemetry.flushMapTelemetry();
    first.unmount();
    auth.changeOwner('account-B');
    auth.changeOwner('account-A');
    auth.tokenLookup(async () => accessToken('account-A'));
    const second = auth.screen();
    second.render();
    await telemetry.flushMapTelemetry();
    token.resolve(accessToken('account-A'));
    await oldFlush;
    await settle();
    assert.equal(auth.requests.length, 1);
    assert.equal(auth.requests[0]?.batch.events.length, 1);
    assert.notEqual(auth.requests[0]?.batch.events[0]?.mapSessionId, oldSession);
    second.unmount();
  });

  it('clears state immediately on sign-out and does not collect signed-out events', async () => {
    const auth = harness();
    const screen = auth.screen();
    screen.render();
    telemetry.emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    const oldBackgroundCallback = [...auth.appStateListeners][0]!;
    auth.changeOwner(null);
    assert.equal(telemetry.currentMapSessionId(), null);
    assert.equal(telemetry.currentDecisionId(), null);
    assert.equal(telemetry.mapTelemetryDiagnostics().queueDepth, 0);
    assert.equal(telemetry.mapTelemetryDiagnostics().hasTransport, false);
    assert.equal(telemetry.mapTelemetryDiagnostics().timerScheduled, false);
    telemetry.emitMapEvent('compass_requested', { trigger: 'action_rail', mode: 'LIVE' });
    assert.equal(telemetry.mapTelemetryDiagnostics().queueDepth, 0);
    screen.render();
    assert.equal(auth.appStateListeners.size, 0);
    auth.changeOwner('account-B');
    screen.render();
    const before = telemetry.mapTelemetryDiagnostics();
    oldBackgroundCallback('background');
    assert.deepEqual(telemetry.mapTelemetryDiagnostics(), before);
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.length, 1);
    assert.equal(auth.requests[0]?.token, `Bearer ${accessToken('account-B')}`);
    screen.unmount();
  });

  it('does not let a stale screen owner or cleanup replace a newer authenticated session', async () => {
    const auth = harness();
    const first = auth.screen();
    first.render();
    auth.changeOwner('account-B');
    const stale = auth.screen();
    stale.render('account-A');
    assert.equal(telemetry.mapTelemetryDiagnostics().hasTransport, false);
    assert.equal(telemetry.mapTelemetryDiagnostics().queueDepth, 0);
    const second = auth.screen();
    second.render();
    const before = telemetry.mapTelemetryDiagnostics();
    first.unmount();
    stale.unmount();
    assert.deepEqual(telemetry.mapTelemetryDiagnostics(), before);
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.length, 1);
    assert.equal(auth.requests[0]?.token, `Bearer ${accessToken('account-B')}`);
    second.unmount();
  });

  it('does not invalidate an in-flight token lookup on a same-owner refresh', async () => {
    const auth = harness();
    const token = deferred<string | null>();
    auth.tokenLookup(() => token.promise);
    const screen = auth.screen();
    screen.render();
    const session = telemetry.currentMapSessionId();
    const pending = telemetry.flushMapTelemetry();
    auth.changeOwner('account-A');
    screen.render();
    token.resolve(accessToken('account-A', 'refreshed'));
    await pending;
    assert.equal(auth.requests.length, 1);
    assert.equal(auth.requests[0]?.token, `Bearer ${accessToken('account-A', 'refreshed')}`);
    assert.equal(auth.requests[0]?.batch.events[0]?.mapSessionId, session);
    screen.unmount();
  });

  it('accepts the session context owner while the initial auth notification is still pending', async () => {
    const auth = harness('account-A', false);
    const screen = auth.screen();
    screen.render(null);
    screen.render('account-A');
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.length, 1);
    assert.equal(auth.requests[0]?.token, `Bearer ${accessToken('account-A')}`);
    const session = telemetry.currentMapSessionId();
    auth.changeOwner('account-A');
    assert.equal(telemetry.currentMapSessionId(), session);
    screen.unmount();
  });

  it('rejects a different token subject before a delayed initial auth notification', async () => {
    const auth = harness('account-B', false);
    const screen = auth.screen();
    screen.render('account-A');
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.length, 0, 'a stale React owner must not borrow the current token');
    assert.equal(telemetry.mapTelemetryDiagnostics().queueDepth, 1);
    auth.changeOwner('account-B');
    screen.render();
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.length, 1);
    assert.equal(auth.requests[0]?.batch.events.length, 1);
    screen.unmount();
  });

  it('fails closed on an unreadable token owner without sending or changing the wire schema', async () => {
    const auth = harness();
    auth.tokenLookup(async () => 'not-a-jwt');
    const screen = auth.screen();
    screen.render();
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.length, 0);
    auth.tokenLookup(async () => accessToken('account-A'));
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.length, 1);
    assert.deepEqual(Object.keys(auth.requests[0]!.batch).sort(), ['events', 'meta']);
    assert.deepEqual(Object.keys(auth.requests[0]!.batch.meta).sort(),
      ['dropped', 'droppedByReason', 'droppedTotal', 'mapSessionId', 'queueDepth', 'schemaVersion']);
    assert.equal(JSON.stringify(auth.requests[0]!.batch).includes('account-A'), false);
    screen.unmount();
  });

  it('keeps same-account retries across unmount/remount and repeated auth notifications', async () => {
    const auth = harness();
    auth.delivery(async () => { throw new Error('offline'); });
    const first = auth.screen();
    first.render();
    const firstSession = telemetry.currentMapSessionId();
    first.unmount();
    await settle();
    auth.changeOwner('account-A');
    auth.delivery(async () => {});
    const second = auth.screen();
    second.render();
    await telemetry.flushMapTelemetry();
    assert.equal(auth.requests.at(-1)?.batch.events.length, 2);
    assert.equal(auth.requests.at(-1)?.batch.events[0]?.mapSessionId, firstSession);
    assert.notEqual(auth.requests.at(-1)?.batch.events[1]?.mapSessionId, firstSession);
    assert.equal(auth.listeners.size, 1);
    second.unmount();
    assert.equal(auth.appStateListeners.size, 0);
    assert.equal(auth.listeners.size, 1, 'retry isolation must continue while Map is unmounted');
  });
});

function screenOperation(expression: string, bindings: Record<string, unknown>): (...args: any[]) => Promise<void> {
  const code = ts.transpileModule(expression, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return operation;`)(...Object.values(bindings));
}

function producerExpression(name: 'joinMapObject' | 'startLocateFriends'): string {
  let expression: string | undefined;
  function find(node: ts.Node): void {
    if (name === 'joinMapObject' && ts.isFunctionDeclaration(node) && node.name?.text === name) {
      const rawId = screenAst.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'rawObjectId');
      expression = `${rawId!.getText(screenAst)}\n${node.getText(screenAst)}\nconst operation = joinMapObject;`;
    }
    if (name === 'startLocateFriends' && ts.isVariableDeclaration(node) && node.name.getText(screenAst) === name
      && node.initializer && ts.isCallExpression(node.initializer)) {
      expression = `const operation = ${node.initializer.arguments[0]!.getText(screenAst)};`;
    }
    ts.forEachChild(node, find);
  }
  find(screenAst);
  assert.ok(expression, `execute the real ${name} producer`);
  return expression;
}

describe('mapTelemetry — asynchronous screen producers', () => {
  for (const [outcome, response, expectedTitle] of [
    ['confirmed', { ok: true, data: { status: 'confirmed' } }, "You're going!"],
    ['waitlisted', { ok: true, data: { status: 'waitlisted', position: 9 } }, "You're on the waitlist"],
    ['error', { ok: false, message: 'account-A private failure' }, 'Could not RSVP'],
  ] as const) {
    for (const transition of ['different-owner', 'logout-login', 'refresh'] as const) {
      it(`RSVP ${outcome} alert belongs only to its initiating epoch after ${transition}`, async () => {
        const auth = harness();
        const screen = auth.screen();
        screen.render();
        const pending = deferred<unknown>();
        const alerts: unknown[][] = [];
        const requests: unknown[][] = [];
        const operation = screenOperation(producerExpression('joinMapObject'), {
          ...telemetry,
          rsvpEvent: (...args: unknown[]) => { requests.push(args); return pending.promise; },
          Alert: { alert: (...args: unknown[]) => { alerts.push(args); } },
        });
        const completion = operation({ id: 'event:account-A-event', kind: 'event', privacyClass: 'place_level', geometry: null }, 'map');
        if (transition === 'different-owner') auth.changeOwner('account-B');
        if (transition === 'logout-login') { auth.changeOwner(null); auth.changeOwner('account-A'); }
        if (transition === 'refresh') auth.changeOwner('account-A');
        screen.render();
        pending.resolve(response);
        await completion;
        assert.deepEqual(requests, [['account-A-event', 'going']]);
        assert.equal(alerts.length, transition === 'refresh' ? 1 : 0);
        if (transition === 'refresh') {
          assert.equal(alerts[0]?.[0], expectedTitle);
          if (outcome === 'waitlisted') assert.match(String(alerts[0]?.[1]), /#9/);
          if (outcome === 'error') assert.equal(alerts[0]?.[1], 'account-A private failure');
        }
        screen.unmount();
      });
    }
  }

  for (const producer of ['joinMapObject', 'startLocateFriends'] as const) {
    for (const transition of ['different-owner', 'logout-login', 'refresh'] as const) {
      it(`${producer} fences ${transition} completion without losing same-owner success`, async () => {
        const auth = harness();
        const screen = auth.screen();
        screen.render();
        const pending = deferred<unknown>();
        const operation = screenOperation(producerExpression(producer), {
          ...telemetry,
          rsvpEvent: () => pending.promise,
          startLocateFriendsSession: () => pending.promise,
          Alert: { alert() {} },
          isTtlWithinBound: () => true,
          locateEpoch: { current: 0 },
          setLocateStarting: () => {},
          setLocateSessionId: () => {},
          machine: { mode: 'LIVE' },
        });
        const completion = producer === 'joinMapObject'
          ? operation({ id: 'event:account-A-event', kind: 'event', privacyClass: 'place_level', geometry: null }, 'map')
          : operation({ kind: 'trip', id: 'account-A-trip' }, 120);
        if (transition === 'different-owner') auth.changeOwner('account-B');
        if (transition === 'logout-login') { auth.changeOwner(null); screen.render(); auth.changeOwner('account-A'); }
        if (transition === 'refresh') auth.changeOwner('account-A');
        screen.render();
        assert.equal(telemetry.mapTelemetryDiagnostics().hasTransport, true);
        pending.resolve({ ok: true, data: { status: 'confirmed', session: { id: 'account-A-locate' }, requestedClass: 'approximate' } });
        await completion;
        await telemetry.flushMapTelemetry();
        const name = producer === 'joinMapObject' ? 'plan_joined' : 'crew_locate_started';
        const events = auth.requests.flatMap((request) => request.batch.events).filter((event) => event.name === name);
        assert.equal(events.length, transition === 'refresh' ? 1 : 0);
        screen.unmount();
      });
    }
  }

  for (const [component, attribute, eventName, payload] of [
    ['MapContributionSheet', 'onSubmit', 'contribution_submitted', { kind: 'photo' }],
    ['MeetHereSheet', 'onCreated', 'meet_here_created', { audience: 'trip', inviteeCount: 2, sharedAs: 'place_level' }],
    ['MeetHereSheet', 'onRefused', 'meet_here_refused', { reason: 'aggregate', surface: 'action_rail' }],
  ] as const) {
    for (const transition of ['different-owner', 'logout-login', 'refresh'] as const) {
      it(`${component}.${attribute} fences a captured callback after ${transition}`, async () => {
        const auth = harness();
        const screen = auth.screen();
        screen.render();
        let expression: string | undefined;
        function find(node: ts.Node): void {
          if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(screenAst) === component) {
            const prop = node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.getText(screenAst) === attribute);
            if (prop && ts.isJsxAttribute(prop) && prop.initializer && ts.isJsxExpression(prop.initializer)) {
              expression = prop.initializer.expression?.getText(screenAst);
            }
          }
          ts.forEachChild(node, find);
        }
        find(screenAst);
        assert.ok(expression);
        const object = { id: 'place:account-A-place', kind: 'place', privacyClass: 'place_level', geometry: null };
        const callback = screenOperation(`const operation = ${expression};`, {
          ...telemetry,
          telemetryOwner: screen.telemetryOwner,
          contributeObject: object,
          arrivalPromptId: null,
          meetTarget: { kind: 'object', object },
        });
        if (transition === 'different-owner') auth.changeOwner('account-B');
        if (transition === 'logout-login') { auth.changeOwner(null); screen.render(); auth.changeOwner('account-A'); }
        if (transition === 'refresh') auth.changeOwner('account-A');
        screen.render();
        assert.equal(telemetry.mapTelemetryDiagnostics().hasTransport, true);
        await callback(payload);
        await telemetry.flushMapTelemetry();
        const events = auth.requests.flatMap((request) => request.batch.events).filter((event) => event.name === eventName);
        assert.equal(events.length, transition === 'refresh' ? 1 : 0);
        screen.unmount();
      });
    }
  }
});
