# Chrome Web Store API publishing

Publish new versions of **Kinetic Grid Grouping Fix**
(item `gpeldgohabcpbdkkddahojbaechjdfpc`) from the CLI, because the Web Store
Developer Dashboard cannot be driven by an automation/extension
("the extensions gallery cannot be scripted").

```
get-refresh-token.mjs   one-time: OAuth loopback flow → writes refreshToken
publish.mjs             upload (+ optionally submit-for-review) a dist zip
credentials.json        your secrets (gitignored — never committed)
credentials.example.json   template
```

---

## One-time setup (you do this, ~10 min)

Do this signed in as the **Google account that owns the extension**.

### 1. Google Cloud project
<https://console.cloud.google.com/> → project picker → **New Project**
(or reuse one). Call it e.g. `cws-publish`.

### 2. Enable the Chrome Web Store API
<https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com>
— with the project selected, click **Enable**.

### 3. OAuth consent screen
<https://console.cloud.google.com/apis/credentials/consent>
- User type: **External** → Create.
- App name + support email + developer email: your own.
- **Publishing status: set to "In production"** (Publish app → Confirm).
  This makes the refresh token long-lived. If you leave it in **Testing**,
  the refresh token expires after **7 days** and you re-run step 6 each time.
  (You do not need Google verification for personal use — you'll just click
  through an "unverified app" screen once in step 6.)

### 4. OAuth client ID — **Desktop app**
<https://console.cloud.google.com/apis/credentials>
→ Create credentials → OAuth client ID → Application type: **Desktop app**
→ Create. Copy the **Client ID** and **Client secret**.
("Desktop app" auto-allows the `http://127.0.0.1:<port>` loopback redirect the
helper uses — no redirect URI to register.)

### 5. Fill in credentials.json
```bash
cd apps/kinetic-grid-fix-extension/scripts/cws-publish
cp credentials.example.json credentials.json
# edit credentials.json: paste clientId + clientSecret
# (itemId is already set; refreshToken is filled in by the next step)
```

### 6. Get the refresh token
```bash
node get-refresh-token.mjs
```
A browser opens → sign in as the extension owner → approve. If you see
"Google hasn't verified this app": **Advanced → Go to … (unsafe)** (it's your
own app). The helper writes `refreshToken` into `credentials.json`.

---

## Publishing

```bash
# from this folder, after `npm run package` in the extension root:
node publish.mjs            # upload newest dist/*.zip as a DRAFT (no review yet)
node publish.mjs --status   # inspect the item's current/draft state
node publish.mjs --publish  # upload + submit for review
```

- `--zip <path>` uploads a specific zip instead of the newest in `dist/`.
- `--publish --target trustedTesters` publishes to trusted testers only.
- This extension uses the **`debugger`** permission, so Google reviews every
  update. The **currently published version stays live** until the new one is
  approved; a submission can take from hours to several days.

## Cutting a release
```bash
cd apps/kinetic-grid-fix-extension
npm run package                      # check + tests + build the versioned zip
node scripts/cws-publish/publish.mjs --publish
```
Bump `version` in `manifest.json` + `package.json` first — the Web Store
rejects an upload whose version is not higher than the live one.

## Security
- `credentials.json` holds your client secret + refresh token and is
  **gitignored**. Anyone with it can publish as you — keep it local. Revoke at
  <https://myaccount.google.com/permissions> if it leaks, then re-run step 6.
- Neither script ever prints the secret, the refresh token, or access tokens.
