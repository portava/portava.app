import type { AdaptiveOutput, AdaptiveSource } from "./types.js";

export const ADAPTIVE_PIPELINE = "hls-v1";
export const ADAPTIVE_KIND = "adaptive_video";

export interface AdaptiveLease {
  id: string;
  source: AdaptiveSource;
  token: string;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}

export interface AdaptiveJobs {
  enqueue(source: AdaptiveSource): Promise<{ id: string }>;
  ready(assetId: string, sourceVersion: number): Promise<AdaptiveOutput | null>;
  cancelAsset(assetId: string): Promise<void>;
}
