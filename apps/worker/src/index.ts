import { createApp } from "./app";

/**
 * The single Cloudflare Worker for LensaRent. Requests to /api/* arrive here; everything
 * else is served directly from static assets (see wrangler.toml).
 *
 * This Worker is the ONLY enforcement layer for data integrity. It writes to Firestore as
 * a service account, which bypasses Security Rules, so every rule about bookings, status
 * changes and the ledger has to be checked in code here before anything is written.
 */
export default createApp();
