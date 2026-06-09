#!/usr/bin/env node
// Upload (and optionally publish) the extension zip to the Chrome Web Store API.
//
//   node publish.mjs                       # upload newest dist zip as a draft
//   node publish.mjs --zip <path>          # upload a specific zip
//   node publish.mjs --publish             # upload, then submit for review (target: default)
//   node publish.mjs --publish --target trustedTesters
//   node publish.mjs --status              # just show the current item state
//   node publish.mjs --dry-run             # resolve creds + zip, do nothing
//
// Reads credentials.json (clientId, clientSecret, refreshToken, itemId).
// Never prints secrets or tokens — only upload/publish state.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRED_PATH = join(HERE, 'credentials.json');
const DIST = resolve(HERE, '..', '..', 'dist'); // apps/kinetic-grid-fix-extension/dist
const API = 'https://www.googleapis.com/chromewebstore/v1.1';
const UPLOAD_API = 'https://www.googleapis.com/upload/chromewebstore/v1.1';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

let creds;
try { creds = JSON.parse(readFileSync(CRED_PATH, 'utf8')); }
catch { die('credentials.json not found. Copy credentials.example.json and run get-refresh-token.mjs first.'); }
for (const k of ['clientId', 'clientSecret', 'refreshToken', 'itemId']) {
  if (!creds[k] || String(creds[k]).includes('PASTE')) {
    die(`credentials.json is missing "${k}". ${k === 'refreshToken' ? 'Run get-refresh-token.mjs.' : 'Fill it in.'}`);
  }
}

function newestZip() {
  if (!existsSync(DIST)) die(`dist/ not found at ${DIST}. Run \`npm run package\` first.`);
  const zips = readdirSync(DIST)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => join(DIST, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!zips.length) die('No .zip in dist/. Run `npm run package` first.');
  return zips[0];
}

async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    const hint = j.error === 'invalid_grant'
      ? ' (refresh token expired or revoked — re-run get-refresh-token.mjs; keep the OAuth consent screen "In production" so tokens do not expire after 7 days)'
      : '';
    die(`Token refresh failed: ${j.error || r.status} ${j.error_description || ''}`.trim() + hint);
  }
  return j.access_token;
}

async function main() {
  console.log('Chrome Web Store publish');
  console.log('  item: ' + creds.itemId);
  const token = await accessToken();

  if (has('--status')) {
    const r = await fetch(`${API}/items/${creds.itemId}?projection=DRAFT`, {
      headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
    });
    console.log(JSON.stringify(await r.json(), null, 2));
    return;
  }

  const zipPath = val('--zip') ? resolve(val('--zip')) : newestZip();
  if (!existsSync(zipPath)) die('zip not found: ' + zipPath);
  const bytes = readFileSync(zipPath);
  console.log('  zip:  ' + zipPath + `  (${bytes.length} bytes)`);

  if (has('--dry-run')) {
    console.log('  [dry-run] would upload' + (has('--publish') ? ' + publish' : '') + '. No request sent.');
    return;
  }

  // ---- Upload ----
  console.log('→ Uploading package…');
  const up = await fetch(`${UPLOAD_API}/items/${creds.itemId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' },
    body: bytes,
  });
  const upj = await up.json();
  const state = upj.uploadState;
  if (!up.ok || state === 'FAILURE') {
    const errs = (upj.itemError || []).map((e) => `${e.error_code || ''}: ${e.error_detail || ''}`).join('\n    ');
    die(`Upload ${state || up.status}.\n    ${errs || JSON.stringify(upj)}`);
  }
  console.log(`✓ Upload state: ${state}`); // SUCCESS (small zips) or IN_PROGRESS
  if (state === 'IN_PROGRESS') {
    console.log('  Still processing server-side. Re-run with --status in a minute to confirm before publishing.');
  }

  if (!has('--publish')) {
    console.log('\nDraft uploaded (NOT submitted for review — no --publish flag).');
    console.log('When ready:  node publish.mjs --publish');
    return;
  }

  // ---- Publish ----
  const target = val('--target') || 'default';
  console.log(`→ Publishing (target: ${target})…`);
  const init = { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' } };
  if (target !== 'default') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify({ target });
  }
  const pub = await fetch(`${API}/items/${creds.itemId}/publish`, init);
  const pubj = await pub.json();
  if (!pub.ok) die(`Publish failed: ${pub.status}\n    ${JSON.stringify(pubj)}`);
  const statuses = pubj.status || [];
  console.log(`✓ Publish status: ${statuses.join(', ') || JSON.stringify(pubj)}`);
  if (pubj.statusDetail && pubj.statusDetail.length) console.log('  ' + pubj.statusDetail.join('; '));
  console.log('\nSubmitted. The new version goes live after Google review;'
    + ' the current published version stays live until then.');
}

main().catch((e) => die(e.message));
