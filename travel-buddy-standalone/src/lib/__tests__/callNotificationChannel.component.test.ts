/**
 * The incoming-call Android channel is MAX importance in expo-notifications'
 * own enum, on an id existing installs have not already fixed at DEFAULT.
 *
 * The defect: `app/_layout.tsx` registered `incoming_calls` with the literal
 * `importance: 5`, commented "AndroidImportance.MAX". In expo's enum 5 is
 * DEFAULT (MAX is 7), so calls were not heads-up on Android 8+, and because
 * Android fixes a channel's importance at creation, raising it under the same
 * id would have changed nothing on any install that had already run the app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AndroidImportance } from 'expo-notifications/build/NotificationChannelManager.types';
import {
  CALL_CHANNEL,
  CALL_CHANNEL_ID,
  LEGACY_CALL_CHANNEL_IDS,
  registerCallNotificationChannel,
} from '../callNotificationChannel.ts';

describe('the incoming-call channel', () => {
  it('is MAX importance in the INSTALLED enum (7), not the literal 5 that is expo DEFAULT', () => {
    expect(AndroidImportance.MAX).toBe(7);
    expect(AndroidImportance.DEFAULT).toBe(5);
    expect(CALL_CHANNEL.importance).toBe(AndroidImportance.MAX);
    expect(CALL_CHANNEL.sound).toBe(true);
    expect(CALL_CHANNEL.bypassDnd).toBe(false);
  });

  it('uses a NEW id, because Android never raises the importance of a channel that already exists', () => {
    expect(LEGACY_CALL_CHANNEL_IDS).toEqual(['incoming_calls']);
    expect(LEGACY_CALL_CHANNEL_IDS).not.toContain(CALL_CHANNEL_ID);
  });

  it('start-up deletes the legacy channel BEFORE creating the new one at MAX', async () => {
    const order: string[] = [];
    const created: Array<[string, { importance: number }]> = [];
    await registerCallNotificationChannel({
      remove: async (id) => { order.push(`remove:${id}`); },
      create: async (id, options) => { order.push(`create:${id}`); created.push([id, options]); },
    });
    expect(order).toEqual(['remove:incoming_calls', `create:${CALL_CHANNEL_ID}`]);
    expect(created[0]![1].importance).toBe(AndroidImportance.MAX);
  });

  it("the server's call.incoming push names this channel and never the legacy id", () => {
    const router = readFileSync(join(__dirname, '../../../../artifacts/api-server/src/services/notifications/NotificationRouter.ts'), 'utf8');
    expect(router).toContain(`"call.incoming" ? "${CALL_CHANNEL_ID}"`);
    for (const legacy of LEGACY_CALL_CHANNEL_IDS) expect(router).not.toContain(`? "${legacy}"`);
  });

  it('the root layout registers the channel through this module, with no literal importance left', () => {
    const layout = readFileSync(join(__dirname, '../../../app/_layout.tsx'), 'utf8');
    expect(layout).toContain('registerCallNotificationChannel()');
    expect(layout).not.toMatch(/setNotificationChannelAsync\(\s*'incoming_calls'/);
    expect(layout).not.toMatch(/importance:\s*\d/);
  });
});
