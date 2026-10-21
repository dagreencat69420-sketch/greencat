# Cat Wheel (archived)

**The Cat Wheel was removed Oct 12, 2026 by owner.** The spin/prize wheel (`request_spin` → ORAO VRF → `settle_spin`,
`refund_spin`, `set_wheel_params`) is no longer in the program, SDK, web app (`/wheel` redirects to `/`), scripts
(`wheel-spin`, `admin wheel`), API bonus kinds or CI. The last code with the wheel is git tag `wheel-final`.

Kept for compatibility: Config `wheel_*` fields (layout), the `wheel_bank` pool PDA (pool id 2, still withdrawable),
wheel error codes (not at the end of the enum, so removing them would shift other codes) and admin action number 3 (retired).

Original README summary:

- **Cat Wheel (legal-gated for mainnet):** `request_spin(bet, nonce, max_edge)` → ORAO VRF → `settle_spin` (anyone may crank) → 1/10 wins `bet × 10 × (1 − edge)`. Defaults: edge 3% (≤ 10%), bets 10–50,000 GC. `refund_spin` is only for expired, unfulfilled requests.
- **Airdrop:** off-chain snapshot → Merkle root (`create_airdrop`) → users `claim_airdrop` with a proof → `reclaim_airdrop` after expiry.
- **Admin:** two-step `propose_authority` / `accept_authority` (Squads-ready), `set_paused`, bounded setters.
