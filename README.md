# Vobiz Calling for Copper

Agents take and place phone calls from their own Vobiz numbers in the browser, next to Copper CRM. Every call is logged in Copper as a Phone Call activity on the caller's person, lead or company.

- **Know who is calling.** An incoming call shows the caller's Copper record (person, lead or company), title and company before the agent answers.
- **Call in one click.** With the Vobiz panel added to Copper, clicking any phone number in Copper sends it to the softphone, ready to call.
- **Every call logged.** Answered, missed, busy and failed calls become Copper Phone Call activities with direction, outcome, talk time and agent. An unknown number becomes a new lead (or person). A missed call also gets a "Call back" task assigned to the agent.
- **Recordings where you work.** A signed, expiring recording link is added to the call's activity.
- **No long-lived secret in the browser.** By default the softphone registers with a short-lived Vobiz access token (JWT) that the backend asks Vobiz to sign for each agent and renews before it expires.

The softphone runs in its own browser tab. Copper's embedded apps are iframes that Copper does not document as having microphone access, so a Copper panel cannot hold the call itself. It is the same softphone as the other Vobiz CRM integrations (Close, Help Scout, Twenty, Zendesk, ClickUp).

## How it fits together

| Part | Where it runs | What it does |
| --- | --- | --- |
| Softphone | `/phone`, a tab the agent keeps open | JsSIP over WSS to `registrar.vobiz.ai`, sign-in, ringing card, call controls, settings, recent calls |
| Copper panel | `/copper`, a Copper embedded app in the action bar (optionally also in record sidebars) | Catches clicks on phone numbers in Copper and sends them to the agent's softphone; lists the numbers of the record on screen |
| Pairing popup | `/pair`, opened once by the Copper panel | Links the panel to the agent's softphone tab |
| `tel:` handler | `/dial`, opened by the browser for `tel:` links outside Copper | Hands the number to the open softphone tab |
| Backend | One Node.js process | Copper OAuth or API key, Vobiz sign-in and access tokens, Vobiz webhooks, Copper writes, signed recording playback |

Audio goes straight from the browser to Vobiz. The backend only signs agents in, mints access tokens, answers Vobiz with VobizXML, and writes to Copper. See [docs/architecture.md](docs/architecture.md).

## What it writes to Copper

| Event | Copper record |
| --- | --- |
| Any call ends | One **activity** (`POST /activities`) of the account's **Phone Call** type on the caller's person, lead or company. Copper activities have no direction or duration field, so the activity's text holds: direction and outcome, agent, talk time, customer number, Vobiz number, start time and call UUID |
| Number matches no record | A new **lead** (or **person**, in Settings) named `Caller +91XXXXXXXXXX` with that number (can be turned off) |
| Missed inbound call | A **task** `Call back +91XXXXXXXXXX` related to the record, assigned to the agent (or the admin writing it), priority High, due now (can be turned off) |
| Recording is ready | The same activity's text gets a signed `https` recording link (`PUT /activities/{id}`) |

Calls are written as the agent who handled the call, so Copper shows them as that agent's. A call nobody answered is written as a connected admin of that Copper account.

Callers are matched on every phone number of people, then leads, then companies, on the full number including the country code. If the account has no enabled "Phone Call" activity type, calls are logged as Notes.

## Requirements

- Node.js 20 or later (CI uses 24).
- A public HTTPS URL for the backend. Vobiz must reach `/vobiz/answer`, Copper loads `/copper` in an iframe and sends OAuth users back to `/copper/oauth/callback`, and the browser needs a secure context for the microphone. For development, use a tunnel such as `cloudflared`.
- A Vobiz account with at least one active, voice-enabled number.
- A Copper account. Embedded apps (the Copper panel) need Copper's Business plan or higher. Agents connect Copper with a Copper API key and their email, or with OAuth if Copper has registered an OAuth app for you.

## Set up the backend

1. Install dependencies:

   ```bash
   npm ci --prefix backend
   ```

2. Copy the environment template and fill it in:

   ```bash
   cp backend/.env.example backend/.env
   ```

   `backend/.env` holds deployment settings only: the public URL, the Copper OAuth app's client id and secret if you have one, and two random secrets. It never holds a Vobiz Auth ID, Auth Token, number, SIP credential or a Copper API key.

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `PUBLIC_BASE_URL` | yes | The public `https://` URL of this backend |
   | `SIGNING_SECRET` | yes | 32+ random bytes; signs recording links |
   | `TOKEN_ENC_KEY` | yes | 32 random bytes as 64 hex characters; encrypts stored Copper OAuth tokens and API keys |
   | `VOBIZ_SIP_AUTH` | no | `jwt` (default): the softphone registers with a short-lived access token. `endpoint`: one SIP endpoint per agent with a password |
   | `VOBIZ_JWT_TTL_SECONDS` | no | Default `3600` (180 to 86400). Access-token lifetime; the softphone renews a minute before expiry |
   | `COPPER_CLIENT_ID`, `COPPER_CLIENT_SECRET` | for OAuth | The Copper OAuth app. Without both, agents connect with API keys |
   | `COPPER_ALLOW_API_KEYS` | no | Default `true`. With OAuth set up, `false` hides the API-key option |
   | `COPPER_ADMIN_EMAILS` | no | OAuth users who may change Settings, comma separated. API-key users are always admins |
   | `COPPER_FRAME_ORIGINS` | no | Default `https://app.copper.com`. Origins allowed to frame the Copper panel |
   | `PORT` | no | Default `8099` |
   | `DATA_DIR` | no | Default `backend/data`; endpoint ids, Copper accounts, panel links and encrypted credentials (mode 0600) |
   | `DEFAULT_COUNTRY` | no | Default `IN`; for numbers without a country code. Each Copper account can override it |
   | `RECORDING_LINK_TTL_SECONDS` | no | Default `900` |
   | `VOBIZ_WEBHOOK_SIGNATURES` | no | `require` (default), `verify` or `off`. Keep `require` in production |
   | `VOBIZ_MEDIA_HOSTS` | no | Default `*.vobiz.ai`. Hosts that may receive the Vobiz Auth ID and Token when recording audio is fetched |

   Generate each secret with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. Start it:

   ```bash
   npm start
   ```

4. Run exactly one instance. Sessions and Vobiz Auth Tokens live in memory, so after a restart agents sign in again.

### Connecting Copper: API key or OAuth

- **API key (works today).** A Copper admin generates a key under **Settings → Integrations → API Keys**. The agent enters the key and the email of the user who generated it. Copper attributes everything written with a key to the key's owner, so each agent should use a key generated for their own user. Because only admins can generate keys, a user connected with a key can change the calling Settings.
- **OAuth (for a hosted, multi-customer deployment).** Copper registers OAuth apps on request (developer.copper.com, "OAuth 2.0"). Give them the redirect URL `<PUBLIC_BASE_URL>/copper/oauth/callback`, put the client id and secret in `COPPER_CLIENT_ID` and `COPPER_CLIENT_SECRET`, and restart. The softphone then shows **Connect Copper**. Copper's OAuth tokens do not expire, and Copper sends the user back with a form POST, so the callback accepts POST. List the OAuth users who may change Settings in `COPPER_ADMIN_EMAILS`.

### Add the Vobiz panel to Copper (a Copper admin, once)

1. In Copper, open **Settings → Integrations**, scroll to the bottom and choose **Create an embedded app**.
2. Name: `Vobiz Calling`. URL: `<PUBLIC_BASE_URL>/copper`.
3. Add to: People, Leads and Companies. Locations: **Action Bar** (and **Sidebar** if you want the record's numbers on each record page).
4. Optional Advanced Configuration:

   ```json
   { "voip": true }
   ```

   `voip` makes every phone number in Copper clickable and sends the click to the panel. Without it, agents use the panel's number list or the dial box.

## Each agent

1. Open `<PUBLIC_BASE_URL>/phone` in its own tab and pin it. Closing the tab stops calls ringing.
2. **Connect Copper**: enter your Copper email and API key, or click **Connect Copper** (OAuth). Calls are logged under your name.
3. **Sign in to Vobiz** with your Auth ID and Auth Token from the Vobiz Console. The backend checks them with Vobiz, finds or creates its calling application in your account, and gives you your own calling identity. The softphone registers with a short-lived access token (JWT) that the backend asks Vobiz to sign for you and renews before it expires. The Auth Token stays in server memory and is never sent to the browser.
4. Pick a caller ID. To receive calls on a number, click **Enable inbound calls**. The softphone names the application the number is on now and asks before moving it.
5. In Copper, open the Vobiz panel from the action bar and click **Link to my softphone**. A small window opens, finds your softphone tab and links the panel. Do this once per browser. The softphone tab must be open and connected to Copper in the same browser profile, and the browser must allow pop-ups from Copper.

## Using it

- **Incoming call:** the softphone rings and shows the caller's Copper record, title, company and last calls. Click **Accept** (or press Enter).
- **Outgoing call:** click a phone number in Copper (with `voip` on), click **Call** next to a number in the panel, or type a number in the softphone. A number from Copper appears in the softphone as "Call +91… ?" and waits for you to click **Call**, so a stray click never places a call.
- **During a call:** Mute, Hold, Keypad (DTMF), and Transfer (inbound calls, to another signed-in agent).
- **After a call:** the Phone Call activity appears in the record's activity log. **Recent calls** in the softphone has **Play** (a freshly signed recording link).

## Settings

A Copper admin (anyone connected with an API key, or an OAuth user in `COPPER_ADMIN_EMAILS`) can change these in the softphone's Settings. Everyone else can read them.

| Setting | Default |
| --- | --- |
| Default country | `DEFAULT_COUNTRY` |
| Create a record for unknown numbers | On. Off: calls from unknown numbers are not logged, because Copper keeps every activity on a record |
| Unknown numbers become | A lead (or a person) |
| Create a "Call back" task for missed calls | On |
| Recording link lifetime | 15 minutes (5 minutes to 7 days). The link in the activity stops working when it expires |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Copper did not accept that email and API key" | Use the email of the Copper user the key was generated for, and copy the key again from **Settings → Integrations → API Keys**. |
| "Signed in elsewhere" | You signed in in another tab or browser. Use that one, or sign in again here. |
| The panel says "Open this inside Copper" | Open it from Copper's action bar. If it is in Copper, check `COPPER_FRAME_ORIGINS` matches the Copper address in your browser. |
| "Link to my softphone" finds no softphone | Open `<PUBLIC_BASE_URL>/phone` in the same browser profile, connect Copper there, then click **Try again**. |
| "The pop-up was blocked" | Allow pop-ups for Copper in the browser and click **Link** again. |
| Clicking a number in Copper does nothing | Add `{"voip": true}` to the embedded app's advanced configuration, and open the Vobiz panel once so it is loaded. |
| "Your softphone is not open, so … was not sent" | Open the softphone, sign in to Vobiz and wait for **Ready**. |
| No ringing on inbound calls | Click **Enable inbound calls** for the number, and check at least one agent is signed in. |
| "Vobiz would not issue an access token" | The account could not mint a JWT (`POST /Account/<Auth ID>/JWT/Token/`). Retry; if it persists, set `VOBIZ_SIP_AUTH=endpoint` to fall back to per-agent SIP endpoints. |
| "Registration failed" right after signing in | With access tokens, check the clock on the backend host: a token's `nbf` and `exp` are checked by the registrar. |
| Registration works but outbound calls fail at once | Check `<PUBLIC_BASE_URL>/vobiz/answer` is reachable from the internet and returns XML. Endpoint `sip_registered` is not a reliable health check. |
| Calls are not logged, "Reconnect Copper" | The key or token was revoked in Copper. Connect again; failed writes are retried for 24 hours. |
| Calls appear as Notes, not Phone Calls | The account's "Phone Call" activity type is disabled or renamed. Re-enable it under Copper's activity settings. |
| The recording link in Copper does not play | The link expired. Use **Play** in the softphone's Recent calls, or raise the link lifetime in Settings. |

## Limitations

- The softphone is a separate tab. Copper does not document microphone access for embedded apps, so the call cannot live in the panel.
- Click-to-call from Copper needs the panel linked to the softphone once per browser, and the softphone tab open. The agent confirms each call in the softphone.
- No "SIP direct" sign-in (an existing endpoint's SIP username and password). Without the account's Auth Token the backend cannot verify Vobiz's signed callbacks for those calls, or prove the agent owns the endpoint. Agents sign in with their Vobiz account.
- Copper activities have no direction or duration field. Both are in the activity's text, so Copper's own call reports do not count talk time.
- Recording links expire. Copper stores the text, not the audio.
- With "Create a record for unknown numbers" off, calls from unknown numbers are not logged anywhere in Copper.
- The Copper REST API does not report user roles. API-key users are treated as admins (only admins can create keys); OAuth users are admins only when listed in `COPPER_ADMIN_EMAILS`.
- Copper limits API calls to 180 a minute per user. A 429 is waited out once (up to 10 s) and then the write is retried later.
- After a backend restart, agents sign in again, and recording links cannot play until someone on that Vobiz account signs in. Panel links survive a restart.
- If nobody is signed in when a call comes in, it is refused politely and not logged.
- Transfer is blind and works on inbound calls only.
- Recording playback streams the file but does not support seeking (HTTP Range).

## Not yet proven on a live call

These are built and tested against a mock that follows Copper's Developer API reference and SDK docs, and need one live check each before they are called verified:

- Outbound and inbound audio, answer, hang-up, mute, hold, DTMF and transfer with a real Vobiz account.
- Access-token renewal past the first token's expiry. (The access-token sign-in is the same code as the Close integration, where it was verified live on a sub-account: the registrar accepts `X-Vobiz-Jwt` from JsSIP on REGISTER and outbound INVITEs, the `app` claim routes outbound calls to `/vobiz/answer`, and `<Dial><User>` rings the `<sub>_<Auth ID>` identity.)
- In `VOBIZ_SIP_AUTH=endpoint` mode, whether `{"app_id":"<id>"}` binds the endpoint (the backend verifies and falls back), whether `ParentAuthID` on inbound calls matches the number's owner, and in which form `X-VH-*` headers reach `/vobiz/answer` (both are accepted).
- Copper: the partial phone search on people, leads and companies against numbers stored in different formats; the Phone Call activity and task bodies; `PUT /activities/{id}` keeping the activity type.
- The Copper panel in a real Copper account: the `origin` and `instanceId` Copper passes, `phoneNumberClicked` with `voip: true`, `getContext()` returning the record's `phone_numbers`, and whether Copper's iframe allows the `/pair` pop-up.
- Copper OAuth with a registered OAuth app, including the form-POST callback.

## Development

```bash
npm test                # backend behaviour and security regressions (no network)
npm run lint            # syntax-check every .js, parse every .json
npm run check:secrets   # no credentials or real numbers in the tree
npm run tunnel          # cloudflared quick tunnel to port 8099
```

The tests boot the real server with `fetch` replaced by `backend/test/fetch-mock.cjs`, which simulates three Vobiz accounts (one a sub-account) and two Copper accounts: OAuth with a client secret and a form-POST callback, API keys in `X-PW-*` headers with the owner's email, `/users/me` and `/account`, partial phone search on people, leads and companies, per-account Phone Call activity types, activities and tasks with integer ids, and a 429 with `Retry-After`. Vobiz callbacks in the tests are signed the way Vobiz signs them, with signature checks on. The access-token tests check the claims Vobiz is asked to sign and that the browser only ever gets the signed token.

`public/lib/copper-sdk.min.js` is the unmodified `dist/copper-sdk.min.js` of `copper-sdk@0.9.1` from npm, served from this origin so the pages load no third-party script. Compare it with `npm pack copper-sdk@0.9.1` before upgrading.

## Security

- No route returns a SIP password or an access token, or lists accounts or endpoints, without a session token.
- An access token is minted only for the session's own identity (`sub` is a hash of the Copper account and user), lasts an hour by default, and is the only Vobiz credential the browser ever holds. Token requests are throttled per session.
- Vobiz Auth Tokens live in memory only. Copper OAuth tokens and API keys are stored encrypted (AES-256-GCM) in `DATA_DIR`, mode 0600, and are never sent back to the browser. They are only ever sent to `api.copper.com`; the OAuth client secret only to `app.copper.com/oauth/token`.
- The OAuth flow uses a state bound to the browser by an HttpOnly, Secure, SameSite=None cookie (Copper's callback is a cross-site POST), and hands the session to the page as a one-time code in the URL fragment.
- The Copper panel can be framed only by `COPPER_FRAME_ORIGINS`, and starts the Copper SDK only when the `origin` Copper passes is one of them: the SDK trusts that parameter for every message it sends and accepts. Every other page refuses to be framed.
- A panel link token can look numbers up and send a number to its own agent's softphone; nothing else, and it opens no softphone route. It is minted only by a signed-in softphone tab, reaches the panel by `postMessage` aimed at this origin only, is stored as a SHA-256 hash, expires after 90 days, and is revoked when the agent unlinks or disconnects.
- Copper ids are checked to be integers, and record types to be person, lead or company, before they go into a request.
- The API-key connect route, the only one that reaches Copper without a session, is limited to 10 tries a minute per client.
- Vobiz callbacks are verified with the token of the one account they belong to, worked out from server state, never from `ParentAuthID` or another field the sender chose. A used signature nonce is refused.
- Recording audio is fetched with redirects checked hop by hop; the Vobiz credentials go only to `VOBIZ_MEDIA_HOSTS`.
- Recording links are HMAC-signed over the account, the call and the expiry. They never carry credentials, and the backend only fetches audio URLs that Vobiz's own Recording API returns.
- No CORS headers are sent: every browser request comes from pages this server serves, the framed panel included.
