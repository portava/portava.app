// NOTE: intentionally exhaustive: only the token lookup crosses the native auth bridge.
jest.mock('../../../../services/apiToken.ts', () => ({ freshToken: jest.fn() }));
// NOTE: intentionally exhaustive: this file exercises the transport, not native auth subscriptions.
jest.mock('../../../../services/auth.ts', () => ({ onAuthChange: jest.fn(() => () => {}), getSessionUserId: jest.fn() }));
import AsyncStorage from '@react-native-async-storage/async-storage';
import { freshToken } from '../../../../services/apiToken.ts';
import { setDiscoveryViewerFromSession } from '../../../../services/discoveryViewerScope.ts';
import { readOutcomeConsent, writeOutcomeConsent, postTaskOutcome } from '../outcomeLearningTransport.ts';
import { applyOutcomeConsent, beginOutcomeAccount, clearOutcomeWithdrawal, holdOutcomeWithdrawal,
  outcomeLearningConsented, hasOutcomeWithdrawalHold, reportInputTaskOutcome, OUTCOME_DISCLOSURE_VERSION } from '../outcomeLearning.ts';
const owner = '10000000-0000-4000-8000-000000000029';
const at = '2026-11-13T12:00:00.000Z';
const state = {available:true,enabled:true,consentVersion:OUTCOME_DISCLOSURE_VERSION,consentedAt:at,withdrawnAt:null,currentDisclosureVersion:OUTCOME_DISCLOSURE_VERSION,retentionDays:30};
const token = `header.${Buffer.from(JSON.stringify({sub:owner})).toString('base64url')}.signature`;
const realFetch = global.fetch, realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
beforeEach(async () => {
  jest.clearAllMocks(); await AsyncStorage.clear(); clearOutcomeWithdrawal(owner);
  beginOutcomeAccount(owner); setDiscoveryViewerFromSession(owner);
  applyOutcomeConsent(owner,true,at);
  process.env.EXPO_PUBLIC_API_BASE_URL='https://example.test';
  (freshToken as jest.Mock).mockResolvedValue(token);
  global.fetch=jest.fn().mockResolvedValue({ok:true,status:200,json:async()=>state});
});
afterEach(() => { beginOutcomeAccount(null); clearOutcomeWithdrawal(owner); global.fetch=realFetch;
  if (realBase===undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL=realBase; });

test('delayed token resolution after withdrawal sends no outcome bytes', async () => {
  let resolve!: (value:string)=>void;
  (freshToken as jest.Mock).mockImplementation(()=>new Promise(r=>{resolve=r;}));
  let posted!: Promise<boolean>;
  reportInputTaskOutcome({fieldId:'trip.destination',context:'trip_destination'},'trip_created',true,[{entityType:'city',entityId:'city-1'}],
    {post:body=>{posted=postTaskOutcome(body);return posted;}});
  await flush(); holdOutcomeWithdrawal(owner); resolve(token);
  expect(await posted).toBe(false); expect(global.fetch).not.toHaveBeenCalled();
});

test('a newer token cannot carry an older account outcome while auth listeners catch up', async () => {
  const other='10000000-0000-4000-8000-000000000099';
  setDiscoveryViewerFromSession(other); // the outcome gate still belongs to owner
  (freshToken as jest.Mock).mockResolvedValue(`header.${Buffer.from(JSON.stringify({sub:other})).toString('base64url')}.signature`);
  let posted!: Promise<boolean>;
  reportInputTaskOutcome({fieldId:'trip.destination',context:'trip_destination'},'trip_created',true,[{entityType:'city',entityId:'city-1'}],
    {post:body=>{posted=postTaskOutcome(body);return posted;}});
  expect(await posted).toBe(false); expect(global.fetch).not.toHaveBeenCalled();
  expect(await writeOutcomeConsent(false)).toEqual({status:'failed'});
  expect(global.fetch).not.toHaveBeenCalled();
});

test('a restored local withdrawal survives a new session and an older server grant', async () => {
  await AsyncStorage.setItem(`input-outcome:withdrawal:${owner}`,'1');
  beginOutcomeAccount(owner);
  const read=await readOutcomeConsent();
  expect(read.status).toBe('ok');
  applyOutcomeConsent(owner,true,at);
  expect(outcomeLearningConsented()).toBe(false);
});

test('failed withdrawal is durable, sends only intent, and remains closed', async () => {
  (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
  expect(await writeOutcomeConsent(false)).toEqual({status:'failed'});
  expect(await AsyncStorage.getItem(`input-outcome:withdrawal:${owner}`)).toBe('1');
  expect(outcomeLearningConsented()).toBe(false);
  expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({enabled:false});
});

test('local storage failure cannot prevent a server withdrawal attempt', async () => {
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('storage unavailable'));
  (global.fetch as jest.Mock).mockResolvedValue({ok:true,status:200,json:async()=>({...state,enabled:false,withdrawnAt:at,countersErased:true})});
  const result=await writeOutcomeConsent(false);
  expect(result.status).toBe('ok');
  expect(outcomeLearningConsented()).toBe(false);
  expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toEqual({enabled:false});
});

test('only an acknowledged explicit current grant clears a withdrawal hold', async () => {
  await AsyncStorage.setItem(`input-outcome:withdrawal:${owner}`,'1'); holdOutcomeWithdrawal(owner);
  const result=await writeOutcomeConsent(true);
  expect(result.status).toBe('ok');
  expect(await AsyncStorage.getItem(`input-outcome:withdrawal:${owner}`)).toBeNull();
  applyOutcomeConsent(owner,true,at); expect(outcomeLearningConsented()).toBe(true);
});

test('read and write replies from a previous account cannot become current consent', async () => {
  let reply!: (value:unknown)=>void;
  (global.fetch as jest.Mock).mockImplementation(()=>new Promise(resolve=>{reply=resolve;}));
  const pending=writeOutcomeConsent(true); await flush();
  beginOutcomeAccount('other'); setDiscoveryViewerFromSession('other');
  reply({ok:true,status:200,json:async()=>state});
  expect(await pending).toEqual({status:'failed'});
  expect(outcomeLearningConsented()).toBe(false);
});


test('an old grant cannot erase a later failed withdrawal while native storage removal is pending', async () => {
  const key = `input-outcome:withdrawal:${owner}`;
  await AsyncStorage.setItem(key, '1'); holdOutcomeWithdrawal(owner);
  const remove = jest.mocked(AsyncStorage.removeItem).getMockImplementation()!;
  let finishRemove!: () => void;
  jest.mocked(AsyncStorage.removeItem).mockImplementationOnce(key => new Promise<void>(resolve => {
    finishRemove = () => { void remove(key).then(resolve); };
  }));
  const grant = writeOutcomeConsent(true);
  await flush();
  expect(finishRemove).toBeDefined();
  (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('offline withdrawal'));
  const withdrawal = writeOutcomeConsent(false);
  expect(hasOutcomeWithdrawalHold(owner)).toBe(true);
  finishRemove();
  expect(await grant).toEqual({status:'failed'});
  expect(await withdrawal).toEqual({status:'failed'});
  expect(await AsyncStorage.getItem(key)).toBe('1');
  expect(hasOutcomeWithdrawalHold(owner)).toBe(true);
  clearOutcomeWithdrawal(owner); beginOutcomeAccount(owner); // a fresh process's empty gate/hold
  (global.fetch as jest.Mock).mockResolvedValue({ok:true,status:200,json:async()=>state});
  expect((await readOutcomeConsent()).status).toBe('ok');
  applyOutcomeConsent(owner,true,at);
  expect(outcomeLearningConsented()).toBe(false);
});

test('a superseded grant response cannot clear a later withdrawal and network writes preserve order', async () => {
  let reply!: (value:unknown)=>void;
  (global.fetch as jest.Mock).mockImplementationOnce(()=>new Promise(resolve=>{reply=resolve;}))
    .mockResolvedValueOnce({ok:true,status:200,json:async()=>({...state,enabled:false,withdrawnAt:at,countersErased:true})});
  holdOutcomeWithdrawal(owner);
  const grant = writeOutcomeConsent(true); await flush();
  const withdrawal = writeOutcomeConsent(false); await flush();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  reply({ok:true,status:200,json:async()=>state});
  expect(await grant).toEqual({status:'failed'});
  expect((await withdrawal).status).toBe('ok');
  expect((global.fetch as jest.Mock).mock.calls.map(call=>JSON.parse(call[1].body).enabled)).toEqual([true,false]);
  expect(hasOutcomeWithdrawalHold(owner)).toBe(true);
  expect(await AsyncStorage.getItem(`input-outcome:withdrawal:${owner}`)).toBe('1');
});

test.each([
  state,
  {...state,enabled:false,withdrawnAt:null},
])('a withdrawal cannot accept an enabled or unacknowledged receipt', async receipt => {
  (global.fetch as jest.Mock).mockResolvedValue({ok:true,status:200,json:async()=>receipt});
  expect(await writeOutcomeConsent(false)).toEqual({status:'failed'});
  expect(hasOutcomeWithdrawalHold(owner)).toBe(true);
  expect(outcomeLearningConsented()).toBe(false);
});

test('missing erasure evidence stays unknown even when the withdrawal itself is acknowledged', async () => {
  (global.fetch as jest.Mock).mockResolvedValue({ok:true,status:200,json:async()=>({...state,enabled:false,withdrawnAt:at})});
  const result = await writeOutcomeConsent(false);
  expect(result).toMatchObject({status:'ok',countersErased:null});
  expect(hasOutcomeWithdrawalHold(owner)).toBe(true);
});
