# GreenCat airdrop tutorial (for the admin)

*Written 2026-10-02 PT from the code as it is today: `programs/greencat/src/airdrop.rs`, `scripts/airdrop.ts`,
`apps/web/src/components/AirdropPanel.tsx`, `apps/web/src/components/AdminPanel.tsx`, `AirdropPoolPanel.tsx`, `TreasuriesPanel.tsx`, `docs/DEPLOY.md`.
Updated 2026-10-02 PT (late evening): new **Deposit to airdrop pool** and **Withdraw to my wallet** buttons in `/admin`.
Updated 2026-10-07 PT: launch airdrop follows the owner's new Terms (milestone-triggered snapshot, top-1,000 equal split; see the box below).
Updated 2026-10-08 PT: the launch Terms now also require following GreenCat on Kick and Twitch (box below).
If the admin page changes, this guide needs a refresh.*

**Who does what**
- **YOU** = GreenCat, in the browser at **https://greencat-app.vercel.app/admin** with your admin wallet (MetaMask with Solana, or Phantom). No command line.
- **ASSISTANT** = me, working on the box (snapshot, list, publishing, redeploying the website). I never sign anything with your wallet and never spend your tokens.

> **One thing to check first:** the airdrop buttons in `/admin` only work when the wallet you connect **is the program authority** (the
> "Authority" tile in *Program status* shows its short address). On Devnet that is already your MetaMask wallet `13zew…fyj6`, and
> on mainnet it will be the same wallet (your decision: no Squads multisig). If another wallet is connected, the buttons stay greyed out.

> **Launch airdrop (100M $GC, owner's Terms of Oct 7, 2026):** this tutorial is the general how-to. The launch round has its own
> rules and timeline in **`docs/LAUNCH-AIRDROP-PLAN.md`** (Terms to publish: `docs/airdrop/TERMS-FINAL.md`): snapshot **S = 7 days after 1,000 wallets each
> hold ≥100,000 $GC**, then a **30-day continuous hold** (S → S + 30 days) and the social tasks (follow GreenCat on **X, YouTube, TikTok,
> Instagram, Kick and Twitch**; like, repost/share and comment "airdrop" on the **4 designated posts** on X, YouTube, TikTok and Instagram;
> join **Telegram + Discord**; Kick + Twitch added by the owner Oct 8, 2026), then the **top 1,000 fully qualifying
> wallets by balance at S** get an **equal share**. For that round, Step 1 below is replaced by the hold check and the `--top 1000` build
> (plan section 5); Steps 2–5 are the same. The 100M is **not** in the airdrop pool at mainnet launch: you deposit it
> (section 2b) only when the round is set up for claims, right before Post root (owner decision Oct 20, 2026). Claims stay open **30 days** from Post root; reclaim after the 30 days; only then
> fund the staking pools and **open staking** in `/admin` (owner decision Oct 20, 2026; staking stays locked until the reclaim). The old "day-30 snapshot / day-60" timeline no longer applies.

---

## 1. What happens (in 5 lines)

1. You put the $GC you want to give away into the **airdrop pool** (pool 5) with the **Deposit to airdrop pool** button in `/admin`.
2. I take a **snapshot** of every wallet holding at least your minimum amount of $GC and work out each wallet's share.
3. I turn that list into a **proofs file** (a tamper-proof list) and publish it on the website.
4. You press **Post root** in `/admin` and sign once. This locks the total in the pool and opens the claim window (7 to 365 days).
5. Holders claim on **/airdrop** themselves. When the window ends, you press **Reclaim unclaimed** to free up what's left, and
   (if you want the tokens back in your wallet) **Withdraw to my wallet**. That button can also do both in one approval.

Nothing is ever sent to holders automatically: each holder clicks **Claim** and pays their own small network fee.

---

## 2. Before you start (3 decisions + funding)

### 2a. Decide the numbers (tell me these 5 things)

| Decision | What it means | Rules from the code | My suggestion |
|---|---|---|---|
| **Total amount** | How much $GC to give away in this round | Must be ≤ the *free* balance of the airdrop pool (balance minus anything already reserved for an open airdrop) | Start small for the first round |
| **Minimum holding** | A wallet must hold at least this much $GC to qualify | Any number. The on-chain default is **100,000 $GC**; I use that unless you give me another number. Staked $GC does **not** count, only $GC sitting in the wallet. | 100,000 |
| **Split** | **Equal** (every qualifying wallet gets the same) or **pro-rata** (bigger holders get more, in proportion) | Either | Equal is simplest to explain |
| **Claim window** | How long holders have to claim | **7 to 365 days**. The clock starts **when I take the snapshot**, and the program refuses to open a window shorter than 7 days at the moment you press Post root. | **At least 8 days** (gives you a day to press Post root), for example 14 or 30. **Launch round: 30 days from the claim opening** → `--expiry-days 33` (owner decision Oct 7, 2026) |
| **Wallets to leave out** | Team wallets, exchange wallets, etc. | Program pools and other program-owned addresses (liquidity pools, vaults) are left out automatically | Give me any team / exchange addresses |

Optional anti-cheat: tell me **"do a surprise early snapshot"**. I quietly record balances a few days before the real snapshot, and each wallet
counts with the **lower** of the two balances. That stops people buying or borrowing $GC just for snapshot day.

### 2b. Fund the airdrop pool (YOU, in the browser at https://greencat-app.vercel.app/admin)

There's a **Deposit** button for this in `/admin`. You don't need to copy addresses or send tokens by hand.

1. Open **https://greencat-app.vercel.app/admin** and connect your **admin wallet** (MetaMask or Phantom).
2. Scroll to the panel **Airdrop pool funds**. It shows four tiles:
   - **In the pool**: $GC in the airdrop pool right now.
   - **Reserved for claims**: $GC promised to holders of airdrops that are still open. Nobody can take this out, not even you.
   - **Withdrawable now**: what you could take back right now (In the pool − Reserved).
   - **Your wallet**: $GC in the wallet you connected.
3. In **Deposit $GC into the airdrop pool**, type a **test amount first (e.g. 1)** and press **Deposit to airdrop pool**.
   (**Max** fills in your whole wallet balance.)
4. Your wallet opens **one** confirmation. Check it's on the right network (Devnet now, mainnet later) and **Approve / Confirm**.
5. You should see a green message **"Deposited 1 $GC into the airdrop pool"** with a transaction link, and **In the pool** goes up by 1.
   The *Treasuries* panel's `airdrop` row shows the same number (press **Refresh** there if it hasn't updated).
6. Deposit the rest the same way, and check **In the pool** minus **Reserved for claims** covers your airdrop total.

If something's wrong you get a red message instead, and nothing moves. The common ones:
- *"Your wallet only has … $GC"*: lower the amount.
- *"GreenCat is paused for maintenance"*: deposits are blocked while the program is paused. Press **Resume program** first.
- *"Cancelled in your wallet"*: you pressed Reject. Nothing was sent.

Also keep about **0.01 SOL** in your admin wallet for network fees (a deposit costs about 0.000005 SOL; posting an airdrop about 0.002 SOL).

*Old way (still works, not needed any more):* a plain **Send → $GC** from your wallet to the `airdrop` row's **PDA** address
(Treasuries panel). Send to the **PDA**, never to the "Vault" address: wallets turn the PDA into the right vault automatically.
The Deposit button is simpler and can't go to a wrong address.

---

## 3. The steps

### Step 1. Snapshot (ASSISTANT, on the box)

I run the snapshot tool (`scripts/airdrop.ts snapshot`). It:
- reads every $GC token account on the blockchain and adds up each wallet's balance (read-only, sends nothing, costs nothing);
- keeps wallets at or above your minimum holding; drops program pools, liquidity pools and the wallets you asked me to leave out;
- if you asked for a surprise early snapshot, uses each wallet's lower balance;
- saves a copy of the raw balances (useful later, e.g. as the early snapshot for the *next* airdrop).

**Launch airdrop instead:** the balances come from the 30-day hold checker (`scripts/airdrop-hold-check.ts --snapshot <S>`), which outputs
only the wallets that passed everything with their **balance at the snapshot**. The build then keeps the **top 1,000 by that balance**
(`airdrop.ts snapshot --balances airdrops/hold/hold-qualified.json --top 1000 --split equal --exclude-file scripts/airdrop-exclude.json`).
Fewer than 1,000 → everyone who qualified. If wallets with the identical balance tie for the last place, the tool stops and asks how to break the tie.

### Step 2. Build the list (ASSISTANT, on the box)

In the same run, the tool splits the total (equal or pro-rata), gives every wallet an entry number, builds the tamper-proof list and checks
every single entry against it before saving. The result is one file: **`airdrop-<number>-proofs.json`**.

I send you a short summary to approve:
- airdrop number (1 for the first one; each airdrop gets a new number)
- how many wallets qualify, and the amount each gets (equal split) or the range (pro-rata); for the launch round also how many passed all checks and the cut-off balance for the top 1,000
- the exact total (it can be a tiny bit under your total because of rounding: equal shares are rounded down to the smallest unit, so the leftover "dust" is less than 0.001 $GC and stays in the pool)
- the exact claim deadline, in PT

**(YOU)** Reply "approved", or ask me to change something. A change means a new snapshot. Nothing is on-chain yet, so changes are free.

### Step 3. Publish the proofs where the app reads them (ASSISTANT, on the box)

1. I put the file in the website at `apps/web/public/airdrops/airdrop-<number>-proofs.json`, so it lives at
   **`https://greencat-app.vercel.app/airdrops/airdrop-<number>-proofs.json`**.
2. I point **`apps/web/public/airdrops/current.json`** at it (`{ "current": "airdrop-<number>-proofs.json" }`). Both `/airdrop` and `/admin`
   load this file automatically. No Vercel setting is needed (`NEXT_PUBLIC_AIRDROP_PROOFS_URL`, if set at build time, still wins).
   This published file is the **only** way holders get an airdrop: `/airdrop` has no paste box, no "proofs file URL" field and no
   `?proofs=` link parameter, so nobody can hand holders a fake file. With no airdrop published it says
   *"No airdrop right now. Official airdrops are announced on GreenCat's channels and appear here automatically."*
   Before you post, I rehearse the whole round on a local copy of the chain with a temporary admin
   (`scripts/airdrop-rehearsal.ts`: deposit, post, every claim, the guards, and reclaim + withdraw with a short-window build).
3. I redeploy the website (it is deployed by hand from `main`, so this takes a few minutes).
4. I open `/airdrop` and check it shows the airdrop with **Window: "not live"** and the message *"This airdrop isn't live on-chain yet."*
   That is correct until you do Step 4.

The proofs file is public on purpose: it lists every qualifying wallet and its amount, so anyone can check the airdrop is fair.

### Step 4. Create the airdrop on-chain (YOU, in the browser at https://greencat-app.vercel.app/admin)

**The admin page can do this.** It's the **Post root** button. You don't need the command line.

1. Open **https://greencat-app.vercel.app/admin** and connect your **admin wallet** (MetaMask or Phantom).
2. Check the **Program status** panel:
   - **State** must say **Live**. Posting an airdrop is blocked while the program is paused.
   - You must **not** see *"Read-only: this wallet isn't the program authority."*
3. Scroll to **Airdrop distributions**. The proofs file should already be loaded and you should see a box like:
   **"Distribution #1 · 1,234 wallets · 1,000,000 $GC · not posted yet"**.
   - If you don't see it, tell me and I fix the published file and redeploy. (Fallback, only for a file **you made yourself** or I made for you:
     open **Advanced: load a proofs file manually**, paste it into **Proofs JSON** and press **Load**. The box warns you about this,
     and the review box then says *"pasted on this page (not the published file)"*.)
   - Under it, the **Loaded file** box shows **Recipients**, **Total** and the full **Merkle root**. Check all three match the summary you approved.
   - Tick **"I checked the recipient count, total and Merkle root…"**. **Post root** stays grey until you do (and un-ticks itself if a different file is loaded).
   - The box also shows the **claim deadline** and **"Press Post root before …"** (deadline minus 7 days). After that time the
     button turns grey and says the file is too late: ask me for a fresh snapshot.
4. Press **Post root**. Your wallet opens a confirmation. Check it's on the right network and **Approve / Confirm**.
5. You should see **"Distribution posted"** with a transaction link. The box now says **"live"**, and the *Airdrop reserved* tile in
   *Program status* goes up by the total.
6. **(ASSISTANT)** I re-check `/airdrop`: the Window tile should now show the time left.

From now on, the reserved amount **cannot be withdrawn** from the pool until the window ends and you reclaim. That's the promise to holders.

On mainnet you stay the admin with your own wallet (no Squads multisig), so the same buttons work there.

### Step 5. Announce (YOU)

Post the announcement below **after** Step 4 shows "live". If you post earlier, people find a "not live" page.

### Step 6. During the window (nobody needs to do anything)

Holders go to **/airdrop**, connect the wallet that held $GC at snapshot time, see **"Your allocation"** and press **Claim**. Each holder
needs about **0.005 SOL** for the fee and the small on-chain receipt. Each entry can only be claimed once. You can watch progress in `/admin`:
*Airdrop reserved* goes down as people claim.

Don't pause the program near the deadline unless you have to. A pause also blocks claims, and Reclaim stays blocked for 3 days after any unpause.

---

## 4. Holder announcement template (ready to post)

Replace the parts in [brackets]. I give you the exact deadline (PT and UTC) in the Step 2 summary.

> 🪂 **GreenCat $GC Holder Airdrop #[1] is LIVE**
>
> We snapshotted every wallet holding at least **[100,000] $GC** on **[date] PT**.
> **[1,234] wallets** qualify for a share of **[1,000,000] $GC** ([equal split: [810] $GC each] / [split by holdings]).
>
> ✅ **Claim here (official link only):** https://greencat-app.vercel.app/airdrop
> ⏰ **Deadline:** [Friday, Oct 30, 2026, 9:00 PM PT] ([04:00 UTC Oct 31]). Unclaimed $GC goes back to the airdrop pool.
>
> **How to claim**
> 1. Open the link and connect the wallet that held $GC at the snapshot.
> 2. You'll see "Your allocation". Press **Claim** and approve in your wallet.
> 3. Keep ~0.005 SOL in that wallet for the network fee.
>
> 🔍 Full list of wallets and amounts (public, so anyone can check): [https://greencat-app.vercel.app/airdrops/airdrop-1-proofs.json]
>
> 🚨 **Stay safe:** GreenCat **never DMs you**, never asks for your seed phrase or private key, and never asks you to "send tokens to receive tokens".
> The only claim page is **greencat-app.vercel.app/airdrop**. Anyone DMing you about this airdrop is a scammer. Block and report.

**Launch-round variant of the second paragraph:** "The 30-day hold after the **[S date] PT** snapshot is over and the checks are done.
**[N] wallets** (the top [N ≤ 1,000] fully qualifying wallets by balance at the snapshot) each get **[100,000] $GC**." Use the official
app link (app.greencat69420.com/airdrop once the app is on mainnet). **Launch round: 30-day claim window** (owner decision Oct 7, 2026):
replace the ⏰ line with "⏰ **You have 30 days to claim:** until **[exact end date and time, PT]** ([UTC]). Unclaimed $GC goes back to the
airdrop pool." (X version: "You have 30 days to claim, until [date, PT]."). The end date is the round's on-chain end date from my Step 2
summary. Because the clock starts when I build the list (Step 1), I build the launch round with `--expiry-days 33` (30 days + ~3 days until
you press Post root); if Post root slips, I rebuild first so holders still get the full 30 days. Staking stays **locked** during the claim window;
reclaim after the 30 days (section 5), then fund the staking pools and open staking (`docs/MAINNET-LAUNCH-CHECKLIST.md` Phase 8; owner decision Oct 20, 2026).

Short version (for X):

> 🪂 $GC Holder Airdrop #[1] is live! [1,234] wallets holding ≥[100k] $GC at snapshot can claim.
> Claim: greencat-app.vercel.app/airdrop. Deadline [Oct 30, 9 PM PT].
> GreenCat never DMs you and never asks for your seed phrase. 🐱💚

---

## 5. After the deadline: reclaim and withdraw unclaimed tokens (YOU, in the browser at https://greencat-app.vercel.app/admin)

1. Wait until the deadline has passed. If the program was paused at any point, also wait **3 days after the last unpause**, and it must not be paused now.
2. Open `/admin`, connect your admin wallet, and scroll to **Airdrop distributions**. The box should say **"window ended"**.
   (If the file isn't loaded, open **Advanced: load a proofs file manually** and paste it into **Proofs JSON**, as in Step 4. Only a file you made yourself.)
3. Now pick one of these:

**A. Keep the leftover in the pool for the next airdrop**
- Press **Reclaim unclaimed** and approve in your wallet. You should see **"Unclaimed funds reclaimed"**, and the box says **"reclaimed"**.
- The unclaimed amount is **released from the reservation** but **stays in the airdrop pool**. *Reserved for claims* goes down and
  *Withdrawable now* goes up by the same amount. Holders can no longer claim this airdrop.

**B. Get the leftover back into your wallet (one approval)**
- Scroll to **Airdrop pool funds**. Because the loaded airdrop has ended, the withdraw button now reads **"Reclaim round #N + withdraw"**
  and the text under it says how much is unclaimed.
- Press **Max** (or type a smaller amount) and press **Reclaim round #N + withdraw**. Approve the **one** wallet confirmation.
- You should see **"Round #N reclaimed. Withdrew … $GC from the airdrop pool to your wallet"**. *In the pool* goes down, *Your wallet* goes up.

**C. You already reclaimed (A), and now want the tokens out**
- In **Airdrop pool funds**, press **Max** next to **Withdraw unreserved $GC to your wallet**, then **Withdraw to my wallet**, and approve.
  You should see **"Withdrew … $GC from the airdrop pool to your wallet"**.

The withdraw always goes to **the wallet you're connected with** (your admin wallet), never anywhere else.

**What you can't do (on purpose):** withdraw $GC that is still **reserved** for an open airdrop. While an airdrop is live, **Withdrawable now**
only counts the part of the pool that isn't promised to holders. If you type more, the page stops you; if anything slipped through,
the program itself refuses with *"That withdrawal would dip into funds owed to users"*. That's the promise to holders.
Extra $GC you deposited on top of an open airdrop's total can be withdrawn any time.

4. **(ASSISTANT)** I set `apps/web/public/airdrops/current.json` to `{ "current": null }` (or point it at the next airdrop) and redeploy,
   so `/airdrop` stops showing the old one. The `/admin` box tells you when **Reclaim unclaimed** opens (deadline, or 3 days after the last unpause if later).

---

## 6. Troubleshooting FAQ

**The Post root / Reclaim / Deposit / Withdraw buttons are greyed out.**
- Your wallet isn't connected, or it isn't the program authority (look for *"Read-only: this wallet isn't the program authority"*).
- **Post root** is also grey when no proofs file is loaded, when you haven't ticked **"I checked the recipient count, total and Merkle root…"**, or this airdrop number is already posted.
- **Reclaim unclaimed** is grey until the window ends, and after it has been reclaimed once.
- **Deposit to airdrop pool** is grey until you type an amount, and while the program is paused.
- **Withdraw to my wallet** is grey until you type an amount, and when **Withdrawable now** is 0 (everything in the pool is reserved for holders, or the pool is empty).

**Withdraw failed: "Only … $GC can be withdrawn right now" or "That withdrawal would dip into funds owed to users".**
You asked for more than *Withdrawable now*. The rest is reserved for an airdrop that's still open. Press **Max** to take exactly what's allowed,
or wait for the window to end and reclaim (section 5).

**The withdraw button says "Reclaim round #N + withdraw" but fails with "Reclaim is blocked while paused and for 3 days after unpausing".**
Wait until 3 days after the last unpause (and make sure the program isn't paused), then try again. Nothing was sent.

**Post root failed with "Expiry outside the allowed window".**
The window is counted from the snapshot, and at least 7 days must be left when you press Post root. Too much time passed since the
snapshot (or it was set to exactly 7 days). Tell me. I redo the snapshot with a longer window, republish, and you press Post root again.

**Post root failed with "The airdrop vault doesn't have enough unreserved $GC".**
The airdrop pool's balance minus what's already reserved is less than this airdrop's total. Send more $GC to the pool (section 2b), or ask me for a smaller total.

**It says "GreenCat is paused for maintenance".**
The program is paused. Press **Resume program** in the *Actions* panel first (posting an airdrop and claiming both need it to be live).

**Reclaim failed: "The claim window is still open" or "Reclaim is blocked while paused and for 3 days after unpausing".**
Just wait. The first means the deadline hasn't passed. The second means the program is paused now or was unpaused less than 3 days ago.

**A holder says "This wallet isn't in this snapshot".**
They connected a different wallet, held less than the minimum at snapshot time, held their $GC on an exchange, or had it staked (staked $GC
doesn't count). Since the list is locked on-chain, nobody can be added to this airdrop. They can qualify for the next one.

**A holder says the button says "Claimed ✓" but they didn't claim.**
That entry has been claimed from that wallet. Only that wallet can ever claim its entry, so ask them to check their wallet's $GC balance and history.

**A holder gets "Your proof doesn't verify" or "This proofs file doesn't match the on-chain airdrop".**
They're on a fake site, or the published file is wrong. The real `/airdrop` page can't load any other file, so tell them to use only the official link
(greencat-app.vercel.app/airdrop) and refresh. If it still happens there, tell me: the published file needs fixing.

**A holder says the Claim button doesn't work or the fee fails.**
They need about 0.005 SOL in the same wallet. Also check the window hasn't ended and the program isn't paused.

**The `/airdrop` page says "No airdrop right now".**
`apps/web/public/airdrops/current.json` isn't pointing at the proofs file (or it was set to `{ "current": null }` after the last airdrop). Tell me and
I fix it and redeploy. Holders can't load a file by hand (on purpose: the page says *"Never paste airdrop links or files from anyone: claims only happen here."*).

**Where does the proofs file come from?**
The box label says "Proofs JSON (airdrop-&lt;number&gt;-proofs.json from scripts/airdrop.ts snapshot)": it's the file I make in Step 2.
(Older versions of the page mentioned `scripts/airdrop-snapshot.mjs`; that tool was replaced.)

**I deposited $GC but the pool balance didn't change.**
Press **Refresh** on the Treasuries panel, and wait a minute. If it still hasn't changed, don't send more. Send me the transaction link
(from the green message) and I'll check where it went.

**Can I change the amount, list or deadline after posting?**
No. A posted airdrop is fixed. If something's wrong, let it run, reclaim after the deadline, and do a new airdrop with the next number.

**Can I run two airdrops at once?**
Yes, each with its own number, as long as the pool has enough free $GC for both. But the website shows one proofs file at a time, so one at a time is simpler.

---

## Gaps: what still needs the command line (estimates only)

| # | Step | Today | Notes |
|---|---|---|---|
| ~~1~~ | ~~Fund the airdrop pool~~ | **Done:** **Deposit to airdrop pool** button in `/admin` (section 2b). | |
| ~~2~~ | ~~Withdraw reclaimed tokens from the pool~~ | **Done:** **Withdraw to my wallet** / **Reclaim round #N + withdraw** in `/admin` (section 5). | The program still never lets anyone withdraw what's reserved for an open airdrop. |
| ~~3~~ | ~~Post root / Reclaim through a Squads multisig~~ | **Not needed:** your decision is to stay admin with your own wallet on mainnet (no Squads). | If that ever changes, `scripts/airdrop.ts` needs a `PRINT_ONLY` mode (~1–2 h). |
| 4 | Snapshot, list and publishing | Done by the assistant on the box, by design (needs a full chain read, a website file and a redeploy). Not your job. | A self-serve "Create airdrop list" page would need server-side work and file hosting (~1–2 days, not recommended now). |
| 5 | Change the on-chain default minimum holding (`set_airdrop_threshold`) | No button and no CLI command. **Not needed:** the snapshot takes your number directly, and claiming doesn't check this value. | "Default minimum holding" field in `/admin` (~1 h, optional). |
| ~~6~~ | ~~Stale label "scripts/airdrop-snapshot.mjs" in `/admin`~~ | **Fixed.** | |
