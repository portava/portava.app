// Payments / identity provider mode: ONE startup line, booleans only.
// Imported for its side effect by index.ts (on an existing import line, so
// index.ts keeps its length and every line the censuses cite keeps its number).
// Provider name, key present, key mode (test/live/unknown/none), live allowed,
// key refused — never the key. For sandbox testing PAYMENTS_ALLOW_LIVE stays
// unset; see lib/paymentsMode.ts.
import { logger } from "./logger";
import { paymentsStartupSummary } from "./paymentsMode.js";
import { paymentsReadinessSummary } from "../services/payments/readiness.js";

const paymentsMode = paymentsStartupSummary();
if (paymentsMode.keyRefused) {
  logger.warn(paymentsMode, "startup: payments/identity provider mode — key REFUSED, every provider call will be refused");
} else {
  logger.info(paymentsMode, "startup: payments/identity provider mode");
}

// The PAYMENT provider's readiness: a second line, same rule — names, booleans
// and enums, never a key (services/payments/readiness.ts). It reports the
// configured PAYMENT_PROVIDER, its key mode, PAYMENTS_ALLOW_LIVE, the tax
// provider and whether tax is configured for the enabled markets, and the first
// reason payments are not operational. A probe that cannot be built must not
// stop the server from starting, so a failure here is logged and nothing more.
try {
  const paymentsReadiness = paymentsReadinessSummary();
  if (paymentsReadiness.keyRefused) {
    logger.warn(paymentsReadiness, "startup: payment provider readiness — key REFUSED, every payment provider call will be refused");
  } else {
    logger.info(paymentsReadiness, "startup: payment provider readiness");
  }
} catch (err) {
  logger.error({ errName: err instanceof Error ? err.name : typeof err }, "startup: payment provider readiness could not be computed");
}
