# Architecture

## Parts

```
 Agent's browser                                  Backend (one instance)                       Vobiz
 ┌───────────────────────────────┐  HTTPS +       ┌───────────────────────────────┐  REST       ┌───────────┐
 │ Softphone tab (/phone)        │ ─ Bearer ────▶ │ /api/*  sessions, sign-in,    │ ──────────▶ │ API       │
 │  JsSIP, caller ID, ring       │ ◀── SSE ────── │         access tokens (JWT)   │ ◀────────── │ webhooks  │
 │   ▲ BroadcastChannel          │   "dial" ▲     │ /vobiz/* answer, dial, hangup │             └─────┬─────┘
 │ /pair popup, /dial (tel:)     │          │     │ /recordings/* signed playback │                   │
 ├───────────────────────────────┤          │     │ /copper/oauth/* connect       │                   │
 │ Copper web app                │          │     │ /api/panel/* panel link token │                   │
 │  └ iframe: Copper panel       │ ─ Bearer ┘     └──────────────┬────────────────┘                   │
 │    (/copper, copper-sdk,      │  (panel token)  OAuth or API key (as the agent)                    │
 │     voip: phoneNumberClicked) │                               ▼                                    │
 └─────────────┬─────────────────┘                     api.copper.com/developer_api/v1                │
               │            SIP over WSS + media (never through the backend)                          │
               └───────────────────────── wss://registrar.vobiz.ai:5063/ ─────────────────────────────┘
```

The backend is the Close integration's design (`Vobiz-CloseCrm-Calling`, itself from Twenty and Help Scout) with the CRM side replaced: the Vobiz modules (`vobiz.js`, `vobiz-signature.js`, `routes-vobiz.js`), including the access-token sign-in, are the same code with names changed, and `copper.js` replaces `close.js`. In the shared code `wsKey` names the CRM tenant, which here is a Copper account.

## Sign-in

1. **Connect Copper**, one of two ways:
   - **API key.** `POST /api/identity/apikey` with the key and the email of the user who generated it. The backend checks the pair with `GET /users/me` and `GET /account` (headers `X-PW-AccessToken`, `X-PW-Application: developer_api`, `X-PW-UserEmail`), stores the key encrypted and returns a session token. Only Copper admins can generate keys, so a key user is an admin.
   - **OAuth** (when `COPPER_CLIENT_ID` and `COPPER_CLIENT_SECRET` are set). `/copper/oauth/start` sets a short-lived HttpOnly, Secure, SameSite=None cookie and redirects to `https://app.copper.com/oauth/authorize` with the client id, redirect URL, scope `developer/v1/all` and state. Copper returns with a form POST to `/copper/oauth/callback`, which checks the cookie against `state`, exchanges the code at `https://app.copper.com/oauth/token` with the client secret, and reads the user and account. Copper's access tokens do not expire and come with no refresh token; the token is stored encrypted. It redirects (303) to `/phone#link=<one-time code>`, which the page trades for a session token. An OAuth user is an admin when listed in `COPPER_ADMIN_EMAILS`.
2. **Sign in to Vobiz.** The agent's key is a hash of the Copper account and user (`cp` + 14 hex). The backend verifies the Auth ID and token with `GET /numbers` and finds or creates its application `Copper-Calling-Vobiz` (matched on `answer_url`). Then, by `VOBIZ_SIP_AUTH`:
   - **`jwt` (default): access tokens.** This is the access-token login of the Vobiz WebRTC reference (`vobiz-ai/Vobiz-RTC-demo`, "Access-token (JWT) login"), made per agent and per account. No endpoint is created. The agent's SIP identity is `<agent key>_<Auth ID>`, which Vobiz derives from a token's `sub` and `iss`. Sign-in mints one token to prove the account can issue them. The softphone then calls `POST /api/sip-token` for each token: the backend sends the claims (`iss` Auth ID, `sub` agent key, `nbf`, `exp`, `app` our application id, `per.voice` incoming and outgoing allowed) to `POST /Account/<Auth ID>/JWT/Token/`, and Vobiz signs them (HS256, `cty: auris;v=1`) with the Auth Token. JsSIP registers with no password and the token in an `X-Vobiz-Jwt` header (the header the Vobiz WebRTC SDK sends), sends the same header on every outbound INVITE, and fetches a new token a minute before `exp` and registers again. The `app` claim is what routes the agent's outbound calls to `/vobiz/answer`. Unlike the reference demo, there is no local-signing fallback: the Auth Token never signs anything on this server.
   - **`endpoint`: one SIP endpoint per agent.** The backend finds or creates the endpoint, reads the rewritten username back, rotates its password, and binds it with `{"app_id":"<id>"}` then verifies, falling back to `{"application": <integer>}`. `GET /api/agent` hands that password to the session that signed in.

There is no SIP-direct sign-in: without an account's Auth Token, callbacks about those calls could not be verified and endpoint ownership could not be proven.

## The Copper panel

Copper embedded apps are iframes on `app.copper.com`, loaded with `?location=…&origin=…&instanceId=…`. The `copper-sdk` posts to and accepts messages from the `origin` parameter without checking it, so `copper.js` first fetches `/copper/config` and starts the SDK only when `origin` is one of `COPPER_FRAME_ORIGINS` and the page is framed. The page's CSP `frame-ancestors` lists the same origins.

**Linking.** The browser keeps a framed page's storage apart from the same site opened as a tab, so the panel cannot see the softphone's session. The agent links it once:

1. The panel opens `/pair` in a popup (a click in the panel, so the browser allows it).
2. `/pair` posts `pair-request` on the same-origin `BroadcastChannel` `vobiz-copper-pair`.
3. A softphone tab connected to Copper calls `POST /api/panel-link` with its session and posts the token back on the channel.
4. `/pair` sends it to `window.opener` with `postMessage(…, location.origin)`, so only our own panel can receive it. The panel accepts it only from that popup, and keeps it in its own `localStorage`.

The backend stores `sha256(token)` with the agent and an expiry (90 days). The token opens `/api/panel/status`, `/api/panel/lookup` and `/api/panel/dial` only.

**Click-to-call.** With `{"voip": true}` in the embedded app's advanced configuration, Copper makes every phone number clickable and sends `phoneNumberClicked` to the panel. The panel posts the number to `/api/panel/dial`, which pushes a `dial` event down the agent's softphone event streams and says how many tabs got it. The softphone shows "Call +91… ?" and waits for the agent. The panel also lists the numbers of the record on screen (`getContext()`), each with a Call button that does the same.

## Calls

**Outbound.** The browser calls `sip:<number>@registrar.vobiz.ai` with `X-VH-Caller-ID` and `X-VH-Ref` headers (and `X-Vobiz-Jwt` when signed in with an access token). `/vobiz/answer` maps the SIP user to the agent, checks the caller ID belongs to that account, and returns `<Record>` then `<Dial callerId><Number>`.

**Which account a callback is about.** Every Vobiz callback is tied to one account from server state only: the call record for its `CallUUID`, else the agent's SIP user in `From`, else the signed-in account that owns the dialled `To` number. It is verified with that account's token alone, a `ParentAuthID` naming another account is refused, and each signature nonce is accepted once per URL.

**Inbound.** `/vobiz/answer` uses that account (the owner of the dialled number) and rings every signed-in agent of that account with `<Dial callerId="<DID>" callerName="<caller>"><User>…`. It pushes an `incoming` event to those agents' tabs. If nobody is signed in, it speaks a polite message and hangs up.

**Talk time** starts at `DialAnswer` on `/vobiz/dial-events`, and uses the B-leg duration from `DialHangup` when present. On an inbound `DialAnswer` the call moves to the answering agent's own Copper account, since one Vobiz account can serve several. `/vobiz/hangup` waits `LOG_SETTLE_MS` for late dial callbacks, then logs the call once.

**Transfer** (inbound only) redirects the caller's leg with the Transfer Call API to `/vobiz/transfer-xml`, which rings the target agent. The target is stored server side by CallUUID, never in the query string.

## Logging to Copper

One activity per call, written as the agent who handled it when they are connected, else as a connected admin of that Copper account, else any connected user:

- The record is found with `POST /people/search`, then `/leads/search`, then `/companies/search`, each with `{"phone_number": {"value": <last 10 digits>, "match": "partial"}}`. Copper's partial match finds numbers that end in those digits; every hit is then compared on the full E.164 number. With none, a lead (or person) is created, `Caller +91…`, unless Settings turn that off. The record is stored before the activity is written, so a retry never creates a second one.
- The account's "Phone Call" activity type id comes from `GET /activity_types` (cached a day per account; a Note, id 0, when it is missing or disabled).
- `POST /activities` with `parent {type, id}`, `type {category: "user", id}`, `activity_date` (call start, seconds) and plain-text `details`: direction and outcome, agent, talk time, customer number, Vobiz number, start time, call UUID and recording.
- A missed inbound call adds `POST /tasks` (`Call back +91…`, related to the record, assigned to the agent or the writer, status Open, priority High, due now). A task that fails is not retried; the activity is the record of the call.
- `RecordStop` stores the recording id with the call at once, then rewrites the activity's `details` with the signed link (`PUT /activities/{id}`). A call written after the recording arrived carries the link from the start.
- Each step's result is stored as soon as Copper returns it, so a retry only does what is missing. Every request has a 15-second deadline.
- 401 marks the user as needing to reconnect (Copper tokens do not refresh). 429 waits `Retry-After` (at most 10 s) and retries once. Failed writes are kept and retried for 24 hours.
- The softphone reports JsSIP `failed` and `ended` sessions. A report whose call never reached `/vobiz/answer` is logged on its own after a grace period, so no call is dropped.

## What lives where

| Data | Where | Lifetime |
| --- | --- | --- |
| Vobiz Auth Token | Memory, keyed by Auth ID | Until restart |
| Access token (JWT) | The agent's softphone tab, memory only | `VOBIZ_JWT_TTL_SECONDS` (default 1 hour), renewed before expiry |
| SIP password (`endpoint` mode) | Memory, in the agent's session | Rotated each sign-in |
| Softphone session token | Memory on the server; the tab's `sessionStorage` | 12 hours, or until sign-out |
| Copper OAuth token or API key | `DATA_DIR/store.json`, AES-256-GCM | Until the agent disconnects |
| Panel link token | Panel's `localStorage`; its SHA-256 in `DATA_DIR/store.json` | 90 days, or until unlinked or disconnected |
| Endpoint ids, Copper accounts, call records | `DATA_DIR/store.json` | Calls capped at 5000 |
