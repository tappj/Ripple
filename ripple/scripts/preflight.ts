// Zero-credit preflight for real mode: validates the API key, reports the dev-org
// credit balance, and exercises the ephemeral upload path end to end.
// Run: npm run preflight
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RealRunwayClient } from '../server/runway.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadApiKey(): string | null {
  if (process.env.RUNWAY_API_KEY) return process.env.RUNWAY_API_KEY.trim();
  const keyFile = path.join(here, '..', '..', 'api-key.txt');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  return null;
}

const key = loadApiKey();
if (!key) {
  console.error('✗ No API key (set RUNWAY_API_KEY or create ../api-key.txt). Ripple will run in mock mode.');
  process.exit(1);
}

const client = new RealRunwayClient(key);

const credits = await client.getCredits();
if (!credits) {
  console.error('✗ Key rejected by /v1/organization — check the key.');
  process.exit(1);
}
console.log(`✓ Key valid. Dev-org credit balance: ${credits.creditBalance.toLocaleString()}`);
if (credits.creditBalance === 0) {
  console.warn(
    '⚠ Balance is 0 — generations will fail. Note: developer API credits are a separate pool\n' +
    '  from Runway app/workspace credits; top up at https://dev.runwayml.com.',
  );
}

const demo = path.join(here, '..', 'demo', 'scene.mp4');
if (existsSync(demo)) {
  try {
    // Uploads don't consume credits — exercises the uploads → runway:// URI path.
    // @ts-expect-error deliberate private access: preflight tests the internal upload path
    const uri: string = await client.uploadVideo(demo);
    console.log(`✓ Ephemeral upload works: ${uri.slice(0, 40)}…`);
  } catch (err) {
    // Observed on fresh dev orgs: uploads themselves are gated until the org has
    // made at least one credit purchase.
    console.error(`✗ Upload check failed: ${(err as Error).message}`);
  }
} else {
  console.log('– demo/scene.mp4 not present; skipped upload check.');
}
console.log('Preflight complete.');
