/** Device battery input for L157. Read only during opted-in foreground assistance; unsupported devices stay unknown. */
import { useEffect, useState } from 'react';
import type { LiveSensingInput } from './layoverSensingCadence.ts';

type Power = LiveSensingInput['power'];
const UNKNOWN: Power = Object.freeze({ lowPowerMode: null, batteryLevel: null });
const batteryLevel = (n: number): number | null => Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;

/** Refresh after each one-shot fix as well as on OS events (Android battery events only mark significant changes). */
export function useLayoverPowerState(active: boolean, refreshKey: number): Power {
  const [power, setPower] = useState<Power>(UNKNOWN);
  useEffect(() => {
    if (!active) { setPower(UNKNOWN); return; }
    let live = true;
    let batteryRevision = 0;
    let modeRevision = 0;
    const subscriptions: Array<{ remove(): void }> = [];
    void (async () => {
      try {
        // Lazy import also degrades safely on an older native binary that has not yet linked ExpoBattery.
        const Battery: typeof import('expo-battery') = require('expo-battery');
        if (!(await Battery.isAvailableAsync()) || !live) { if (live) setPower(UNKNOWN); return; }
        subscriptions.push(Battery.addBatteryLevelListener((event) => {
          if (!live) return;
          ++batteryRevision;
          setPower((p) => ({ ...p, batteryLevel: batteryLevel(event.batteryLevel) }));
        }));
        subscriptions.push(Battery.addLowPowerModeListener((event) => {
          if (!live) return;
          ++modeRevision;
          setPower((p) => ({ ...p, lowPowerMode: event.lowPowerMode }));
        }));
        const initial = await Battery.getPowerStateAsync();
        if (live) setPower((p) => ({
          batteryLevel: batteryRevision === 0 ? batteryLevel(initial.batteryLevel) : p.batteryLevel,
          lowPowerMode: modeRevision === 0 ? initial.lowPowerMode : p.lowPowerMode,
        }));
      } catch {
        if (live) setPower((p) => ({ batteryLevel: batteryRevision === 0 ? null : p.batteryLevel, lowPowerMode: modeRevision === 0 ? null : p.lowPowerMode }));
      }
    })();
    return () => { live = false; for (const subscription of subscriptions) subscription.remove(); };
  }, [active, refreshKey]);
  return active ? power : UNKNOWN;
}
