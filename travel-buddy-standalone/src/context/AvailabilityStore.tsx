import React, { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { Availability, Weekday, TimeBlock, TripWindow } from '../types/models.ts';
import { mockAvailability } from '../data/events.ts';
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

const EMPTY: Availability = { weekly: { days: {} }, trips: [], openToMeet: false };

export function AvailabilityProvider({ children }: { children: React.ReactNode }) {
  const { configured, isAuthed } = useSession();
  const [availability, setAvailability] = useState<Availability>(
    (mockAvailability as Availability) ?? EMPTY,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [quickStatus, setQuickStatusState] = useState<QuickStatus | null>(null);
  const [quickStatusExpiresAt, setQuickStatusExpiresAt] = useState<string | null>(null);

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
    try {
      const res = await patchMyAvailability({
        weeklyDays: availability.weekly?.days,
        openToMeet: availability.openToMeet,
      });
      if (!res.ok) setSaveError(res.message ?? 'Save failed');
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

/** Read + edit availability. Falls back to mock (read-only) if provider missing. */
export function useAvailabilityStore(): AvailabilityContextValue {
  const ctx = useContext(AvailabilityContext);
  if (!ctx) {
    return {
      availability: (mockAvailability as Availability) ?? EMPTY,
      toggleBlock: () => {}, applyWeekly: () => {}, clearWeekly: () => {},
      setOpenToMeet: () => {}, addTripWindow: () => {}, removeTripWindow: () => {},
      save: async () => {}, refresh: async () => {}, saveError: null, saving: false,
      quickStatus: null, quickStatusExpiresAt: null, setQuickStatus: async () => {},
    };
  }
  return ctx;
}
