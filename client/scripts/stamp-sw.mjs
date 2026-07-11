// Stamp the built service worker with a unique cache version so every deploy
// purges stale caches automatically (no-touch cache busting).
//
// Uses SW_BUILD_ID when provided (e.g. the git commit SHA passed through the
// Docker build), otherwise falls back to a build timestamp. Never fails the build.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const swPath = resolve(here, '..', 'dist', 'serviceWorker.js');

const rawId = String(process.env.SW_BUILD_ID || '').trim();
const version = (rawId ? rawId.slice(0, 12) : `t${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '') || `t${Date.now()}`;

try {
  if (!existsSync(swPath)) {
    console.warn('[stamp-sw] dist/serviceWorker.js not found; skipping');
    process.exit(0);
  }
  const src = readFileSync(swPath, 'utf8');
  if (src.includes('__SW_VERSION__')) {
    writeFileSync(swPath, src.split('__SW_VERSION__').join(version));
    console.log(`[stamp-sw] SW_VERSION set to "${version}"`);
  } else {
    console.log('[stamp-sw] placeholder not present (already stamped?); leaving as-is');
  }
} catch (e) {
  console.warn('[stamp-sw] failed (non-fatal):', e.message);
  process.exit(0);
}
