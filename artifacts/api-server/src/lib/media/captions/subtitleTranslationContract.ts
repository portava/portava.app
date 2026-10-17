export interface CaptionTranslationRequest {
  version: number;
  revisionKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  consent: true;
  expectedConsentEpoch: number;
}

export interface CaptionTranslationStatus {
  enabled: boolean;
  cleanupPending: boolean;
  allowedPairs: Array<{ source: string; target: string }>;
  sourceVersion: number;
  revisionKey: string;
  consentEpoch: number;
  state: 'not_requested' | 'pending' | 'processing' | 'retrying' | 'completed' | 'failed';
  canRevoke: boolean;
  current: boolean;
}

export interface CaptionTranslationEnqueueResponse extends CaptionTranslationStatus {
  jobId: string;
  cleanupPending: boolean;
}

export interface CaptionTranslationRevokeResponse {
  revoked: true;
  consentEpoch: number;
  cleanupPending: boolean;
}

export interface CaptionTranslationDraftDto {
  draftId: string;
  version: number;
  revisionKey: string;
  vtt: string;
  language: string;
  sourceLanguage: string;
  aiLabel: 'AI translation · needs creator review';
  modelVersion: string;
}

export interface CaptionTranslationDraftResponse {
  draft: CaptionTranslationDraftDto | null;
}

export interface CaptionTranslationPublishRequest {
  version: number;
  revisionKey: string;
  draftId: string;
  reviewed: true;
  vtt: string;
}

export interface CaptionTranslationPublishResponse {
  assetId: string;
  version: number;
  revisionKey: string;
  language: string;
  sourceKind: 'translation';
  aiLabel: 'AI translation · creator reviewed';
  availableLanguages: string[];
  cleanupPending: boolean;
}
