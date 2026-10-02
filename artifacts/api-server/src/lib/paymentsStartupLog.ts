// Payments / identity provider mode: ONE startup line, booleans only.
// Imported for its side effect by index.ts (on an existing import line, so
// index.ts keeps its length and every line the censuses cite keeps its number).
// Provider name, key present, key mode (test/live/unknown/none), live allowed,
// key refused — never the key. For sandbox testing PAYMENTS_ALLOW_LIVE stays
// unset; see lib/paymentsMode.ts.
import { logger } from "./logger";
import { paymentsStartupSummary } from "./paymentsMode.js";

const paymentsMode = paymentsStartupSummary();
if (paymentsMode.keyRefused) {
  logger.warn(paymentsMode, "startup: payments/identity provider mode — key REFUSED, every provider call will be refused");
} else {
  logger.info(paymentsMode, "startup: payments/identity provider mode");
}
