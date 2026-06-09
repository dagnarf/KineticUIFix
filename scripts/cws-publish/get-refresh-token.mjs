#!/usr/bin/env node
// One-time helper: obtain a Chrome Web Store API refresh token via the OAuth
// loopback flow and store it in credentials.json.
//
//   node get-refresh-token.mjs
//
// Prereq: credentials.json exists with clientId + clientSecret filled in
// (from a Google Cloud OAuth "Desktop app" client). See README.md.
//
// This never prints the client secret or the tokens; it only writes the
// refresh token into credentials.json and reports success.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CRED_PATH = join(HERE, 'credentials.json');
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

function die(msg) { console.error('✗ ' + msg); process.exit(1); }

let creds;
try {
  creds = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
} catch {
  die('Could not read credentials.json next to this script.\n'
    + '  Run:  cp credentials.example.json credentials.json\n'
    + '  then fill in clientId + clientSecret and re-run.');
}
if (!creds.clientId || !creds.clientSecret
  || String(creds.clientId).includes('PASTE') || String(creds.clientSecret).includes('PASTE')) {
  die('credentials.json is missing clientId / clientSecret.\n'
    + '  Paste them from your Google Cloud OAuth "Desktop app" client, then re-run.');
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* user opens manually */ }
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }

  const err = u.searchParams.get('error');
  if (err) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<h2>Authorization failed: ${err}</h2><p>Close this tab and re-run the script.</p>`);
    server.close();
    die('Authorization error: ' + err);
    return;
  }
  const code = u.searchParams.get('code');
  if (!code) { res.writeHead(400); res.end('missing code'); return; }

  try {
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}`;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tok = await r.json();
    if (!r.ok || !tok.refresh_token) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h2>Token exchange failed.</h2><p>Check the terminal.</p>');
      server.close();
      let hint = '';
      if (!tok.refresh_token && tok.access_token) {
        hint = '\n  (Got an access token but no refresh token. Revoke prior access at'
          + '\n   https://myaccount.google.com/permissions then retry — Google only returns a'
          + '\n   refresh token on the first consent unless prompt=consent forces a fresh one.)';
      }
      die(`Token exchange failed: ${tok.error || r.status} ${tok.error_description || ''}`.trim() + hint);
      return;
    }
    creds.refreshToken = tok.refresh_token;
    writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2) + '\n');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h2>✓ Refresh token captured.</h2><p>Close this tab and return to the terminal.</p>');
    console.log('✓ Refresh token saved to credentials.json');
    console.log('  Next:  node publish.mjs            # upload the zip as a draft');
    console.log('         node publish.mjs --publish  # upload + submit for review');
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500); res.end('error');
    server.close();
    die('Unexpected error during token exchange: ' + e.message);
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  console.log('\nChrome Web Store API — one-time authorization');
  console.log('--------------------------------------------');
  console.log('A browser window should open. If it does not, open this URL manually:\n');
  console.log('  ' + authUrl + '\n');
  console.log('Sign in as the extension owner account and approve.');
  console.log('If you see "Google hasn’t verified this app": Advanced → Go to … (unsafe). It is your own app.');
  console.log('\nWaiting for the redirect on ' + redirectUri + ' …');
  openBrowser(authUrl);
});
