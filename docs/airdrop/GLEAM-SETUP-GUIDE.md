# GreenCat $GC Community Airdrop: Gleam setup guide (beginner, browser only)

> **Prepared Thu Oct 8, 2026 ~2:30 PM PT; revised ~5:45 PM PT for the Gleam Pro plan** (the owner signed up for **Pro**, not Hobby); **updated ~6:30 PM PT: Kick + Twitch follow steps** (the owner added both to the Terms on Oct 8). Step-by-step setup of the Gleam campaign for the airdrop announced **Wed Oct 14, 2026 (10:00 AM PT suggested)**. Everything is done in the browser at gleam.io. The owner signed up for Gleam Pro on Oct 8; nothing has been configured or posted yet. Gleam plans, prices and actions were checked on gleam.io on Oct 8, 2026 (Pro vs Business features re-checked ~5:30 PM PT) (sources at the end). Gleam changes its menus often, so if a button is named slightly differently, look for the closest match. **This is not legal advice.**
>
> Sources of truth: `docs/airdrop/TERMS-FINAL.md` (the Terms), `docs/LAUNCH-AIRDROP-PLAN.md` (the plan), `docs/airdrop/ANNOUNCEMENT-DRAFTS-2026-10-14.md` (the posts). The plan's Gleam table (section 3) was updated on Oct 8 to match this guide; this guide is the detailed, step-by-step version (see "What changed" below).

## In 30 seconds

- **Plan:** you're on Gleam **Competitions → Pro**. Expected price **$59/month billed monthly** (or $468/year = $39/month billed yearly), USD before tax. **Please confirm** what you were actually charged (Gleam → Account → Billing / your receipt email) and tell me.
- **What Pro improves here:**
    - The **Crypto Wallet Address** step (Pro and above) collects the Solana address and **refuses an address that someone else already used**. Gleam has no Solana address type, so the step uses the **"Other"** type (any format accepted).
    - The **same step type can be used up to 5 times** (Hobby: 2), so nothing has to be squeezed together.
    - The **Visit** step can make people wait a few seconds or **ask a question after the visit**, which gives an Instagram fallback without an extra step.
    - **Users tab export**: every entrant with all the social accounts they logged in with. This helps the one-wallet-per-person (Sybil) check.
    - **Confirmation email** to each entrant listing the steps they completed and reminding them of the rest (on by default).
    - **Landing page branding** (logo, background, feature image) and a **post-entry redirect** (optional).
- **Still not available on Pro (all Business, $179/month), and the workaround:**
    - **Rejecting badly formatted addresses** (Question validation and Custom "Format" regex). → Clear instructions on the form; invalid addresses are dropped when we clean the list.
    - **Telegram membership check.** → The Telegram step still logs people in with Telegram; membership is spot-checked by hand.
    - **Importing Instagram comments / X replies.** → Instagram handle + manual check; X reply link pasted by the entrant.
    - **Hiding the end date** (custom CSS). → Placeholder end date plus one line in the description.
- **Not available on any plan:** Follow on X (retired; → Visit a Page), YouTube Subscribe/Like (removed for YouTube's policy; → Visit a Channel + Custom step), TikTok like/share/comment (→ Custom step), Like on X (→ part of the reply-link step).
- **No "open-ended" option:** Gleam always needs an end date, but you can change it any time, even while live. Set a far placeholder now and change it to the real end (snapshot + 30 days) the day the snapshot is announced.
- **Kick and Twitch follows (added to the Terms by the owner on Oct 8):**
    - **Twitch:** Gleam's **Follow a Channel on Twitch** step (Hobby and above, so on Pro). The entrant logs in with Twitch, follows, clicks Continue, and **Gleam checks the follow** before giving the entry.
    - **Kick:** Gleam does have a **Follow on Kick** step, but Gleam says it has no access to Kick's API, so it can't check follows, and its docs don't say it records the entrant's Kick username. So this guide uses **Visit a Page** + **"Ask a Question" after the visit** (Pro) to record the Kick username for spot-checks.

---

## 1. Your plan: Pro (confirm the price)

### Prices (Gleam Competitions, USD, before tax; checked Oct 8, 2026)

| Plan | Billed monthly | Billed yearly | What it adds that matters here |
|---|---|---|---|
| Free | $0 | $0 | No entry-data export, no custom Terms. Not usable for us. |
| Hobby | $29/month | $120/year (= $10/month) | Custom Terms, entry-data CSV export, most social steps. Same step max 2× (monthly). **No Crypto Wallet step.** |
| **Pro (what you have)** | **$59/month** | **$468/year (= $39/month)** | Everything in Hobby, plus: **Crypto Wallet Address** step, same step up to **5×** (10× yearly), Visit step delay/question, **Users tab export**, confirmation emails, landing page branding, post-entry redirect, restrict by country, up to 50 winners (monthly). |
| Business | $179/month | $1,428/year (= $119/month) | Answer validation (regex), Telegram membership tracking, Instagram comment import, X reply import, hide end date (custom CSS), fraud-filter tuning, custom emails. **Not needed.** |

Where the numbers come from: Gleam's own comparison article and an independent pricing tracker (checked Sep 30, 2026) agree on these figures. Gleam's pricing page loads its prices with a script, so I couldn't read them directly. **Confirm the amount on your receipt**; if it isn't $59/month (or $468/year), tell me.

**Monthly or yearly?** Monthly is right for now: you can cancel any time, and nobody knows how long it takes to reach 1,000 wallets with 100,000+ $GC (44 counted on Oct 7). Yearly ($468 once) only pays off if the campaign runs **8 months or longer** (8 × $59 = $472).

**Cost estimate:** $59 for every month from today (Oct 8) until the final export at snapshot + 30 days. Example: milestone after 6 weeks → snapshot a week later → hold ends ~30 days after that → about 3 months ≈ **$177**. After the final export you can **downgrade to Free or cancel**: Gleam keeps the data of campaigns run on a paid plan (export first anyway).

**Is Pro worth it vs Hobby?** The wallet step with duplicate blocking, the Users export (all social accounts per entrant, useful against multi-wallet entries) and the extra room (5× per step) make the setup cleaner. Pro does **not** check that an address is a real Solana address; our scripts do that.

### After signing up (5 minutes)

1. Turn on two-step login (2FA) in your Gleam account settings if it's offered.
2. **Site → Settings → Default Social Profiles**: fill in X `GreenCatCrypto`, Instagram `greencat69420`, TikTok `greencat69420`, YouTube `@greencat69420`, Twitch `greencat_69420`, Kick `greencat69420` (if listed), so new steps pre-fill.
3. Optional: **Site → Settings**: upload the GreenCat logo / mascot (Pro branding).

---

## 2. Have these ready before you build

| What | Value |
|---|---|
| Campaign title | GreenCat $GC Community Airdrop |
| X profile | https://x.com/GreenCatCrypto |
| YouTube channel | https://youtube.com/@greencat69420 |
| TikTok profile | https://www.tiktok.com/@greencat69420 |
| Instagram profile | https://www.instagram.com/greencat69420 |
| Telegram (official short link) | https://t.co/FB6bJuJYJi → opens **https://t.me/+nSvzl3fx33FhZDcx** (private group "GreenCat69420", checked Oct 8) |
| Twitch | https://www.twitch.tv/greencat_69420 (channel name `greencat_69420`) |
| Kick | https://kick.com/greencat69420 |
| Discord (official short link) | https://t.co/YrIyfoyQWk → opens **https://discord.gg/brtY3TsTM9** ("DaGreenCat's server"; checked Oct 8: this invite **never expires**) |
| CA | `G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump` |
| Terms text | `docs/airdrop/TERMS-FINAL.md` (stop before "Changelog"); also in **Appendix A** below |
| Placeholders you fill in on Oct 14 | `[X TERMS POST URL]` (your pinned Terms post on X), `[X POST URL]`, `[YT POST URL]`, `[TIKTOK POST URL]`, `[IG POST URL]` (the four designated airdrop posts) |

Gleam needs the real Telegram and Discord addresses (t.me / discord.gg), not the t.co short links, so use the bold ones above. They are the same destinations as the official short links.

---

## 3. Campaign settings (Setup tab)

Click **New Competition** (if Gleam offers "Objective Packs" or templates, skip them and start blank).

### 3a. Title

```
GreenCat $GC Community Airdrop
```

### 3b. Dates and time zone

- **Time zone:** Pacific Time (shown as "America/Vancouver", "America/Los_Angeles" or "Pacific Time (US & Canada)"; any of these is fine). Gleam shows every date to entrants in this zone and handles the Nov 1 clock change.
- **Starts:** **Wed Oct 14, 2026, 10:00 AM**. The campaign opens by itself at that time.
- **Ends:** Gleam has **no "no end date" option**: every competition needs one. You can change it at any time (extend or shorten), even while it's live. So:
    - **Now:** set a far placeholder: **Wed Apr 14, 2027, 11:59 PM** (6 months; use the calendar picker, the quick buttons only go to 3 months).
    - **The day the snapshot time is announced:** change **Ends** to **snapshot + 30 days** (the end of the hold, which is also the social-task deadline in the Terms). Example: snapshot Mon Dec 7, 2026 10:00 AM PST → Ends Wed Jan 6, 2027 10:00 AM PST.
    - **If the milestone still hasn't come by mid-March 2027:** extend the end date again before Apr 14 (put a reminder in your calendar for **Mar 31, 2027**). If the end date passes, the widget stops taking entries.
    - The end date shows on the page (hiding it needs Business), which is why the description below says it's a placeholder.

### 3c. Prize

- **Prize name:** `Equal share of the 100,000,000 $GC airdrop pool (up to 1,000 qualifying wallets)`
- **Prize value:** leave **empty** (the Terms say $GC may have no value; don't put a dollar figure).
- **Number of winners:** Gleam asks for a number and caps it by plan (Pro monthly: 50). Put the **highest number it accepts**. Gleam is **not** used to pick anyone: who gets a share follows the Terms (snapshot, hold, checks, top 1,000 by balance), done outside Gleam. **Never press "Draw Winners".** If the preview shows a winner count that looks confusing next to "up to 1,000 wallets", tell me and we'll adjust the wording.

### 3d. Description (paste as is, then fill in the one placeholder)

```
🐱💚 GreenCat $GC Community Airdrop

100,000,000 $GC will be split equally among up to 1,000 qualifying wallets.

⏳ Snapshot: 7 days after 1,000 unique wallets each hold at least 100,000 $GC. The exact snapshot time will be announced on our official X, Telegram and Discord.

✅ To qualify (every step is required):
1. Hold at least 100,000 $GC in your own Solana wallet at the snapshot.
2. Keep at least 100,000 $GC in that wallet for 30 days after the snapshot. If it drops below 100,000 at any moment, the wallet is out. Adding more is fine.
3. Follow GreenCat on X, YouTube, TikTok, Instagram, Kick and Twitch.
4. Like, repost/share and comment "airdrop" on our airdrop post on X, YouTube, TikTok and Instagram (one post on each).
5. Join our Telegram group and Discord server.
6. Complete every step below, including your Solana wallet address.

Deadline for the social steps: the end of the 30-day hold after the snapshot.

🏆 If more than 1,000 wallets qualify, the top 1,000 by $GC balance at the snapshot each get an equal share. If fewer qualify, the 100M is split evenly among all who do. One wallet per person. Multiple wallets, bots or fake accounts are disqualified. GreenCat team wallets are not eligible.

This page only collects entries; there is no random draw. Distribution timing and method will be announced on official channels after the hold period and checks. The end date shown here is a placeholder and will be updated when the snapshot time is announced.

📜 Full Terms: see pinned Terms post ([X TERMS POST URL]) and the Terms & Conditions on this page. Taking part means you agree to them.

CA: G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump

🚨 Only official channels; we never DM first. Never share your seed phrase. $GC is a meme token with no promise of value. This airdrop is not sponsored, endorsed or administered by, or associated with, X, YouTube, TikTok, Instagram, Kick, Twitch, Telegram or Discord.
```

Wording rule (from the plan): the public text states the requirements only. Don't add anything about which steps are checked, "verified", "automatic" or "honor system", and no price or return talk.

### 3e. Terms & Conditions field ("see pinned Terms post" + X link)

1. Setup tab → **Terms & Conditions** → **Customize Terms & Conditions** (Hobby and above).
2. Delete Gleam's generated text and paste **the block in Appendix A** (it starts with the "see pinned Terms post" line and the `[X TERMS POST URL]` placeholder, then the full Terms text, unchanged).
3. On Oct 14, after the Terms post is pinned on X, replace `[X TERMS POST URL]` with its link (e.g. `https://x.com/GreenCatCrypto/status/...`).
4. If Gleam also offers a field to **link to your own terms** instead of pasting them, still paste the full text (people shouldn't have to leave the page to read it) and put the X Terms post link in the first line as shown.

Note: custom Terms replace Gleam's default text, which includes standard "not associated with Instagram/YouTube" wording. Our description says it instead (last line above).

### 3f. Entrant login / user details

Keep Gleam's default sign-in (name + email). Don't add extra personal-data fields (age, country, phone): the Terms don't ask for them.

**Locations (Pro):** Gleam can include/exclude countries (User Details → Allowed Locations). The Terms only say "void where prohibited" and name no countries, so **leave it open worldwide** unless you decide specific countries to block (then tell me, so the Terms and the setting match).

### 3g. Look of the page (optional)

Install → Landing Page Styling (Pro): add the GreenCat logo, a dark-green background or a mascot background image (wider than 1280 px, under 500 KB), and a mascot **feature image** for the prize. No price talk in images.

### 3h. After-entry settings (Post Entry tab, Pro)

- **Post-Entry Confirmation Email:** on by default on Pro. It emails each entrant a summary of the steps they completed and reminds them of the ones left. **Leave it on** (it helps people finish every step). You can't change its wording on Pro (custom emails are Business).
- **Post Entry Redirect:** optional. If you use it, send people to the pinned Terms post on X (`[X TERMS POST URL]`). Fine to leave off.
- **Viral Share / referral links:** don't use (it rewards bringing in more accounts, which fights the one-wallet-per-person rule).

---

## 4. The entry actions, in order ("How to Enter" / Actions)

**For every step:** turn **Mandatory ON** (the Terms require every step), **entries = 1**, **entry interval = once** (not daily). Equal shares mean entry counts don't matter, only whether each step is done. The **Gleam type** column is what to pick from the action list.

**Fill the four post links on Oct 14** (section 7) before 10:00 AM: until then they're placeholders.

### Step 1. Solana wallet address

- **Gleam type:** **Crypto Wallet Address** (Pro and above).
- **Address Type:** **Other** (Gleam's list has only ETH/BEP-20, BTC, BEP-2 and Other; there is **no Solana type**, and "Other" accepts any text format).
- **Accept Duplicate Addresses: OFF** (the default: each address can be used by only one entrant).
- **Title:**

```
Your Solana wallet address (the wallet that holds 100,000+ $GC)
```

- **Placeholder:** `Your Solana address (32-44 characters)`
- **Description:**

```
Paste the public address of your own self-custody Solana wallet (Phantom, Solflare, Backpack...) that holds, or will hold, at least 100,000 $GC. Solana only (not an Ethereum 0x... address). Not an exchange deposit address, and not a .sol name. One wallet per person. A Solana address is 32 to 44 letters and numbers. Double-check every character before you submit. NEVER paste your seed phrase or private key here or anywhere.
```

- See section 5 for the validation tips.

### Step 2. Follow on X

- **Gleam type:** **Visit a Page** (Gleam's "Follow on X" is retired on every plan).
- **Title:** `Follow @GreenCatCrypto on X`
- **Link URL:** `https://x.com/GreenCatCrypto`
- **Button text:** `Open @GreenCatCrypto`
- **After visiting:** Click Continue to Complete. (Pro also offers a delay or a question here; not needed, because the X login in step 3 already records the entrant's X account.)

### Step 3. Repost the X airdrop post

- **Gleam type:** X (Twitter) → **Repost** (may be called "Retweet").
- **Post URL:** `[X POST URL]` (post 1 of the X thread, which doubles as the designated X post).
- **Title** (if editable): `Repost our X airdrop post`
- **Reject Throwaway Accounts: ON.**
- Entrants log in with X here, so Gleam records their X account.

### Step 4. Like + comment "airdrop" on X

- **Gleam type:** **Submit URL**.
- **Title:** `X: like our airdrop post and reply "airdrop", then paste your reply's link`
- **Instructions:**

```
1. Open our X airdrop post: [X POST URL]
2. Like it.
3. Reply to it with the word: airdrop
4. On your reply, tap Share → Copy link, and paste that link here.
```

- **Placeholder:** `https://x.com/yourname/status/...`
- **Domain Restriction:** `x.com`
- **Accept Duplicate URLs:** OFF.

### Step 5. YouTube channel

- **Gleam type:** YouTube → **Visit a YouTube Channel**.
- **Channel URL:** `https://youtube.com/@greencat69420` · **Channel Name:** `GreenCat` (use the exact name shown on the channel)
- **Title:** `Visit GreenCat on YouTube`
- **Require Authentication: ON** (entrants log in with YouTube, so Gleam records their channel).

### Step 6. YouTube subscribe + like, share, comment "airdrop"

- **Gleam type:** **Custom Action**.
- **Title:** `YouTube: subscribe, then like, share + comment "airdrop" on our airdrop video`
- **Instructions:**

```
1. Subscribe to GreenCat on YouTube: https://youtube.com/@greencat69420
2. Open our YouTube airdrop video: [YT POST URL]
3. Like it, share it, and comment the word: airdrop
4. Type the YouTube @handle you used below.
```

- **Verification method (After Visiting):** **Ask a Question** → question: `Your YouTube @handle`

> **Caution (YouTube):** Gleam deliberately removed its Subscribe/Like actions and says its channel action "doesn't reward subscribing", because YouTube's Fake Engagement policy forbids rewarding subscribes, likes and comments. The Terms require these steps, so this setup states them in a Custom action. The plan (section 10) already lists YouTube as the biggest platform risk (possible channel strike) and the owner accepted it. Gleam's own terms also make the organizer responsible for each platform's rules. If you'd rather lower that risk, the only real fix is changing the Terms' YouTube requirement before Oct 14; tell me and I'll update the Terms, posts and this guide.

### Step 7. Follow on TikTok

- **Gleam type:** TikTok → **Follow on TikTok**.
- **Username:** `greencat69420`
- Entrants visit the profile and sign in with TikTok, so Gleam records their TikTok account.

### Step 8. TikTok like, share + comment "airdrop"

- **Gleam type:** **Custom Action**.
- **Title:** `TikTok: like, share + comment "airdrop" on our airdrop video`
- **Instructions:**

```
1. Open our TikTok airdrop video: [TIKTOK POST URL]
2. Like it, share it (Share → Repost, or share it to a friend/app), and comment the word: airdrop
3. Type the TikTok @username you used below.
```

- **Verification method:** **Ask a Question** → question: `Your TikTok @username`

### Step 9. Follow on Instagram

- **Gleam type:** Instagram → **Follow** (Follow on Instagram).
- **Username:** `greencat69420`
- Entrants visit the profile, then type their Instagram username.
- **If "Follow" isn't in the Instagram list** (Gleam's plan lists don't name it, though Gleam brought it back in 2025): use **Visit a Page** with link `https://www.instagram.com/greencat69420`, title `Follow @greencat69420 on Instagram`, and **After Visiting → Ask a Question** (Pro): `Your Instagram @username`.

### Step 10. Instagram like, share + comment "airdrop"

- **Gleam type:** Instagram → **Comment** (Comment on Instagram; Gleam's changelog says Free plan and above).
- **Post URL:** `[IG POST URL]`
- **Title** (if editable): `Instagram: like, share + comment "airdrop" on our airdrop post`
- Entrants open the post, comment, then type their Instagram handle.
- **If "Comment" isn't in the list:** use a **Custom Action** (custom step 3, fine on Pro) with the same title, the post link in the instructions, and **Ask a Question**: `Your Instagram @username`.

### Step 11. Follow on Twitch

- **Gleam type:** Twitch → **Follow a Channel** (Follow on Twitch; Hobby and above).
- **Channel:** `greencat_69420` (https://www.twitch.tv/greencat_69420)
- **Title** (if editable): `Follow GreenCat on Twitch`
- Entrants log in with Twitch, follow in a new window, come back and click Continue; Gleam checks the follow before giving the entry. If Twitch's own login hiccups (Gleam mentions occasional "401" login errors), entrants just try again.

### Step 12. Follow on Kick

- **Gleam type:** **Visit a Page** (visit step 2 of up to 5).
- **Title:** `Follow GreenCat on Kick`
- **Link URL:** `https://kick.com/greencat69420`
- **Button text:** `Open GreenCat on Kick`
- **After Visiting:** **Ask a Question** (Pro) → `Your Kick username`
- Why not Gleam's own **Follow on Kick** step: Gleam says it has no access to Kick's API yet, so it can't check the follow either, and its docs don't say it records the entrant's Kick username. Visit + question always gives us the username to check. (If you open Follow on Kick in the editor and its preview clearly asks entrants for their Kick username, it's fine to use that instead; tell me which one you used.)

### Step 13. Join Telegram

- **Gleam type:** Telegram → **Join Channel/Group**.
- **Channel/Group type:** Private group (pick "Private" if the list differs).
- **Share link:** `https://t.me/+nSvzl3fx33FhZDcx`
- **Title** (if editable): `Join the GreenCat Telegram group`
- **Tracking options:** leave off (checking membership needs Business).
- Entrants log in with Telegram, so Gleam records their Telegram account.

### Step 14. Join Discord

- **Gleam type:** Discord → **Join a Server**.
- **Invite link:** `https://discord.gg/brtY3TsTM9` (never-expiring; if you ever make a new one, set it to never expire).
- **Title** (if editable): `Join the GreenCat Discord server`
- Entrants log in with Discord.

### Count check (Pro allows each step type 5 times; 10 on yearly)

Crypto Wallet 1 · Custom Action 2 (3 with the Instagram fallback) · Visit a Page 2: X + Kick (3 with the Instagram fallback) · X Repost 1 · Submit URL 1 · YouTube Visit 1 · TikTok Follow 1 · Instagram Follow 1 · Instagram Comment 1 · Twitch Follow 1 · Telegram 1 · Discord 1. **Well within the limit** (the most-used type is at 3 of 5). Don't add a "Terms agreed" question: Gleam already shows the Terms on the page.

### Kick and Twitch: follow only

The Terms (as updated by the owner on Oct 8) require **following** GreenCat on Kick and Twitch. There is **no designated airdrop post** on Kick or Twitch: the like/repost/comment "airdrop" steps stay on the **four** posts (X, YouTube, TikTok, Instagram).

---

## 5. The wallet step: what Pro checks and what it doesn't

- **Solana:** Gleam's Crypto Wallet step has no Solana type; **"Other" accepts any format**. Gleam also says wallet fields are **not validated on-chain**.
- **Format check:** Pro **can't** reject a badly formatted address. Pattern checks exist only on **Business** (Question "Validate Answers" and Custom "Format"), and not on the Crypto Wallet step at all. So people may still paste typos, Ethereum addresses, exchange addresses, .sol names or even seed phrases.
- **What Pro does give you:** **duplicate blocking** (Accept Duplicate Addresses OFF): the same address can't be entered by two Gleam accounts. It doesn't stop one person using two addresses; that's the Sybil check.
- **What protects us otherwise:** the cleaning step after the hold (plan section 5) rejects invalid, duplicate, program/PDA and excluded (team) addresses, and the hold check only counts real wallet balances. The Users export (Pro) helps spot one person behind several entries.
- **The description does the rest:** what a Solana address looks like (32-44 characters), "own self-custody wallet", "not 0x...", "not an exchange", "not a .sol name", and **never paste a seed phrase**.
- **If someone pastes a seed phrase or private key:** delete that entry in the Actions tab, don't copy it anywhere, and post a general reminder in Telegram/Discord ("never paste your seed phrase anywhere; we never DM first"). Don't DM the person.
- **Changing a wallet later:** the Terms don't cover it. Decide a policy before someone asks (e.g. "the address in your Gleam entry is the one we use"), and never handle changes in DMs.
- **For reference only** (Business, not Pro): the Solana address pattern is `^[1-9A-HJ-NP-Za-km-z]{32,44}$`.

---

## 6. Get the link, share it, embed it

1. **Save** the campaign. Open the **Promote** tab (or **Install** → **Hosted Landing Page**): it shows the campaign's landing page link (it looks like `https://gleam.io/xxxxx/greencat-gc-community-airdrop`) and a **QR code**.
2. That link is the **`[ENTRY LINK]`** in `docs/airdrop/ANNOUNCEMENT-DRAFTS-2026-10-14.md`: paste it into the X thread (post 4), the Telegram/Discord announcement, the YouTube description, and the IG/TikTok captions where they say `[ENTRY LINK]`.
3. **TikTok and Instagram:** captions say "Enter: link in bio", so put the Gleam link in both **bios** on Oct 14 (before posting).
4. **Telegram and Discord:** the link goes in the pinned announcement message.
5. **Website (optional):** Install → **Embed in a Page or Blog Post** gives a code snippet for greencat69420.com. Website edits are a code change: tell me and I'll do it; you don't need to touch code.
6. **Skip** these Promote-tab ideas for this campaign: "Submit to contest promotion websites" (brings giveaway hunters and bot farms), "Email your competition subscribers" (no list yet), Viral Share (see 3h).
7. Don't share the link publicly before Oct 14 10:00 AM.

---

## 7. Oct 14 timing (so the post links are in Gleam before it opens)

The four designated posts must exist before their links can go into steps 3, 4, 6, 8 and 10, and Gleam opens by itself at 10:00 AM. Suggested order (same order as the drafts file):

| Time (PT) | Do |
|---|---|
| By Tue Oct 13 | Campaign fully built and saved with placeholders; I review it (send me the landing page link or screenshots of each action). Terms post can be published and pinned on every platform already. |
| Oct 14, ~9:15 AM | Terms post pinned everywhere (if not done Oct 13). Fill `[X TERMS POST URL]` in the description and the Terms field. |
| ~9:30-9:45 AM | Publish the YouTube, TikTok and Instagram airdrop posts and the X thread (its post 1 is the X airdrop post). Put the Gleam link in the TikTok + Instagram bios. |
| ~9:45-9:55 AM | Paste the four post links into Gleam (steps 3, 4, 6, 8, 10) and **Save**. Open the landing page in a private browser window and click each link once to be sure it opens the right post. |
| 10:00 AM | Gleam opens automatically. Post the Telegram + Discord announcement and pin it. |

The entry link in posts made a few minutes before 10:00 shows a short "starts soon" countdown, which is fine. If you'd rather post everything at exactly 10:00, set **Starts** to 10:15 AM instead.

---

## 8. While it runs

- **Weekly (optional):** Actions tab → **Export** (CSV), plus **Users tab → Export Users** (Pro: each entrant with every social account they logged in with). Send me both, so I can start cleaning early.
- **The day the milestone is hit** (the counter tells us; snapshot S = milestone + 7 days): post the milestone template from the drafts file, then in Gleam change **Ends** to **S + 30 days** and add one line at the top of the description: `📸 Snapshot: [Day, Mon DD, YYYY, HH:MM AM/PM PT]. Social steps due by [S + 30 days, PT].`
- **Never press "Draw Winners"**, and don't announce winners from Gleam.
- **If the Terms change** (the Terms allow it): update the Gleam Terms field and description the same day you re-pin the new Terms post.
- **At S + 30 days:** the campaign closes on its own. Do the **final export** (Actions tab → Export **and** Users tab → Export Users) and send both to me. **Export Users before downgrading**: the Users tab disappears on lower plans. Then downgrade or cancel (Gleam keeps the campaign's entry data, but export first anyway).
- The claim window (30 days once claims open) is announced later in the claim post, not on the Gleam page (same as the Oct 14 drafts).

---

## 9. What Gleam can and can't check (INTERNAL: never post this)

This is for you and me only. Public posts and the Gleam page state the requirements and never say which ones are checked. Pro doesn't change any row except the wallet (and the Kick question, which uses Pro's visit question); the platforms' own limits (X, Instagram, TikTok, YouTube APIs) are the same on every plan.

| Step | What Gleam itself confirms | What it doesn't (spot-checked by hand, plan section 5) |
|---|---|---|
| 1 Wallet (Crypto Wallet, "Other") | Records the address; refuses an address already used by another entrant | Format, that it's Solana, ownership, balance → our scripts |
| 2 X follow (Visit) | That the entrant clicked the link | The follow |
| 3 X repost | X login (the account), click-through | The repost (Gleam: all X actions "manual verification required") |
| 4 X like + reply (Submit URL) | A link on x.com was pasted, no duplicate links | The like; that the reply says "airdrop" (open the link) |
| 5 YouTube visit | YouTube login (the channel), the visit | The subscribe |
| 6 YouTube custom | Records the @handle | Subscribe, like, share, comment |
| 7 TikTok follow | TikTok login, profile visit | The follow (TikTok has no API for it) |
| 8 TikTok custom | Records the @username | Like, share, comment |
| 9-10 Instagram | Profile/post visit, records the handle | Follow, like, share, comment (Instagram API; comment import is Business) |
| 11 Twitch follow | Twitch login (the account) **and the follow itself** (Gleam checks it before giving the entry) | That they're still following later (unfollows after entering) → spot-check |
| 12 Kick follow (Visit + question) | That the entrant clicked the link; records the Kick username they typed | The follow (Gleam has no Kick API access) → spot-check the channel's followers |
| 13 Telegram | Telegram login (the account) | Membership (tracking is Business only) → member list |
| 14 Discord | Discord login; Gleam doesn't list this action as needing manual checks, which suggests it checks the join after login | Still spot-check the server member list |
| Whole entry | One entry per Gleam login; Gleam's default fraud filter flags suspicious entries; X "Reject Throwaway Accounts"; Users export lists every account per entrant | Sybil clusters, bots → cleaning step |

---

## 10. What changed

**Oct 8 ~6:30 PM PT (Terms change by the owner):** new steps 11 (Follow on Twitch, checked by Gleam) and 12 (Kick: Visit a Page + Kick username question); Telegram/Discord are now steps 13/14; description task list and disclaimer include Kick and Twitch; Appendix A regenerated from the updated TERMS-FINAL.

**vs the first version of this guide (Hobby, Oct 8 ~2:30 PM PT):** wallet step is now the Crypto Wallet Address step ("Other", duplicates blocked) instead of a free-text question; step-type limit 5 instead of 2, so the Instagram fallbacks are simple; new Post Entry settings (confirmation email on, no viral share); Users export added to the weekly/final exports; price $59/month.

**vs the plan's earlier Gleam table** (`docs/LAUNCH-AIRDROP-PLAN.md` section 3 has now been updated to match this guide): Follow on X is retired (→ Visit a Page); X Entry not needed separately (the Repost step logs them in with X); YouTube Subscribe doesn't exist (→ Visit a Channel + Custom step); native Instagram Follow/Comment used; Telegram/Discord use the resolved t.me / discord.gg links (Discord invite confirmed never-expiring); subscription started **Oct 8** (Pro) instead of Oct 13 (Hobby).

---

## 11. Checklist

**Today / this week**
- [x] Gleam account created on **Competitions → Pro** (Oct 8)
- [ ] Confirm the charge is **$59/month** (or $468/year) and tell me
- [ ] 2FA on (if offered); default social profiles filled
- [ ] New competition: title, **Pacific Time**, starts **Wed Oct 14, 2026 10:00 AM**, ends placeholder **Wed Apr 14, 2027 11:59 PM**
- [ ] Prize name pasted, value empty, winners = highest allowed (never draw)
- [ ] Description pasted (section 3d)
- [ ] Custom Terms pasted (Appendix A)
- [ ] Locations left worldwide; logo/background added (optional); Post Entry: confirmation email on, no viral share
- [ ] 14 steps added in order (incl. step 11 Twitch, step 12 Kick), **all Mandatory**, entries 1, interval once
- [ ] Step 1: Crypto Wallet Address, type **Other**, **Accept Duplicate Addresses OFF**
- [ ] Step 12 (Kick): After Visiting → Ask a Question `Your Kick username`
- [ ] Step 3: Reject Throwaway Accounts ON · Step 4: domain `x.com`, duplicates OFF · Step 5: Require Authentication ON
- [ ] Telegram link `https://t.me/+nSvzl3fx33FhZDcx`, Discord link `https://discord.gg/brtY3TsTM9`
- [ ] Saved; landing page link copied into the drafts as `[ENTRY LINK]`
- [ ] Send me the landing page link / screenshots for review by **Tue Oct 13**

**Oct 14 (section 7)**
- [ ] Terms post pinned everywhere; `[X TERMS POST URL]` filled in the description + Terms field
- [ ] Four designated posts up; links pasted into steps 3, 4, 6, 8, 10; saved; each link tested in a private window
- [ ] Gleam link in TikTok + Instagram bios
- [ ] 10:00 AM: campaign live; Telegram + Discord announcement posted and pinned

**Later**
- [ ] Calendar reminders: weekly export (optional); **Mar 31, 2027** "extend Gleam end date if no milestone yet"
- [ ] Milestone day: Ends → S + 30 d; snapshot line added to the description
- [ ] S + 30 d: final export (Actions **and** Users) sent to me → then downgrade/cancel Gleam

---

## Appendix A: Terms & Conditions text to paste into Gleam

Paste everything in the box below (it is `docs/airdrop/TERMS-FINAL.md` word for word, without its internal changelog, plus the first line pointing to the pinned post).

```
These Terms are also published as the pinned Terms post on our official socials (see pinned Terms post). On X: [X TERMS POST URL]

GreenCat Community Airdrop Terms and Conditions

These Terms and Conditions (“Terms”) govern participation in the GreenCat token community airdrop (the “Airdrop”) of 100,000,000 GreenCat tokens (the “Airdrop Pool”). By participating, you agree to these Terms. The organizers reserve the right to interpret, amend, or cancel the Airdrop at any time.

Airdrop Overview
The Airdrop Pool of 100,000,000 GreenCat tokens will be split evenly among the qualifying participants who satisfy all eligibility requirements below; if more than 1,000 wallets qualify, only the 1,000 with the highest GreenCat balance at the snapshot receive a share. Each qualifying participant in that group will receive an equal share of the Airdrop Pool, subject to successful completion of all conditions and final verification.

Holder Milestone and Snapshot
The snapshot will be taken one (1) week after 1,000 unique wallets each holding at least 100,000 GreenCat tokens is first reached. Wallets controlled by the organizers (GreenCat team wallets) are not counted. The exact snapshot block or timestamp will be announced on official channels. Only wallet balances recorded at that snapshot will be considered for ranking and qualification.

Minimum Holding Requirement
To be eligible, a wallet must hold at least 100,000 GreenCat tokens at the time of the snapshot. Wallets holding fewer than 100,000 GreenCat tokens at the snapshot are ineligible, regardless of ranking.

Post-Snapshot Holding Period
Qualifying wallets must maintain a balance of at least 100,000 GreenCat tokens continuously for thirty (30) days after the snapshot. If a wallet’s balance falls below 100,000 GreenCat tokens at any point during this 30-day period, that wallet is disqualified and will not receive an allocation. Transfers out, sales, or any other reduction that causes the balance to drop below the threshold result in automatic disqualification. The organizers may verify balances at any time during or at the end of the holding period.

Social and Community Requirements
To qualify, participants must complete all of the following before the end of the 30-day holding period (or by any earlier deadline announced by the organizers):

Follow the official GreenCat accounts on X, YouTube, TikTok, and Instagram.
Like, repost (or equivalent share action), and comment the exact word “airdrop” on each of the four designated Airdrop posts published across those platforms (one post per platform).
Join the official GreenCat Telegram group and Discord server.
Follow the official GreenCat channels on Kick and Twitch.

Failure to complete any required action, or completion using fake, bot, or inauthentic accounts, results in disqualification. The organizers may request proof of completion.

Ranking and Allocation
Among wallets that meet the minimum holding requirement at the snapshot and complete all other conditions, the top 1,000 holders by GreenCat balance at the snapshot will each receive an equal share of the 100,000,000 GreenCat Airdrop Pool. Wallets controlled by the organizers (GreenCat team wallets) are not eligible. If fewer than 1,000 wallets fully qualify, the Airdrop Pool will be split evenly among those who do qualify. Allocations are final once distributed and are not transferable before distribution.

Distribution
Tokens will be distributed to eligible wallets after the 30-day holding period ends and after verification of social and community tasks. Distribution timing and method will be announced on official channels. The organizers are not responsible for lost tokens due to incorrect wallet addresses, user error, network issues, or third-party platform failures.

Disqualification and Fraud
The organizers may disqualify any participant for Sybil activity, multiple wallets controlled by the same person or entity intended to game the Airdrop, wash trading, use of bots, fake social engagement, or any other behavior that undermines fair distribution. Each person may participate with one wallet only. Decisions on disqualification are final.

Eligibility and Restrictions
Participation is void where prohibited by law. Participants are responsible for complying with all applicable laws and tax obligations in their jurisdiction. The Airdrop is not available to persons or entities in jurisdictions where such distributions are restricted. Employees, contractors, and immediate family members of the organizers may be excluded.

No Warranty or Financial Advice
GreenCat tokens may have no value. Participation does not constitute an offer of securities, investment advice, or a guarantee of any return. The organizers make no representations about future price, utility, or exchange listings. Participants assume all risks associated with holding or receiving tokens.

Changes and Termination
The organizers may modify these Terms, delay the snapshot, extend deadlines, reduce or cancel the Airdrop Pool, or terminate the Airdrop if technical issues, legal requirements, low participation, or other circumstances make continuation impractical. Material changes will be announced on official channels.

Limitation of Liability
To the fullest extent permitted by law, the organizers and their affiliates are not liable for any direct, indirect, incidental, or consequential losses arising from participation, including lost tokens, failed transactions, or social-platform account issues.

Official Communications
Only announcements made through the official GreenCat X, Telegram, Discord, and other designated channels are valid. Participants should beware of impersonators and phishing attempts.

By holding GreenCat tokens and completing the required actions, you acknowledge that you have read, understood, and agreed to these Terms.
```

---

## Sources (all read Thu Oct 8, 2026)

- Gleam FAQ "What Actions Are On the Hobby Plan?", "...Pro Plan?", "...Business Plan?" (updated May 16 / Oct 2, 2026): action lists per plan (Hobby: "Question Actions - Without Verification"; Business: "Question Actions with Verification", "Join a Telegram Group with Tracking").
- Gleam Competitions changelog (gleam.io/updates/competitions): "Crypto Wallet Address action is now available on the Pro plan and above"; Comment on Instagram "Free plan and above"; Follow on Instagram returned May 2025; Hobby monthly announcement (Apr 2025, "$19/month").
- Gleam blog "Gleam vs SweepWidget" (via search index; page blocks automated reads): Hobby $29 / Pro $59 / Business $179 / Premium $499 monthly; $10 / $39 / $119 / $299 per month yearly. TechYorker "Gleam Competitions Pricing in 2026" (checked Sep 30, 2026): same figures, Hobby yearly $120.
- Gleam FAQ "What is a Repeat Action Limit for Competitions?" (Hobby 2 monthly / 3 yearly; Pro 5 / 10).
- Gleam FAQ "Collect Wallets in Crypto Airdrop Giveaways" / "Can I Track Participation Across Wallets or Token Holders?" (wallet fields not validated on-chain; no on-chain token check); Gleam Package pricing page (Pro: restrict by location, smart post-entry emails, post-entry redirect; repeat limit 5); Gleam docs competitions/setup/post-entry and user-details (allowed locations); FAQ "Can I Notify Users After They Enter?" (confirmation email default on Pro); Pro features page (Users tab, branding, redirect).
- Gleam FAQ "How Many Winners Can I Draw Per Campaign?", "Can I Export My Competitions Data?" (entry data: Hobby and above), "Can I Export Data From Old Campaigns After Cancelling My Plan?", "Where Do I Insert Terms & Conditions?" (custom T&C: Hobby and above), "Can I Create an Ongoing Giveaway?", "Can I Edit a Current Competition?", "Can I Pause a Competition?", "Can I Hide the End Date?" (Business, custom CSS), "What Entry Methods Are Available?" (manual-verification flags; updated Oct 3, 2026).
- Gleam docs: actions/crypto-wallet (address types ETH/BEP-20, BTC, BEP-2, Other; duplicates blocked by default; no format option), question, custom (regex Format = Business), submit-url, visit (delay/question = Pro), twitter (Follow "no longer available"), instagram, youtube (Subscribe/Like retired), tiktok, telegram (tracking = Business), discord, twitch (Follow a Channel: "we check the follow before they get their entries"), kick (Follow on Kick: "We don't have access to Kick's API yet, so you'll need to verify follows yourself"; changelog: Hobby and above for Competitions); competitions/installation/hosted.
- Telegram and Discord links resolved from the official t.co links on Oct 8, 2026; Discord invite expiry read from Discord's public invite info (expires: never).
