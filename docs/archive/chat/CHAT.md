# Community chat

> **Archived: community chat removed Oct 12, 2026 by owner.** Historical reference only. Last code: git tag `chat-final`.

Live at **https://app.greencat69420.com/chat** (also `greencat-app.vercel.app/chat`). One public room, off-chain, moderated.
No tokens are needed and nothing costs fees: posting uses the same free "Sign in with wallet" message signature as Points.

## Who can do what

| Who | Can |
|---|---|
| Anyone (no wallet) | Read the chat |
| Any wallet that signed in (Phantom, Solflare, MetaMask Solana, …) | Post, set a display name. Not holder-gated |
| Admin wallet `13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6` (same as the on-chain Config admin) | Everything above, plus delete any message, mute a wallet, ban, unban |

The admin list is the API env var `CHAT_ADMIN_WALLETS` (comma-separated). When it's unset, the default is the wallet above, so there's nothing to configure.
Admins can't mute or ban each other. Messages from an admin wallet show a lime **ADMIN** badge, and the welcome message shows **SYSTEM**.

## Rules the server enforces on every message

- Up to **300 characters**, plain text only. Control characters, zero-width characters and right-to-left override characters are removed, and line breaks become spaces.
  The web app renders messages as text, so HTML like `<script>` shows up as literal characters and never runs.
- **No links:** `http://…`, `www.`, `something.com/.xyz/.io/…` (about 130 common TLDs), `t.me`, `discord.gg`, `bit.ly`, IP addresses, and
  disguised forms like `site(dot)com`, `site[.]io`, `site dot com`. → "Links and website names aren't allowed in chat."
- **No contract or wallet addresses:** any base58 string of 32 or more characters is blocked unless it's the official mainnet $GC mint
  `G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump` or the Devnet test mint `9UCMEvY3mZNuLdnnDVvgEweCTKWkT2d436dPvAHANR59`
  (env `CHAT_ALLOWED_ADDRESSES`).
- **Slow mode (global, on by default at 10 s):** each wallet can post once every N seconds, and the whole room gets at most 20 messages
  per 10 s. → "Slow mode is on, try again in Ns." (or "…the chat is busy, try again in Ns." when the room cap is hit). The admin turns it
  on/off and sets N (1–3600 s) and the room cap in **/admin → Chat moderation → Slow mode**. Admin wallets are exempt. Under the message box
  everyone sees "🐢 Slow mode: 10s" and a countdown to their next message. The setting is stored in the DB (`chat_settings`), so it
  survives redeploys; with no saved setting the API uses env `CHAT_SLOW_MODE` (seconds, or `off`; default `10`),
  `CHAT_SLOW_MODE_GLOBAL_MAX` (20) and `CHAT_SLOW_MODE_GLOBAL_WINDOW_SEC` (10). Checked from the stored messages, so it holds across restarts
  and sign-ins. (Bug sweep 2026-10-07 CH-03: chosen instead of a $GC balance gate.)
- **Speed limit (always on, even with slow mode off):** 1 message every 3 seconds and 20 per minute per wallet, plus 60 requests per minute per IP. → "Slow down: wait N s…"
- **No repeats:** the same text from the same wallet within 2 minutes is rejected (case, spaces and punctuation are ignored, so "GM!!" counts as "gm").
- Muted and banned wallets get "You're muted until <time>" / "This wallet is banned from the chat." They can still read.

Display names: 2–20 letters, numbers, spaces, `_ - .`; unique (case-insensitive); no links or addresses. Names that could pass for
the team are reserved (anything with admin, mod, moderator, greencat, official, support, system, founder, owner, dev team…), except for
admin wallets. Each message keeps the name the poster had when they sent it, and the short wallet (`13ze…fyj6`) is always shown next to it,
so changing your name can't be used to impersonate someone in older messages.

## How to moderate (owner)

1. Open **/chat**, connect the admin wallet, and press **Sign in with wallet** (sign the message; it's free). Sign-in lasts 1 hour.
2. Every message now has **🗑 Delete**, **🔇 Mute 24h** and **⛔ Ban** buttons. Each asks you to confirm first.
   - **Delete** hides that one message for everyone.
   - **Mute 24h**: the wallet can't post for 24 hours, then it can again automatically.
   - **Ban**: the wallet can't post or change its name until you unban it. It also removes that wallet's messages from the last 24 hours.
3. **/admin → Chat moderation** lists everyone who is muted or banned, with **Unmute / Unban** (press twice to confirm). You can also mute
   (any number of hours) or ban a wallet by pasting its address there.

4. **/admin → Chat moderation → Slow mode**: shows On/Off and the current seconds. Change the numbers and press **Save**, or **Turn off** / **Turn on**.
   It takes effect within about 2 seconds for everyone.

Every delete, mute, ban, unban and slow-mode change is written to the `chat_mod_log` table (who, what, when).

## Technical notes

- API: `apps/api/src/chat/` (`filter.ts` text rules, `service.ts` storage and moderation, `routes.ts` HTTP). Tests: `apps/api/test/chat.test.ts`.
- Endpoints: public `GET /chat/messages?before=<id>&limit=<1..100>` (newest last, deleted ones excluded, includes `admins` and `slowMode`),
  `GET /chat/settings` (`{slowMode: {enabled, seconds}}`);
  with a SIWS session (`Authorization: Bearer`): `GET /chat/me` (includes `slowMode` and `nextPostAt`), `POST /chat/messages {body}`, `POST /chat/profile {displayName}` (`""` clears);
  admin only: `POST /chat/admin/delete {id}`, `/chat/admin/mute {wallet, hours, reason?}`, `/chat/admin/ban {wallet, reason?, purgeHours?}`,
  `/chat/admin/unban {wallet}`, `GET /chat/admin/sanctions`, `GET /chat/admin/slow-mode`,
  `POST /chat/admin/slow-mode {enabled?, seconds?, globalMax?, globalWindowSec?}`. A slow-mode rejection is
  `429 {error: "slow_mode", message, retryAfterMs, scope: "wallet"|"global"}`; a successful post returns `nextPostAt`.
- DB (migration `003_chat.sql`, applied automatically when the API starts): `chat_messages` (soft delete: `deleted`, `deleted_at`, `deleted_by`),
  `chat_profiles` (wallet → unique display name), `chat_sanctions` (one current mute/ban per wallet; `until` NULL = permanent), `chat_mod_log`.
  The migration adds one welcome message from the system. Migration `004_chat_slow_mode.sql` adds `chat_settings` (JSON per key) and
  allows `slow_mode` in `chat_mod_log`.
- The web page (`apps/web/src/app/chat/page.tsx`) polls every 4 s while the tab is visible. The API caches the newest page for 1.5 s, so
  many open tabs cost about one DB query per 1.5 s. No websockets.
- Rate limits are in memory, per API process. That's fine for the single Railway instance; if the API is ever scaled to more than one
  instance, move them to a shared store.
- Sessions are the existing SIWS JWT (1 h). Signing in on Points also signs you in for chat, and the other way round.

## Deploy record

- 2026-10-07 ~17:45 PT: API (`79f95c0`) deployed to Railway `greencat-devnet` / `greencat-api` with `railway up` from a `git archive`
  (migration `003_chat.sql` applied on start); web deployed to Vercel production (`app.greencat69420.com`, `greencat-app.vercel.app`).
  No new env vars, no new services, no extra cost.
- Live checks done with a throwaway box keypair signed in via SIWS from `app.greencat69420.com` (Chain ID devnet): read without sign-in,
  post (201), second post right away (429), link and `https://` (400 `link_blocked`), random address (400 `address_blocked`), official mint (allowed),
  repeat (409), 301 chars (400), admin endpoints as non-admin (403) and without session (401), CORS preflight from the custom domain.
  The test messages were then removed, leaving only the welcome message. Admin actions (delete/mute/ban/unban) are covered by
  `test/chat.test.ts` and were clicked through in a local build (screenshots `docs/chat/local-*`), not live.
- Screenshots: `docs/chat/live-*.png` (live site), `docs/chat/local-*.png` (local build with a read-only mock wallet: signed-in, admin and muted views).
- 2026-10-08 2:01 AM PT: API `bb2dc88` (slow mode, migration `004_chat_slow_mode.sql` applied on start) via `railway up` from a `git archive`; web at
  2:03 AM PT (Vercel production). Live: second post from a SIWS test wallet 5 s after the first → 429 `slow_mode` (test message id 7 left for the admin to delete).

## Limitations

- Filters stop the common scam patterns, not every possible trick (for example an address split by spaces, or a link spelled out in words).
  Admin deletes and bans are the backstop.
- No DMs, images, reactions or replies. There are no push notifications; the page updates by polling.
- Admin buttons only appear after signing in with the admin wallet. On-chain admin and chat admin are separate checks; both default to the same wallet.
