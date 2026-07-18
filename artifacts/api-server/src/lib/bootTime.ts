/**
 * Boot-time reference captured as early as possible during process startup.
 * Imported by app.ts (cold-start middleware) and any other module that needs
 * process uptime relative to the very first line of code executed.
 */
export const BOOT_HRTIME: bigint = process.hrtime.bigint();
