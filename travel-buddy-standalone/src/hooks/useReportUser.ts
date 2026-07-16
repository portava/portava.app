import { useState } from 'react';
import { submitReport, type SubmitReportPayload } from '../services/reports.ts';

export function useReportUser() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doReport(payload: SubmitReportPayload): Promise<boolean> {
    setLoading(true); setError(null);
    const res = await submitReport(payload);
    setLoading(false);
    if (res.ok) return true;
    setError(res.error ?? 'Failed to submit report');
    return false;
  }

  return { doReport, loading, error };
}
