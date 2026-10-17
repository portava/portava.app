import { freshToken } from './apiToken.ts';

export interface LifeChapter {
  id: string;
  kind: 'place' | 'person';
  startedAt: string;
  endedAt: string;
  memoryIds: string[];
}

export type LifeChaptersResult =
  | { ok: true; chapters: LifeChapter[]; truncated: boolean; recordedTimeCount: number }
  | { ok: false; message: string };

const unavailable = (): LifeChaptersResult => ({ ok: false, message: 'Life Chapters could not be loaded. Please try again.' });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getLifeChapters(signal?: AbortSignal): Promise<LifeChaptersResult> {
  try {
    const token = await freshToken();
    if (!token) return { ok: false, message: 'Please sign in to see your Life Chapters.' };
    if (signal?.aborted) return unavailable();
    const response = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api/memories/graph`, {
      headers: { Authorization: `Bearer ${token}` }, signal,
    });
    if (!response.ok) return unavailable();
    const body = await response.json();
    const graph = body?.graph;
    const nodes = graph?.levels?.LIFE_CHAPTER;
    if (!Array.isArray(nodes) || typeof graph.truncated !== 'boolean'
      || !Number.isSafeInteger(graph.momentCount) || graph.momentCount < 0 || graph.momentCount > 2000
      || !Number.isSafeInteger(graph.momentsOnRecordedTime) || graph.momentsOnRecordedTime < 0
      || graph.momentsOnRecordedTime > graph.momentCount) return unavailable();
    const chapters: LifeChapter[] = [];
    const seen = new Set<string>();
    for (const node of nodes) {
      if (!node || node.level !== 'LIFE_CHAPTER' || typeof node.key !== 'string'
        || !/^(place|person):.+$/.test(node.key) || node.id !== `life_chapter:${node.key}`
        || seen.has(node.id) || typeof node.startedAt !== 'string' || typeof node.endedAt !== 'string'
        || !Number.isFinite(Date.parse(node.startedAt)) || !Number.isFinite(Date.parse(node.endedAt))
        || Date.parse(node.startedAt) > Date.parse(node.endedAt)
        || !Array.isArray(node.memberMemoryIds) || node.memberMemoryIds.length < 2
        || node.memberMemoryIds.length > graph.momentCount
        || node.memberMemoryIds.some((memoryId: unknown) => typeof memoryId !== 'string' || !uuid.test(memoryId))
        || new Set(node.memberMemoryIds).size !== node.memberMemoryIds.length
        || node.memoryCount !== node.memberMemoryIds.length) return unavailable();
      seen.add(node.id);
      chapters.push({
        id: node.id, kind: node.key.startsWith('place:') ? 'place' : 'person',
        startedAt: node.startedAt, endedAt: node.endedAt, memoryIds: [...node.memberMemoryIds],
      });
    }
    return { ok: true, chapters, truncated: graph.truncated, recordedTimeCount: graph.momentsOnRecordedTime };
  } catch {
    return unavailable();
  }
}
