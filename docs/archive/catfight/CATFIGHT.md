# 🥊 Cat Fight

> **Archived: Cat Fight removed Oct 12, 2026 by owner.** Historical reference only.

Weekly **Red cat vs Blue cat** parimutuel betting in $GC. Page: `/fight` · admin: `/admin` → "Cat Fight" · program: `programs/greencat/src/catfight.rs` · SDK: `packages/sdk/src/catfight.ts` · CLI/crank: `scripts/catfight.ts` · localnet suite: `apps/api/test/catfight-localnet.ts` (runs in CI on main).

> Results come from on-chain randomness (ORAO VRF). No audit or legal review has been done for this feature. Mainnet starts **disabled**.

## How a round works

1. **Open.** One round at a time. By default a round opens right after the previous fight closes (anyone can call `open_round`; the UI's
   "Start the fight" button does it in the same transaction as the close). Default close: **Monday 06:30 America/Vancouver**, at least
   24 h after opening (so a round opened Sunday night closes the *following* Monday). The program computes this on-chain with the US/Canada
   DST rule (PDT = UTC−7 from the 2nd Sunday of March, PST = UTC−8 from the 1st Sunday of November). If BC moves to permanent
   daylight time, the admin switches the schedule to a fixed UTC offset.
   The admin, or the operator wallet, can instead schedule a round with explicit open/close times (`schedule_round`) or move an open round's
   times (`set_round_times`) **until the first bet**; once a bet is in, both times are locked (bug sweep 2026-10-07, CF-01: moving the close
   after bets let the admin/operator bet the thin side and then cut betting short). Times never move into the past (close ≥ 60 s ahead).
   **Scheduling limits (CF-03):** a round can open at most **8 days** ahead, betting can last at most **15 days** (counted from the later of
   "now" and the open time), and a round still has to close within 35 days of being created. The default weekly schedule always fits.
   The /admin panel and `scripts/catfight.ts schedule-round/times` check the same rules before sending.
2. **Bet.** `place_bet(round, side, amount)`: min 100 $GC (admin-set), optional max per wallet per round (0 = no max). You can top up and
   even bet on both sides. Bets go to the **bet vault** (ATA of the `catfight` PDA).
3. **Close + VRF.** After `close_ts`, anyone calls `close_round`. If either side is empty → status **Refund** (no VRF, no fee). Otherwise
   the program requests ORAO VRF **at that moment** (seed = sha256("greencat-catfight-vrf-v1" ‖ program ‖ round_id ‖ attempt)), so
   nobody can know the result while bets are possible.
4. **Settle.** When ORAO has fulfilled, anyone calls `settle_round`:
   `winner = 1 + (u64_le(sha256("greencat-catfight-vrf-v1" ‖ randomness ‖ round_pda)[0..8]) mod 2)` → 1 = Red, 2 = Blue (fair 50/50).
   The fee moves from the bet vault to the separate **fee vault**. If ORAO doesn't answer within `vrf_expiry_secs` (1 h on devnet),
   anyone can `retry_fight_vrf`; this is only allowed when the previous request is expired **and** unfulfilled, so a known result can never be re-rolled.
   **Refund if ORAO never answers (CF-02):** if the round is still waiting **24 h after the first VRF request** (the time `close_round`
   asked), anyone can call `refund_unfulfilled_round`. It only works when the current request is also expired **and** unfulfilled, so it
   can't jump ahead of a fresh retry or a result that is already there (`VrfAlreadyFulfilled` / `VrfNotExpired` / `VrfRefundNotDue`).
   The round moves to **Refund**: every bettor claims their full stake back with `claim_fight`, with no fee. Settle and retry are refused
   after that, and a settled round can't be refunded. Turning Cat Fight off or pausing the program doesn't block it. The first-request time
   lives in what used to be reserved bytes of `FightRound` (`first_vrf_ts`), so existing rounds still read the same; rounds closed before
   this upgrade count from their latest request instead. The crank (`npm run catfight -- crank`) and the /fight page ("↩ Refund the fight")
   send it automatically once it's due.
5. **Claim (pull).** `claim_fight(round, bettor)`: anyone may send it (it always pays the bettor's own $GC account and closes the bet
   account, returning its rent to the bettor). Losers can "claim" 0 to get their rent back. Claims never expire.

The animation on `/fight` is cosmetic. It plays the winner stored in the settled round, once per wallet per round (localStorage key
`gc-catfight-seen-<round>-<wallet>`). A Replay button is next to every settled round.

## Fee math ("takeout from the total pool")

```
total        = pool_red + pool_blue
fee          = min( floor(total × fee_bps / 10 000), losing_pool )      # fee_bps ≤ 1 000 (hard cap 10 %), default 500 (5 %)
payout_pool  = total − fee
your payout  = floor( your_stake_on_winner × payout_pool / winning_pool )   # includes your stake
```

- The fee is snapshotted when the round is created, so changing it never affects a running round.
- Capping the fee at the losing pool means a winner never gets back less than their stake.
- If one side is empty (or nobody bet on the winner, which is the same case), everyone gets their stake back in full and there's no fee.
- Rounding: every payout rounds down to the raw unit (0.000001 $GC). The leftover "dust" (a few raw units per round) stays in the bet vault.
- Implied multiplier shown in the UI = `payout_pool / side_pool` (what 1 $GC returns if that side wins, including stake, after the fee, counting your prospective bet).

**Worked example (5 %).** Red: A 1,000 + B 2,000 = 3,000. Blue: C 1,000. Total 4,000.
- fee = min(4,000 × 5 % = 200, losing pool) = **200 $GC** → fee vault. payout_pool = **3,800**.
- **Red wins:** A gets floor(1,000 × 3,800 / 3,000) = **1,266.666666**; B gets floor(2,000 × 3,800 / 3,000) = **2,533.333333**; C gets 0.
  1 raw unit (0.000001) of dust stays in the vault. (Live multipliers before close: Red 1.27×, Blue 3.80×.)
- **Blue wins:** C gets **3,800** (stake 1,000 + 2,800 profit). A and B get 0.
- **Fee cap example (10 %):** Red 200, Blue 100 → 10 % of 300 = 30 ≤ 100, so fee 30. With Red 10,000 and Blue 100 at 10 %, 1,010 > 100, so the fee is capped at 100 and Red winners simply get their stakes back.

These numbers are asserted by the Rust unit tests, the SDK tests and the localnet suite, and were verified live on devnet (see "Devnet record").

## Accounts

| PDA | Seeds | Notes |
|---|---|---|
| `CatFight` | `"catfight"` | switch, fee bps, min/max bet, default schedule, operator, totals. Owns the **bet vault** ATA. |
| fee authority | `"catfight_fees"` | owns the **fee vault** ATA. Only `withdraw_catfight_fees` (Config authority) moves money out. |
| `FightRound` | `"catfight_round", id_le` | times, pools, bettor counts, fee snapshot, status (0 open · 1 awaiting VRF · 2 settled · 3 refund), winner, VRF seed/attempt, first VRF request time, fee, payout pool, claimed. 218 bytes (unchanged by the CF fixes). |
| `FightBet` | `"catfight_bet", id_le, bettor` | red/blue stake. Closed on claim. |

## Who can do what

| Action | Who |
|---|---|
| `init_catfight` | upgrade authority or Config authority. With the `mainnet` feature it **must** start disabled. |
| on/off, fee + limits, default schedule, operator, withdraw fees | Config authority (devnet + mainnet: your MetaMask `13zew…`) |
| schedule a round, move round times (before the first bet) | Config authority **or** the operator wallet (devnet: the box key `BVtgz…`; mainnet: none unless you set one) |
| open next round (default schedule), close, retry VRF, settle, refund after 24 h without VRF, claim for anyone | **anyone** (permissionless crank) |

Nobody can pick or see the winner: it's decided by ORAO randomness requested after betting closes. The admin can't touch the bet vault.
Turning Cat Fight **off** (or pausing the program) stops new rounds and new bets. Close, settle, refund and claim always keep working.

## Running it

- **UI:** `/fight` shows the "🥊 Start the fight", "🎲 Reveal the winner", "Re-request randomness", "↩ Refund the fight" or "Open the next fight" button whenever that
  step is due. Any wallet can press it (it costs a small SOL fee; the close also pays the ORAO request fee, ~0.001–0.002 SOL on devnet).
- **CLI (box):** `npm run catfight -- status`, `… crank 15 --open-next` (loop), `… schedule-round +5m +20m`, `… bet red 100`
  (with `KEYPAIR_PATH`), `… claim ROUND BETTOR…`, `… refund ROUND` (after the 24 h VRF timeout). The Railway worker does **not** run a crank (it would need a hot key); the UI button is enough.

## Mainnet notes

- Deploy as usual, then run `init_catfight(enabled = false, operator = none)` (the mainnet build refuses `enabled = true`).
- Fund nothing: the bet vault fills only from bets, and the fee vault only from fees. No $GC or SOL float is needed.
- Before turning it on: legal sign-off for real-money wagering in your jurisdictions, the 18+/19+ line on `/fight`, the fee setting, and a scheduled first round.

## Devnet record (2026-10-07 PT)

- Program `8Sy7…ywvPE` upgraded in place at ~18:33 PT: extended by 196,992 B (1,073,128 → 1,270,120 B), deploy tx `5kdKhLbR…dWhM`
  (binary sha256 `497c266e…3816`). Rollback copy of the previous binary: `/workspace/rollback/greencat-pre-catfight.so` on the box.
  SIMD-0500 re-checked first: still inactive on devnet.
- **Oct 8, 2:06 AM PT: CF-01/02/03 upgrade** (`bb2dc88`, round #4 had 0 bets): extended by 10,240 B (→ 1,280,360 B), deploy tx `fFUHnkZi…sDVj`
  (binary sha256 `c7dbc678…d4c7`, 0.0584 SOL used). Rollback: `/workspace/rollback/greencat-pre-cf-fixes.so`. Crank restarted on the new SDK.
  Details in `BUGSWEEP-2026-10-07.md` → Deploy record.
- `init_catfight(enabled = true, operator = BVtgz…)` by the upgrade authority: tx `3ecR2vSq…M99B`. Fee 5 %, min 100 $GC, no max, Mon 06:30 PT.
- **Round 1 (two-sided, 12 min):** A 1,000 Red, B 2,000 Red, C 1,000 Blue (box throwaway wallets). Closed at 18:46 PT together with opening
  round 2 in the same tx (`5q8EEExU…9z1`); ORAO answered within seconds; settled `2JcvpF4y…2tnQ` → **Red**, fee **200**, payout pool **3,800**.
  Claims: A +1,266.666666, B +2,533.333333 (exact raw amounts 1,266,666,666 / 2,533,333,333), C 0 (bet closed, rent back; claimed by a
  different wallet to show claims are permissionless and always pay the bettor). Fee vault 200,000,000 raw; bet vault dust 1 raw. ✅ matches the worked example.
- **Round 2 (refund):** the operator moved round 2's close to 18:51 PT (allowed: no bets yet), D bet 500 Blue only → close = **Refund**
  (`249DuQrp…6YxS`), D claimed 500 back exactly, no fee.
- **Round 3 (owner test, ~1 h):** open 18:51 PT → **closes Wed Oct 7, 20:00 PT**. Seeded with 200 Red (A) + 300 Blue (C) so it's two-sided.
  A crank on the box (`npm run catfight -- crank 30 --open-next`, log `.tmp-catfight/crank.log`) will close it, open round 4 on the
  default schedule (**closes Mon Oct 12, 06:30 PT**) and settle round 3. The "Start the fight" / "Reveal the winner" buttons on `/fight` do the same.
