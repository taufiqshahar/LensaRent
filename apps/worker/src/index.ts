import { createApp } from "./app";

/**
 * The single Cloudflare Worker for LensaRent. Requests to /api/* arrive here; everything
 * else is served directly from static assets (see wrangler.toml).
 *
 * This Worker is the main enforcement layer for data integrity: every rule about bookings,
 * status changes and the ledger is checked in code here before anything is written. The
 * D1 schema (keys, CHECK constraints, triggers) backs it up but does not replace it.
 */
export default createApp();
