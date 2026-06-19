/**
 * usePassport — data seam for the Passport screen.
 * Today: returns mock data synchronously. Later: swap the body for a fetch to
 * the backend (auth'd) without changing the screen. Shape is the contract.
 */
import { useState, useEffect } from 'react';
import type { PassportData } from '../types/models';
import { mockPassport } from '../data/passport';

interface PassportState {
  data: PassportData | null;
  loading: boolean;
  error: string | null;
}

export function usePassport(): PassportState {
  const [state, setState] = useState<PassportState>({
    data: null, loading: true, error: null,
  });

  useEffect(() => {
    // TODO(backend): replace with GET /me/passport. Keep the same PassportData shape.
    let alive = true;
    const id = setTimeout(() => {
      if (alive) setState({ data: mockPassport, loading: false, error: null });
    }, 0);
    return () => { alive = false; clearTimeout(id); };
  }, []);

  return state;
}
