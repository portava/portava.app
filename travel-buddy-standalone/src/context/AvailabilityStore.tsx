import React, { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { Availability, Weekday, TimeBlock, TripWindow } from '../types/models.ts';
import {
  getMyAvailability,
  patchMyAvailability,
  patchMyQuickStatus,
  type QuickStatus,
} from '../services/availability.ts';
import { useSession } from './SessionContext.tsx';

interface AvailabilityContextValue {
  availability: Availability;
  toggleBlock: (day: Weekday, block: TimeBlock) => void;
  applyWeekly: (days: Partial<Record<Weekday, TimeBlock[]>>) => void;
  clearWeekly: () => void;
  setOpenToMeet: (v: boolean) => void;
  addTripWindow: (w: TripWindow) => void;
  removeTripWindow: (id: string) => void;
  save: () => Promise<void>;
  /** Re-fetch availability from the backend — call on screen focus to stay fresh. */
  refresh: () => Promise<void>;
  saveError: string | null;
  saving: boolean;
  quickStatus: QuickStatus | null;
  quickStatusExpiresAt: string | null;
  setQuickStatus: (status: QuickStatus) => Promise<void>;
}

const AvailabilityContext = createContext<AvailabilityContextValue | null>(null);

/**
 * The pre-load value. Availability is user data: until the server has answered
 * we know nothing, and "nothing" must render as nothing.
 *
 * This used to seed from `mockAvailability` (src/__fixtures__/events.ts, a
 * fixture whose own header says "not live user data — do not use as primary
 * data source in authenticated flows"). Because this provider is mounted
 * app-wide in app/_layout.tsx, that seed was live for every viewer: anyone
 * signed out, or signed in but before the mount fetch resolved, saw a stranger's
 * fabricated week (Fri/Sat/Sun evening+late) and `openToMeet: true` — which
 * app/availability.tsx renders as "Open to meet — shown on your Passport."
 *
 * It was also writable: `save()` PATCHes whatever is in state, so a user who
 * toggled anything before the fetch landed would persist the fixture's blocks
 * onto their real account.
 *
 * EMPTY is the fail-closed value in both directions — nothing shown, nothing
 * claimed on the user's behalf.
 */
const EMPTY: Availability = { weekly: { days: {} }, trips: [], openToMeet: false };

export function AvailabilityProvider({ children }: { children: React.ReactNode }) {
  const { configured, isAuthed } = useSession();
  const [availability, setAvailability] = useState<Availability>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [quickStatus, setQuickStatusState] = useState<QuickStatus | null>(null);
  const [quickStatusExpiresAt, setQuickStatusExpiresAt] = useState<string | null>(null);

  // Tracks the last value confirmed by the server so save() can roll back to it
  // on failure rather than to the current (already-toggled) optimistic value.
  // Seeded from EMPTY, not a fixture: before the server confirms anything the
  // last confirmed value is "not open to meet", so a failed save rolls back to
  // fail-closed rather than to a fabricated `true`.
  const confirmedOpenToMeet = useRef<boolean>(EMPTY.openToMeet);

  // Load from backend on mount when authenticated
  useEffect(() => {
    if (!configured || !isAuthed) return;
    getMyAvailability().then((res) => {
      if (res.ok && res.data) {
        const d = res.data;
        setAvailability({
          weekly: { days: d.weeklyDays as Partial<Record<Weekday, TimeBlock[]>> },
          trips: [],
          openToMeet: d.openToMeet,
        });
        confirmedOpenToMeet.current = d.openToMeet;
        if (d.quickStatus) {
          setQuickStatusState(d.quickStatus.status as QuickStatus);
          setQuickStatusExpiresAt(d.quickStatus.expiresAt);
        }
      }
    });
  }, [configured, isAuthed]);

  const toggleBlock = useCallback((day: Weekday, block: TimeBlock) => {
    setAvailability((prev) => {
      const days = { ...(prev.weekly?.days ?? {}) };
      const cur = new Set(days[day] ?? []);
      if (cur.has(block)) cur.delete(block); else cur.add(block);
      days[day] = Array.from(cur) as TimeBlock[];
      return { ...prev, weekly: { days } };
    });
  }, []);

  const applyWeekly = useCallback((days: Partial<Record<Weekday, TimeBlock[]>>) => {
    setAvailability((prev) => ({ ...prev, weekly: { days } }));
  }, []);

  const clearWeekly = useCallback(() => {
    setAvailability((prev) => ({ ...prev, weekly: { days: {} } }));
  }, []);

  const setOpenToMeet = useCallback((v: boolean) => {
    setAvailability((prev) => ({ ...prev, openToMeet: v }));
  }, []);

  const addTripWindow = useCallback((w: TripWindow) => {
    setAvailability((prev) => ({ ...prev, trips: [w, ...prev.trips.filter((t) => t.id !== w.id)] }));
  }, []);

  const removeTripWindow = useCallback((id: string) => {
    setAvailability((prev) => ({ ...prev, trips: prev.trips.filter((t) => t.id !== id) }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    // Snapshot the last server-confirmed value so we can roll back to it if
    // the save fails. Using the ref (not the current optimistic state) is
    // critical: by the time save() is called the user has already toggled, so
    // availability.openToMeet already holds the new value — reverting to that
    // would be a no-op. The ref holds the last value the server accepted.
    const snapshotOpenToMeet = confirmedOpenToMeet.current;
    try {
      const res = await patchMyAvailability({
        weeklyDays: availability.weekly?.days,
        openToMeet: availability.openToMeet,
      });
      if (!res.ok) {
        setSaveError(res.message ?? 'Save failed');
        // Revert in-memory state to the server-confirmed value so the chip stays honest.
        setAvailability((prev) => ({ ...prev, openToMeet: snapshotOpenToMeet }));
      } else {
        // Save succeeded — advance the confirmed baseline.
        confirmedOpenToMeet.current = availability.openToMeet;
      }
    } finally {
      setSaving(false);
    }
  }, [availability]);

  const setQuickStatus = useCallback(async (status: QuickStatus) => {
    const res = await patchMyQuickStatus(status);
    if (res.ok && res.data) {
      setQuickStatusState(res.data.status as QuickStatus);
      setQuickStatusExpiresAt(res.data.expiresAt);
    }
  }, []);

  /** Re-fetch availability from backend — call on screen focus to stay fresh. */
  const refresh = useCallback(async () => {
    if (!configured || !isAuthed) return;
    const res = await getMyAvailability();
    if (res.ok && res.data) {
      const d = res.data;
      setAvailability({
        weekly: { days: d.weeklyDays as Partial<Record<Weekday, TimeBlock[]>> },
        trips: [],
        openToMeet: d.openToMeet,
      });
      confirmedOpenToMeet.current = d.openToMeet;
      if (d.quickStatus) {
        setQuickStatusState(d.quickStatus.status as QuickStatus);
        setQuickStatusExpiresAt(d.quickStatus.expiresAt);
      }
    }
  }, [configured, isAuthed]);

  const value = useMemo(
    () => ({
      availability, toggleBlock, applyWeekly, clearWeekly, setOpenToMeet,
      addTripWindow, removeTripWindow, save, refresh, saveError, saving,
      quickStatus, quickStatusExpiresAt, setQuickStatus,
    }),
    [availability, toggleBlock, applyWeekly, clearWeekly, setOpenToMeet,
     addTripWindow, removeTripWindow, save, refresh, saveError, saving,
     quickStatus, quickStatusExpiresAt, setQuickStatus],
  );

  return <AvailabilityContext.Provider value={value}>{children}</AvailabilityContext.Provider>;
}

/**
 * Read + edit availability. With no provider above it this returns an inert,
 * read-only store seeded from EMPTY — a missing provider must render as "no
 * availability known", never as a fixture's week.
 */
export function useAvailabilityStore(): AvailabilityContextValue {
  const ctx = useContext(AvailabilityContext);
  if (!ctx) {
    return {
      availability: EMPTY,
      toggleBlock: () => {}, applyWeekly: () => {}, clearWeekly: () => {},
      setOpenToMeet: () => {}, addTripWindow: () => {}, removeTripWindow: () => {},
      save: async () => {}, refresh: async () => {}, saveError: null, saving: false,
      quickStatus: null, quickStatusExpiresAt: null, setQuickStatus: async () => {},
    };
  }
  return ctx;
}
