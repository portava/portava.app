/**
 * Re-export public surface for identity verification service.
 * Import from here inside the api-server package; never import from
 * travel-buddy-standalone/server/ (different workspace package).
 */
export { getIdentityProvider } from './providers.js';
export { toVerificationLevel } from './types.js';
export type {
  IdentityVerificationProvider,
  VerificationResult,
  VerificationRequest,
  VerificationSession,
  WebhookEvent,
  NormalizedVerificationStatus,
  NormalizedFailureReason,
  VerificationProviderName,
} from './types.js';
