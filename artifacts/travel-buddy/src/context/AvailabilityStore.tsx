import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { Availability, Weekday, TimeBlock, TripWindow } from '../types/models';
import { mockAvailability } from '../data/events';

/**
 * Availability session store. Seeded from mockAvailability; edits live in memory
 * for the session (NOT backend-persisted). Pulse ordering + status chips read from
 * here via useAvailability(), so edits propagate live.
 *
 * TO MIGRATE: replace seed + setter bodies with GET/PUT /me/availability.
 */

interface AvailabilityContextValue {
  availability: Availability;
  toggleBlock: (day: Weekday, block: TimeBlock) => void;
  applyWeekly: (days: Partial<Record<Weekday, TimeBlock[]>>) => void;
  clearWeekly: () => void;
  setOpenToMeet: (v: boolean) => void;
  addTripWindow: (w: TripWindow) => void;
  removeTripWindow: (id: string) => void;
  save: () => Promise<void>;   // session: no-op persist (honest); API PUT later
}

const AvailabilityContext = createContext<AvailabilityContextValue | null>(null);

const EMPTY: Availability = { weekly: { days: {} }, trips: [], openToMeet: false };

export function AvailabilityProvider({ children }: { children: React.ReactNode }) {
  const [availability, setAvailability] = useState<Availability>(
    (mockAvailability as Availability) ?? EMPTY,
  );

  const toggleBlock = useCallback((day: Weekday, block: TimeBlock) => {
    setAvailability((prev) => {
      const days = { ...(prev.weekly?.days ?? {}) };
      const cur = new Set(days[day] ?? []);
      if (cur.has(block)) cur.delete(block); else cur.add(block);
      days[day] = Array.from(cur);
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
    // session-only: state already updated. TODO(backend): PUT /me/availability
  }, []);

  const value = useMemo(
    () => ({ availability, toggleBlock, applyWeekly, clearWeekly, setOpenToMeet, addTripWindow, removeTripWindow, save }),
    [availability, toggleBlock, applyWeekly, clearWeekly, setOpenToMeet, addTripWindow, removeTripWindow, save],
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
      save: async () => {},
    };
  }
  return ctx;
}
