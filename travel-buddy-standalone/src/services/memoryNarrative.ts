import { z } from 'zod';
import { assertMemoryOwnerRequest, memoryOwnerHeaders, type MemoryOwnerRequest } from './memoryOwnerRequest.ts';

const draftSchema = z.object({
  memory_id: z.string().uuid(),
  renderer: z.literal('deterministic@1'),
  summary: z.string().min(1).max(20000).refine(value => value.trim().length > 0),
  editable: z.literal(true),
  stored: z.literal(false),
});
const responseSchema = z.object({ narrative: draftSchema });

export async function getMemoryNarrative(request: MemoryOwnerRequest): Promise<
  { ok: true; summary: string } | { ok: false }
> {
  try {
    const headers = await memoryOwnerHeaders(request.memoryId, request);
    assertMemoryOwnerRequest(request.memoryId, request);
    const response = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api/memories/${encodeURIComponent(request.memoryId)}/narrative`, {
      headers, signal: request.signal, cache: 'no-store',
    });
    assertMemoryOwnerRequest(request.memoryId, request);
    if (!response.ok) return { ok: false };
    const parsed = responseSchema.safeParse(await response.json());
    assertMemoryOwnerRequest(request.memoryId, request);
    if (!parsed.success || parsed.data.narrative.memory_id !== request.memoryId) return { ok: false };
    return { ok: true, summary: parsed.data.narrative.summary };
  } catch {
    return { ok: false };
  }
}
