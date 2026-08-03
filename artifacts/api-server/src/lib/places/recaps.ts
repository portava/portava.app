import { createHash } from "node:crypto";
import { isFlagEnabled } from "../featureFlags.js";

export type RecapSource = {
  id: string;
  type: "place_day_post" | "moment_contribution";
  postId: string | null;
  contributorId: string | null;
  caption: string | null;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  mediaType: string | null;
  createdAt: string | null;
};

export async function areRecapsEnabled(sc: any, kind: "place" | "moment"): Promise<boolean> {
  const flags = await Promise.all([
    isFlagEnabled(sc, "external_places_enabled"), isFlagEnabled(sc, "place_days_enabled"),
    isFlagEnabled(sc, kind === "place" ? "place_recaps_enabled" : "moment_recaps_enabled"),
    kind === "moment" ? isFlagEnabled(sc, "shared_moments_enabled") : Promise.resolve(true),
  ]);
  return flags.every(Boolean);
}

export function recapSourceHash(sources: RecapSource[]): string {
  return createHash("sha256").update(JSON.stringify(sources.map((s) => [s.type, s.id, s.postId, s.createdAt]))).digest("hex");
}

/** Deterministic, labeled suggestions. The model is intentionally not allowed
 * to invent claims; every chapter names its exact source IDs. */
export function proposeRecapChapters(sources: RecapSource[]) {
  return sources.slice(0, 3).map((source, ordinal) => ({
    ordinal, title: ordinal === 0 ? "The day begins" : `Shared highlight ${ordinal + 1}`,
    body: source.caption?.slice(0, 280) ?? "A shared moment from this recap.",
    sourceIds: [source.id], origin: "compass_suggested" as const,
  }));
}