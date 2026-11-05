/** Synthetic local-only entry for an isolated full app build. Copy this into the
 * isolated app and temporarily point its main field here. Never ship this entry.
 * No API, authentication, sensors, production data, or message transport is used.
 * Only check names/results are logged; generated private material stays in RAM. */
import React, { useEffect, useState } from 'react';
import { AppState, Linking, Platform, ScrollView, Text } from 'react-native';
import { registerRootComponent } from 'expo';
import { requireNativeModule } from 'expo-modules-core';
import { open } from '@op-engineering/op-sqlite';
import * as mls from 'expo-openmls';

function Fixture() {
  const [status, setStatus] = useState('Running synthetic native app checks…');
  useEffect(() => {
    console.log('PORTAVA_NATIVE_APP_STATE', Platform.OS, AppState.currentState);
    void Linking.getInitialURL().then(url => console.log('PORTAVA_NATIVE_INITIAL_LINK', Platform.OS, url ?? 'none'));
    const subscription = AppState.addEventListener('change', state => console.log('PORTAVA_NATIVE_APP_STATE', Platform.OS, state));
    const links = Linking.addEventListener('url', ({ url }) => console.log('PORTAVA_NATIVE_LINK', Platform.OS, url));
    return () => { subscription.remove(); links.remove(); };
  }, []);
  useEffect(() => {
    let step = 'module-registration';
    const checks: string[] = [];
    let cleanup: (() => void) | undefined;
    const check = (name: string, valid: boolean) => {
      step = name;
      if (!valid) throw new Error('Fixture assertion failed');
      checks.push(name);
    };
    void (async () => {
      for (const name of ['PortavaVideoCompressor', 'PortavaNearbyCheckpoint', 'PortavaOnDeviceSpeech']) {
        check(`registered:${name}`, !!requireNativeModule(name));
      }
      step = 'sqlcipher-jsi-open';
      const name = `portava_runtime_fixture_${Date.now()}.db`;
      const key = (await mls.generateIdentityKeyPair()).privKeyB64;
      let db = open({ name, encryptionKey: key });
      cleanup = () => { try { db.delete(); } catch {} };
      check('sqlcipher-jsi-cipher-version', Object.values(db.executeSync('PRAGMA cipher_version').rows[0] ?? {}).some(v => typeof v === 'string' && v.length > 0));
      db.executeSync('CREATE TABLE fixture (value TEXT NOT NULL)');
      db.executeSync('INSERT INTO fixture VALUES (?)', ['synthetic local value']);
      db.close();
      let refused = false;
      let wrong: ReturnType<typeof open> | undefined;
      try { wrong = open({ name, encryptionKey: 'deliberately-wrong-synthetic-key' }); wrong.executeSync('SELECT * FROM fixture'); }
      catch { refused = true; }
      finally { try { wrong?.close(); } catch {} }
      check('sqlcipher-jsi-wrong-key-refused', refused);
      db = open({ name, encryptionKey: key });
      check('sqlcipher-jsi-reopen', db.executeSync('SELECT value FROM fixture').rows[0]?.value === 'synthetic local value');
      db.delete(); cleanup = undefined;
      step = 'mls-native-group';
      const alice = await mls.generateDeviceKeyPair();
      const bob = await mls.generateDeviceKeyPair();
      const kp = await mls.generateKeyPackage('fixture-bob', bob.ed25519PrivB64, bob.ed25519PubB64);
      const group = await mls.createGroup('fixture-alice', alice.ed25519PrivB64, alice.ed25519PubB64, kp.keyPackageB64);
      const joined = await mls.processWelcome(group.welcomeB64, kp.pendingStateB64);
      check('mls-native-owner', await mls.sessionOwnerId(joined) === 'fixture-bob');
      check('mls-native-safety-agreement', await mls.deriveSafetyNumber(joined) === await mls.deriveSafetyNumber(group.groupStateB64));
      const encrypted = await mls.encryptMessage(group.groupStateB64, 'synthetic Unicode 🌍\u0000 message');
      const received = await mls.decryptMessage(joined, encrypted.ciphertextB64);
      check('mls-native-unicode-roundtrip', received.plaintext === 'synthetic Unicode 🌍\u0000 message');
      let replayRefused = false;
      try { await mls.decryptMessage(received.updatedGroupStateB64, encrypted.ciphertextB64); }
      catch { replayRefused = true; }
      check('mls-native-persisted-replay-refused', replayRefused);
      const reply = await mls.encryptMessage(received.updatedGroupStateB64, 'synthetic reply');
      check('mls-native-bidirectional', (await mls.decryptMessage(encrypted.updatedGroupStateB64, reply.ciphertextB64)).plaintext === 'synthetic reply');
      if (Platform.OS === 'ios') {
        step = 'scene-native-url-roundtrip';
        const url = 'travelbuddy://native-runtime-fixture';
        let timer: ReturnType<typeof setTimeout> | undefined;
        let remove: (() => void) | undefined;
        try {
          const delivered = new Promise<boolean>((resolve) => {
            const listener = Linking.addEventListener('url', event => { if (event.url === url) resolve(true); });
            remove = () => listener.remove();
            timer = setTimeout(() => resolve(false), 8000);
          });
          await Linking.openURL(url);
          check(step, await delivered);
        } finally { if (timer) clearTimeout(timer); remove?.(); }
      }
      const result = { platform: Platform.OS, passed: true, count: checks.length, checks, synthetic: true };
      console.log('PORTAVA_NATIVE_APP_PROOF', JSON.stringify(result));
      setStatus(JSON.stringify(result, null, 2));
    })().catch(error => {
      const result = { platform: Platform.OS, passed: false, failedStep: step, errorType: error?.name ?? 'Error', checks, synthetic: true };
      console.log('PORTAVA_NATIVE_APP_PROOF', JSON.stringify(result));
      setStatus(JSON.stringify(result, null, 2));
    }).finally(() => cleanup?.());
  }, []);
  return <ScrollView contentContainerStyle={{ padding: 32, paddingTop: 64, backgroundColor: '#fff' }}><Text style={{ color: '#111', fontSize: 17 }}>{status}</Text></ScrollView>;
}
registerRootComponent(Fixture);
