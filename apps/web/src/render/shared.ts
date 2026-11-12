/**
 * Build-time code (pages, content) imports the shared package through this RELATIVE path.
 * Vite bundles the config with relative imports included, but loads bare package imports
 * with plain Node, which cannot resolve shared's extensionless TypeScript imports.
 * Browser code (main.ts, admin.ts) imports `@lensarent/shared/...` as usual.
 */
export * from "../../../../packages/shared/src/index.ts";
