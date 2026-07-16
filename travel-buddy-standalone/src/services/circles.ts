/**
 * Circles service — typed wrappers over supabase-js for the circles table.
 * Each user owns one circle (their inner travel circle). Circles have their own
 * UUID and name; the owner_id links back to the user's profile.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';

export interface CircleRow {
  id: string;
  name: string;
  ownerId: string;
}

function mapCircle(r: any): CircleRow {
  return { id: r.id, name: r.name, ownerId: r.owner_id };
}

/**
 * Returns all circles the current user owns or belongs to.
 * RLS on the circles table filters to rows the user can see.
 */
export async function getMyCircles(): Promise<CircleRow[]> {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from('circles')
    .select('id, name, owner_id')
    .order('name', { ascending: true });
  if (error || !data) return [];
  return (data as any[]).map(mapCircle);
}
