export const TRAIL_READ_PAGE_SIZE = 500;
export const MAX_TRAIL_READ_ROWS = 20_000;
export const MAX_TRAIL_READ_PAGES = 100;

interface TrailReadPage {
  data: any[] | null;
  error: any;
  count?: number | null;
}

export async function readBoundedTrailRows(
  read: (from: number, to: number) => PromiseLike<TrailReadPage>,
): Promise<{ data: any[] | null; error: any }> {
  const incomplete = { data: null, error: { code: "TRAIL_READ_INCOMPLETE", message: "Trail read could not establish a complete bounded result" } };
  const rows: any[] = [];
  let total: number | null = null;
  try {
    for (let page = 0; page < MAX_TRAIL_READ_PAGES && rows.length < MAX_TRAIL_READ_ROWS; page += 1) {
      const size = Math.min(TRAIL_READ_PAGE_SIZE, MAX_TRAIL_READ_ROWS - rows.length);
      const result = await read(rows.length, rows.length + size - 1);
      if (result.error) return { data: null, error: result.error };
      if (!Array.isArray(result.data) || result.data.length > size) return incomplete;
      if (total !== null && result.count == null) return incomplete;
      if (result.count != null) {
        if (!Number.isSafeInteger(result.count) || result.count < 0 || result.count > MAX_TRAIL_READ_ROWS
            || (total !== null && total !== result.count)) return incomplete;
        total = result.count;
      }
      rows.push(...result.data);
      if (total !== null && rows.length > total) return incomplete;
      if (result.data.length === 0) return total === null || rows.length === total ? { data: rows, error: null } : incomplete;
      if (total !== null && rows.length === total) return { data: rows, error: null };
    }
  } catch (error) {
    return { data: null, error: error || incomplete.error };
  }
  return incomplete;
}
