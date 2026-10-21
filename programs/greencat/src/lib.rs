//! GreenCat Holder App — Anchor program (Anchor 0.31.1).
//!
//! * Treasuries: Config + 6 pool PDAs + their $GC ATAs.
//! * NFT: 10k Metaplex NFTs in a **verified, sized collection**; the program PDA
//!   `nft_authority` is update authority of every NFT and of the collection, so
//!   holders cannot rewrite name/URI/attributes (AUDIT GC-18).
//! * Mint randomness (AUDIT GC-17): **instant per-mint reveal**. `mint_nft` takes the
//!   payment, mints the NFT and requests one ORAO VRF output; `settle_mint`
//!   (permissionless, strict FIFO) draws a random remaining token id with
//!   swap-and-pop and writes `GreenCat #id` / `{base}{id}.json` seconds later. The
//!   rarity catalog (100/900/2000/7000, seed `greencat-meme-collection-v1`) stays exact.
//! * Marketplace with slippage guards (AUDIT GC-21), staking, wheel with ORAO VRF
//!   request → fulfill → settle and expiry refunds (AUDIT GC-15), Merkle airdrop
//!   (AUDIT GC-22), two-step authority + pause (AUDIT GC-19), upgrade-authority
//!   gated init (AUDIT GC-20).

// Anchor 0.31.1's `#[program]` codegen calls `AccountInfo::realloc`, deprecated in
// solana-program 2.2; our own code uses `resize`. Remove when Anchor ships the fix.
#![allow(deprecated)]

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token::{self, Token},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

pub mod admin;
pub mod airdrop;
pub mod marketplace;
pub mod nft;
pub mod rarity;
pub mod stake;
pub mod vrf;

pub use admin::*;
pub use airdrop::*;
pub use marketplace::{Listing, Offer, MARKETPLACE_FEE_BPS};
pub use nft::*;
pub use stake::{
    DailyStake, LongState, LongTranche, DAILY_RATE_NUM, LONG_LOCK_SECONDS, PENDING_SCALE,
    SECONDS_PER_DAY,
};

// Program id: the `mainnet` feature build uses the fresh mainnet id (keys/mainnet-program.json, made
// 2026-10-20 PT, checklist 5.1); every other build (localnet/devnet/CI) keeps the Devnet id.
#[cfg(feature = "mainnet")]
declare_id!("2pwrnxCswbq9cjgfRWQAMJUp6n1MRALpURLBjbmFURdc");
#[cfg(not(feature = "mainnet"))]
declare_id!("8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE");

/// PDA seeds
pub const DAILY_REWARDS_SEED: &[u8] = b"daily_rewards";
pub const LONG_REWARDS_SEED: &[u8] = b"long_rewards";
pub const WHEEL_BANK_SEED: &[u8] = b"wheel_bank";
pub const NFT_FEE_TREASURY_SEED: &[u8] = b"nft_fee_treasury";
pub const MINT_PROCEEDS_SEED: &[u8] = b"mint_proceeds";
pub const AIRDROP_SEED: &[u8] = b"airdrop";
pub const CONFIG_SEED: &[u8] = b"config";
pub const COLLECTION_SEED: &[u8] = b"collection";
pub const NFT_RECORD_SEED: &[u8] = b"nft_record";
pub const LISTING_SEED: &[u8] = b"listing";
pub const OFFER_SEED: &[u8] = b"offer";
pub const DAILY_STAKE_SEED: &[u8] = b"daily_stake";
pub const LONG_STATE_SEED: &[u8] = b"long_state";
pub const LONG_TRANCHE_SEED: &[u8] = b"long_tranche";
pub const DAILY_PRINCIPAL_SEED: &[u8] = b"daily_principal";
pub const LONG_PRINCIPAL_SEED: &[u8] = b"long_principal";
pub const SPIN_REQUEST_SEED: &[u8] = b"spin_request";
/// AUDIT(GC-18): PDA that is update authority of every GreenCat NFT + the collection.
pub const NFT_AUTHORITY_SEED: &[u8] = b"nft_authority";
pub const COLLECTION_MINT_SEED: &[u8] = b"collection_mint";
pub const AIRDROP_DIST_SEED: &[u8] = b"airdrop_dist";
pub const AIRDROP_CLAIM_SEED: &[u8] = b"airdrop_claim";
/// Remaining-ids pool + reveal queue for the per-mint reveal (AUDIT GC-17).
pub const MINT_POOL_SEED: &[u8] = b"mint_pool";

/// AUDIT(GC-20): the live pump.fun $GC mint (Token-2022). Enforced by the `mainnet` feature.
pub const MAINNET_GC_MINT: Pubkey = pubkey!("G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump");

/// Assumed mint decimals for seed defaults (mainnet $GC = 6).
pub const GC_DECIMALS: u8 = 6;
pub(crate) const UI_SCALE: u64 = 1_000_000; // 10^6

/// Informational snapshot threshold (read by the off-chain Merkle snapshot script).
pub const DEFAULT_AIRDROP_MIN_HOLDING: u64 = 100_000 * UI_SCALE;
pub const DEFAULT_DAILY_PAYOUT_ALLOWANCE: u64 = 20_000_000 * UI_SCALE;
pub const DEFAULT_LONG_STAKE_CAPACITY: u64 = 100_000_000 * UI_SCALE;

/// Mint price: 10_000 $GC raw (6 decimals).
pub const MINT_PRICE_RAW: u64 = 10_000 * UI_SCALE;

/// Default metadata base URI (token JSON at `{base}{id}.json`).
pub const DEFAULT_METADATA_BASE_URI: &str = "https://www.greencat69420.com/nft/";

/// pool_id → seed bytes.
pub fn pool_seed(pool_id: u8) -> Result<&'static [u8]> {
    match pool_id {
        0 => Ok(DAILY_REWARDS_SEED),
        1 => Ok(LONG_REWARDS_SEED),
        2 => Ok(WHEEL_BANK_SEED),
        3 => Ok(NFT_FEE_TREASURY_SEED),
        4 => Ok(MINT_PROCEEDS_SEED),
        5 => Ok(AIRDROP_SEED),
        _ => err!(GreenCatError::InvalidPool),
    }
}

/// AUDIT(GC-01..GC-07): every program-controlled or counterparty token account that
/// is passed as an `UncheckedAccount` must be the canonical ATA of the expected
/// owner/mint/token-program. Without this, callers could substitute their own
/// token account and redirect payments / fake custody.
pub(crate) fn require_ata(
    account: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
    token_program: &Pubkey,
    err: GreenCatError,
) -> Result<()> {
    let expected =
        associated_token::get_associated_token_address_with_program_id(owner, mint, token_program);
    if *account != expected {
        msg!("expected ATA {} got {}", expected, account);
        return Err(err.into());
    }
    Ok(())
}

/// AUDIT(GC-19): one place for the pause check on user-facing entry points.
/// Exits that only return a user's own principal/escrow (cancel_listing,
/// cancel_offer, unstake_daily principal, claim_long principal, refund_spin) are
/// intentionally NOT gated so a pause can never trap user funds.
pub(crate) fn require_not_paused(config: &Config) -> Result<()> {
    require!(!config.paused, GreenCatError::Paused);
    Ok(())
}

/// Staking switch (owner decision 2026-10-03): new stakes (`stake_daily`, `add_daily`,
/// `stake_long`) need `staking_enabled`. `initialize_treasuries` writes an explicit
/// "locked" (flag set, disabled), so new deployments (mainnet) start locked until the
/// admin calls `set_staking_enabled(true)`. A Config written before this upgrade has both
/// bytes zero (old `_reserved`), which reads as OPEN, so an in-place upgrade never locks
/// existing users out. Exits (`unstake_daily`, `claim_daily`, `claim_long`) are never gated.
pub fn staking_enabled(config: &Config) -> bool {
    !config.staking_flag_set || config.staking_enabled
}

pub(crate) fn require_staking_enabled(config: &Config) -> Result<()> {
    require!(staking_enabled(config), GreenCatError::StakingLocked);
    Ok(())
}

/// Liability floor for `withdraw_treasury`: the authority can never withdraw
/// funds that are owed to users (AUDIT GC-09/GC-19/GC-22).
pub fn pool_withdraw_floor(config: &Config, pool_id: u8) -> u64 {
    match pool_id {
        1 => config.long_bonus_outstanding,
        2 => config.wheel_reserved,
        5 => config.airdrop_reserved,
        _ => 0,
    }
}

#[program]
pub mod greencat {
    use super::*;

    /// Create Config + 6 treasury PDAs + their $GC ATAs via CPI.
    /// AUDIT(GC-20): only the program's upgrade authority may call this (checked
    /// against ProgramData); the `mainnet` feature also pins the $GC mint.
    pub fn initialize_treasuries(ctx: Context<InitializeTreasuries>) -> Result<()> {
        process_initialize_treasuries(ctx)
    }

    /// Authority: create Collection PDA (rarity table + mint price + base URI).
    pub fn initialize_collection(
        ctx: Context<InitializeCollection>,
        metadata_base_uri: String,
    ) -> Result<()> {
        nft::process_initialize_collection(ctx, metadata_base_uri)
    }

    /// Authority: create the verified-collection NFT (sized) owned by `nft_authority`.
    pub fn create_collection_nft(ctx: Context<CreateCollectionNft>) -> Result<()> {
        nft::process_create_collection_nft(ctx)
    }

    /// Authority: royalty bps (≤ 10%) + creator address. Only before the first mint.
    pub fn set_royalty(
        ctx: Context<SetRoyalty>,
        royalty_bps: u16,
        recipient: Pubkey,
    ) -> Result<()> {
        nft::process_set_royalty(ctx, royalty_bps, recipient)
    }

    /// Authority: permanently stop minting.
    pub fn close_mint(ctx: Context<CloseMint>) -> Result<()> {
        nft::process_close_mint(ctx)
    }

    /// Anyone can deposit `amount` raw $GC into the selected treasury ATA.
    pub fn deposit_treasury(ctx: Context<DepositTreasury>, pool_id: u8, amount: u64) -> Result<()> {
        process_deposit_treasury(ctx, pool_id, amount)
    }

    /// Authority-only: move `amount` raw $GC from treasury ATA to `destination`.
    /// Never below the pool's liability floor. Allowed while paused (incident response).
    pub fn withdraw_treasury(
        ctx: Context<WithdrawTreasury>,
        pool_id: u8,
        amount: u64,
    ) -> Result<()> {
        process_withdraw_treasury(ctx, pool_id, amount)
    }

    /// Mint one GreenCat NFT for 10_000 $GC → mint_proceeds, and request its reveal
    /// VRF (buyer pays the ORAO fee). `settle_mint` reveals it seconds later.
    pub fn mint_nft(ctx: Context<MintNft>) -> Result<()> {
        nft::process_mint_nft(ctx)
    }

    /// Anyone: create / grow the remaining-ids pool PDA (≤ 10 KiB per call).
    pub fn init_mint_pool(ctx: Context<InitMintPool>) -> Result<()> {
        nft::process_init_mint_pool(ctx)
    }

    /// Anyone: first VRF request for an NFT minted before the per-mint upgrade, or a
    /// re-request after an expired, *unfulfilled* request.
    pub fn request_mint_vrf(ctx: Context<RequestMintVrf>) -> Result<()> {
        nft::process_request_mint_vrf(ctx)
    }

    /// Anyone: reveal the reveal-queue head from its fulfilled VRF output.
    pub fn settle_mint(ctx: Context<SettleMint>) -> Result<()> {
        nft::process_settle_mint(ctx)
    }

    pub fn list_nft(ctx: Context<ListNft>, price: u64) -> Result<()> {
        marketplace::process_list_nft(ctx, price)
    }

    pub fn cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
        marketplace::process_cancel_listing(ctx)
    }

    /// AUDIT(GC-21): reverts unless the listing price still equals `expected_price`.
    pub fn buy_nft(ctx: Context<BuyNft>, expected_price: u64) -> Result<()> {
        marketplace::process_buy_nft(ctx, expected_price)
    }

    pub fn make_offer(ctx: Context<MakeOffer>, amount: u64) -> Result<()> {
        marketplace::process_make_offer(ctx, amount)
    }

    pub fn cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
        marketplace::process_cancel_offer(ctx)
    }

    /// AUDIT(GC-21): reverts if the escrowed offer is below `min_amount`.
    pub fn accept_offer(ctx: Context<AcceptOffer>, min_amount: u64) -> Result<()> {
        marketplace::process_accept_offer(ctx, min_amount)
    }

    pub fn stake_daily(ctx: Context<StakeDaily>, amount: u64) -> Result<()> {
        stake::process_stake_daily(ctx, amount)
    }

    pub fn add_daily(ctx: Context<AddDaily>, amount: u64) -> Result<()> {
        stake::process_add_daily(ctx, amount)
    }

    pub fn claim_daily(ctx: Context<ClaimDaily>) -> Result<()> {
        stake::process_claim_daily(ctx)
    }

    pub fn unstake_daily(ctx: Context<UnstakeDaily>) -> Result<()> {
        stake::process_unstake_daily(ctx)
    }

    pub fn stake_long(ctx: Context<StakeLong>, amount: u64, tranche_id: u64) -> Result<()> {
        stake::process_stake_long(ctx, amount, tranche_id)
    }

    pub fn claim_long(ctx: Context<ClaimLong>, _tranche_id: u64) -> Result<()> {
        stake::process_claim_long(ctx)
    }

    // ── admin (AUDIT GC-19) ────────────────────────────────────────────────

    pub fn propose_authority(ctx: Context<ProposeAuthority>, new_authority: Pubkey) -> Result<()> {
        admin::process_propose_authority(ctx, new_authority)
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        admin::process_accept_authority(ctx)
    }

    pub fn set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
        admin::process_set_paused(ctx, paused)
    }

    pub fn set_vrf_expiry(ctx: Context<AdminConfig>, expiry_secs: i64) -> Result<()> {
        admin::process_set_vrf_expiry(ctx, expiry_secs)
    }

    /// Admin: open (`true`) or lock (`false`) NEW stakes (daily + 365-day). Unstake/claim stay open.
    pub fn set_staking_enabled(ctx: Context<AdminConfig>, enabled: bool) -> Result<()> {
        admin::process_set_staking_enabled(ctx, enabled)
    }

    /// Informational threshold used by the off-chain snapshot script.
    pub fn set_airdrop_threshold(ctx: Context<AdminConfig>, min_holding: u64) -> Result<()> {
        admin::process_set_airdrop_threshold(ctx, min_holding)
    }

    /// Authority: move SOL royalties that marketplaces paid to the nft_fee_treasury PDA.
    pub fn sweep_fee_treasury_sol(ctx: Context<SweepFeeTreasurySol>, amount: u64) -> Result<()> {
        admin::process_sweep_fee_treasury_sol(ctx, amount)
    }

    // ── Merkle airdrop (AUDIT GC-22) ───────────────────────────────────────

    pub fn create_airdrop(
        ctx: Context<CreateAirdrop>,
        id: u64,
        merkle_root: [u8; 32],
        total_amount: u64,
        expiry_ts: i64,
    ) -> Result<()> {
        airdrop::process_create_airdrop(ctx, id, merkle_root, total_amount, expiry_ts)
    }

    pub fn claim_airdrop(
        ctx: Context<ClaimAirdrop>,
        index: u64,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        airdrop::process_claim_airdrop(ctx, index, amount, proof)
    }

    pub fn reclaim_airdrop(ctx: Context<ReclaimAirdrop>) -> Result<()> {
        airdrop::process_reclaim_airdrop(ctx)
    }
}

#[inline(never)]
fn process_initialize_treasuries(ctx: Context<InitializeTreasuries>) -> Result<()> {
    #[cfg(feature = "mainnet")]
    {
        require_keys_eq!(
            ctx.accounts.gc_mint.key(),
            MAINNET_GC_MINT,
            GreenCatError::MintMismatch
        );
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            anchor_spl::token_2022::ID,
            GreenCatError::MintMismatch
        );
    }

    let vaults: [(&AccountInfo, &AccountInfo); 6] = [
        (
            &ctx.accounts.daily_rewards.to_account_info(),
            &ctx.accounts.daily_rewards_vault.to_account_info(),
        ),
        (
            &ctx.accounts.long_rewards.to_account_info(),
            &ctx.accounts.long_rewards_vault.to_account_info(),
        ),
        (
            &ctx.accounts.wheel_bank.to_account_info(),
            &ctx.accounts.wheel_bank_vault.to_account_info(),
        ),
        (
            &ctx.accounts.nft_fee_treasury.to_account_info(),
            &ctx.accounts.nft_fee_treasury_vault.to_account_info(),
        ),
        (
            &ctx.accounts.mint_proceeds.to_account_info(),
            &ctx.accounts.mint_proceeds_vault.to_account_info(),
        ),
        (
            &ctx.accounts.airdrop.to_account_info(),
            &ctx.accounts.airdrop_vault.to_account_info(),
        ),
    ];

    for (authority, vault) in vaults {
        require_ata(
            vault.key,
            authority.key,
            &ctx.accounts.gc_mint.key(),
            &ctx.accounts.token_program.key(),
            GreenCatError::InvalidVault,
        )?;
        if vault.data_is_empty() {
            associated_token::create(CpiContext::new(
                ctx.accounts.associated_token_program.to_account_info(),
                associated_token::Create {
                    payer: ctx.accounts.authority.to_account_info(),
                    associated_token: vault.clone(),
                    authority: authority.clone(),
                    mint: ctx.accounts.gc_mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
            ))?;
        }
    }

    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.gc_mint = ctx.accounts.gc_mint.key();
    config.token_program = ctx.accounts.token_program.key();
    config.bump = ctx.bumps.config;
    config.daily_rewards_bump = ctx.bumps.daily_rewards;
    config.long_rewards_bump = ctx.bumps.long_rewards;
    config.wheel_bank_bump = ctx.bumps.wheel_bank;
    config.nft_fee_treasury_bump = ctx.bumps.nft_fee_treasury;
    config.mint_proceeds_bump = ctx.bumps.mint_proceeds;
    config.airdrop_bump = ctx.bumps.airdrop;
    config.paused = false;
    config.airdrop_min_holding = DEFAULT_AIRDROP_MIN_HOLDING;
    config.daily_payout_allowance = DEFAULT_DAILY_PAYOUT_ALLOWANCE;
    // Wheel removed Oct 12, 2026 (owner): wheel_* Config fields are kept for layout only and start at 0.
    config.wheel_payout_allowance = 0;
    config.long_stake_capacity = DEFAULT_LONG_STAKE_CAPACITY;
    config.total_deposited = 0;
    config.total_withdrawn = 0;
    config.daily_lifetime_paid = 0;
    config.long_staked = 0;
    config.airdrop_reserved = 0;
    config.long_bonus_outstanding = 0;
    config.wheel_lifetime_paid = 0;
    config.wheel_lifetime_lost = 0;
    config.wheel_reserved = 0;
    config.pending_authority = Pubkey::default();
    config.wheel_min_bet = 0;
    config.wheel_max_bet = 0;
    config.vrf_expiry_secs = vrf::DEFAULT_VRF_EXPIRY_SECS;
    config.last_pause_change_ts = now;
    config.wheel_house_edge_bps = 0;
    // New deployments start with staking LOCKED (explicit flag); the admin opens it later.
    config.staking_enabled = false;
    config.staking_flag_set = true;
    config._reserved = [0u8; 28];

    msg!(
        "initialize_treasuries: mint={} authority={}",
        config.gc_mint,
        config.authority
    );
    Ok(())
}

#[inline(never)]
fn process_deposit_treasury(ctx: Context<DepositTreasury>, pool_id: u8, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    require!(amount > 0, GreenCatError::ZeroAmount);
    require_keys_eq!(
        ctx.accounts.config.gc_mint,
        ctx.accounts.gc_mint.key(),
        GreenCatError::MintMismatch
    );

    let seed = pool_seed(pool_id)?;
    let (expected, _bump) = Pubkey::find_program_address(&[seed], ctx.program_id);
    require_keys_eq!(
        ctx.accounts.treasury.key(),
        expected,
        GreenCatError::InvalidPool
    );
    require_keys_eq!(
        ctx.accounts.treasury_vault.owner,
        ctx.accounts.treasury.key(),
        GreenCatError::InvalidVault
    );
    require_keys_eq!(
        ctx.accounts.treasury_vault.mint,
        ctx.accounts.gc_mint.key(),
        GreenCatError::MintMismatch
    );

    let decimals = ctx.accounts.gc_mint.decimals;
    transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.depositor_ata.to_account_info(),
                mint: ctx.accounts.gc_mint.to_account_info(),
                to: ctx.accounts.treasury_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        decimals,
    )?;

    let config = &mut ctx.accounts.config;
    config.total_deposited = config
        .total_deposited
        .checked_add(amount)
        .ok_or(GreenCatError::Overflow)?;

    msg!(
        "deposit_treasury: pool={} amount={} depositor={}",
        pool_id,
        amount,
        ctx.accounts.depositor.key()
    );
    Ok(())
}

#[inline(never)]
fn process_withdraw_treasury(
    ctx: Context<WithdrawTreasury>,
    pool_id: u8,
    amount: u64,
) -> Result<()> {
    // AUDIT(GC-19): deliberately NOT pause-gated — the authority may need to move
    // funds to a safe address during an incident — but never below the pool's
    // user-liability floor (see `pool_withdraw_floor`).
    require!(amount > 0, GreenCatError::ZeroAmount);
    require_keys_eq!(
        ctx.accounts.config.authority,
        ctx.accounts.authority.key(),
        GreenCatError::Unauthorized
    );
    require_keys_eq!(
        ctx.accounts.config.gc_mint,
        ctx.accounts.gc_mint.key(),
        GreenCatError::MintMismatch
    );
    require_keys_eq!(
        ctx.accounts.destination.mint,
        ctx.accounts.gc_mint.key(),
        GreenCatError::MintMismatch
    );

    let seed = pool_seed(pool_id)?;
    let (expected, bump) = Pubkey::find_program_address(&[seed], ctx.program_id);
    require_keys_eq!(
        ctx.accounts.treasury.key(),
        expected,
        GreenCatError::InvalidPool
    );
    require_keys_eq!(
        ctx.accounts.treasury_vault.owner,
        ctx.accounts.treasury.key(),
        GreenCatError::InvalidVault
    );

    let left = ctx
        .accounts
        .treasury_vault
        .amount
        .checked_sub(amount)
        .ok_or(GreenCatError::Overflow)?;
    let floor = pool_withdraw_floor(&ctx.accounts.config, pool_id);
    if left < floor {
        return Err(match pool_id {
            2 => GreenCatError::WheelReserveLocked,
            _ => GreenCatError::LiabilityFloor,
        }
        .into());
    }

    let decimals = ctx.accounts.gc_mint.decimals;
    let signer_seeds: &[&[&[u8]]] = &[&[seed, &[bump]]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.treasury_vault.to_account_info(),
                mint: ctx.accounts.gc_mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.treasury.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        decimals,
    )?;

    let config = &mut ctx.accounts.config;
    config.total_withdrawn = config
        .total_withdrawn
        .checked_add(amount)
        .ok_or(GreenCatError::Overflow)?;

    msg!(
        "withdraw_treasury: pool={} amount={} to={}",
        pool_id,
        amount,
        ctx.accounts.destination.key()
    );
    Ok(())
}

// ─── Accounts ───────────────────────────────────────────────────────────────

#[account]
pub struct Config {
    pub authority: Pubkey,
    pub gc_mint: Pubkey,
    pub token_program: Pubkey,
    pub bump: u8,
    pub daily_rewards_bump: u8,
    pub long_rewards_bump: u8,
    pub wheel_bank_bump: u8,
    pub nft_fee_treasury_bump: u8,
    pub mint_proceeds_bump: u8,
    pub airdrop_bump: u8,
    pub paused: bool,
    /// Informational snapshot threshold for the off-chain Merkle airdrop script.
    pub airdrop_min_holding: u64,
    pub daily_payout_allowance: u64,
    pub wheel_payout_allowance: u64,
    pub long_stake_capacity: u64,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
    /// Sum of daily claim payouts (raw).
    pub daily_lifetime_paid: u64,
    /// Site-wide locked 365 principal (raw).
    pub long_staked: u64,
    /// AUDIT(GC-22): $GC in the airdrop vault reserved for open Merkle distributions.
    pub airdrop_reserved: u64,
    /// AUDIT(GC-19): sum of `bonus_owed` of all long tranches (withdraw floor of pool 1).
    pub long_bonus_outstanding: u64,
    /// Sum of wheel win payouts credited to players (raw).
    pub wheel_lifetime_paid: u64,
    /// Sum of wheel bets kept by the bank on losses (raw).
    pub wheel_lifetime_lost: u64,
    /// AUDIT(GC-09): sum of win payouts of all pending SpinRequests.
    pub wheel_reserved: u64,
    /// AUDIT(GC-19): proposed new authority (two-step handover). Default = none.
    pub pending_authority: Pubkey,
    pub wheel_min_bet: u64,
    pub wheel_max_bet: u64,
    /// AUDIT(GC-15): seconds after which an *unfulfilled* VRF request may be refunded / re-requested.
    pub vrf_expiry_secs: i64,
    pub last_pause_change_ts: i64,
    /// House edge applied to the 10× win (300 = 3% → 9.7×). ≤ WHEEL_MAX_HOUSE_EDGE_BPS.
    pub wheel_house_edge_bps: u16,
    /// New stakes allowed (see `staking_enabled()`); only meaningful when `staking_flag_set`.
    pub staking_enabled: bool,
    /// Written by `initialize_treasuries` / `set_staking_enabled`. Zero on a Config created
    /// before the staking-switch upgrade, which keeps staking open there.
    pub staking_flag_set: bool,
    pub _reserved: [u8; 28],
}

impl Config {
    // disc + 3·pubkey + 7 bumps + paused + 13·u64 (=216) + pubkey + 4·u64 + u16 + 2 bools + 28
    pub const LEN: usize = 8 + 32 * 3 + 7 + 1 + 8 * 13 + 32 + 8 * 4 + 2 + 2 + 28;
}

#[account]
pub struct NftRecord {
    pub mint: Pubkey,
    pub buyer: Pubkey,
    /// Final token id 1..=10_000; 0 until `reveal_nft`.
    pub token_id: u16,
    /// 0 common · 1 uncommon · 2 rare · 3 legendary · 255 unrevealed.
    pub rarity: u8,
    pub bump: u8,
    /// Sequential 0-based mint order (input to the reveal rotation).
    pub mint_index: u16,
    pub revealed: bool,
    pub _pad: [u8; 5],
}

impl NftRecord {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 1 + 1 + 2 + 1 + 5;
}

pub const RARITY_UNREVEALED: u8 = 255;

// ─── Events ─────────────────────────────────────────────────────────────────

/// token_id = 0 and rarity = 255 until reveal (layout kept for indexer compat).
#[event]
pub struct NftMinted {
    pub token_id: u16,
    pub rarity: u8,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub mint_index: u16,
}

#[event]
pub struct NftRevealed {
    pub mint: Pubkey,
    pub mint_index: u16,
    pub token_id: u16,
    pub rarity: u8,
}

#[event]
pub struct AirdropClaimed {
    pub distribution: Pubkey,
    pub index: u64,
    pub claimant: Pubkey,
    pub amount: u64,
}

#[event]
pub struct AdminAction {
    /// 0 propose_authority · 1 accept_authority · 2 set_paused · 3 retired (set_wheel_params; wheel removed Oct 12, 2026) ·
    /// 4 set_vrf_expiry · 5 set_royalty · 6 close_mint · 7 set_airdrop_threshold ·
    /// 8 sweep_fee_treasury_sol · 9 set_staking_enabled · 10–16 retired (Cat Fight,
    /// removed Oct 12, 2026)
    pub action: u8,
    pub actor: Pubkey,
    pub value: u64,
    pub key: Pubkey,
}

// ─── Account contexts ───────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeTreasuries<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Config::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, Config>>,

    /// AUDIT(GC-12): mint must be owned by the token program recorded in Config.
    #[account(mint::token_program = token_program)]
    pub gc_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: PDA vault authority for daily_rewards
    #[account(seeds = [DAILY_REWARDS_SEED], bump)]
    pub daily_rewards: UncheckedAccount<'info>,
    /// CHECK: ATA owned by daily_rewards (checked in handler)
    #[account(mut)]
    pub daily_rewards_vault: UncheckedAccount<'info>,

    /// CHECK: PDA vault authority for long_rewards
    #[account(seeds = [LONG_REWARDS_SEED], bump)]
    pub long_rewards: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub long_rewards_vault: UncheckedAccount<'info>,

    /// CHECK: PDA vault authority for wheel_bank
    #[account(seeds = [WHEEL_BANK_SEED], bump)]
    pub wheel_bank: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub wheel_bank_vault: UncheckedAccount<'info>,

    /// CHECK: PDA vault authority for nft_fee_treasury
    #[account(seeds = [NFT_FEE_TREASURY_SEED], bump)]
    pub nft_fee_treasury: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub nft_fee_treasury_vault: UncheckedAccount<'info>,

    /// CHECK: PDA vault authority for mint_proceeds
    #[account(seeds = [MINT_PROCEEDS_SEED], bump)]
    pub mint_proceeds: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub mint_proceeds_vault: UncheckedAccount<'info>,

    /// CHECK: PDA vault authority for airdrop
    #[account(seeds = [AIRDROP_SEED], bump)]
    pub airdrop: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub airdrop_vault: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// AUDIT(GC-20): this program + its ProgramData; signer must be the upgrade authority.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ GreenCatError::NotUpgradeAuthority
    )]
    pub program: Program<'info, crate::program::Greencat>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ GreenCatError::NotUpgradeAuthority
    )]
    pub program_data: Box<Account<'info, ProgramData>>,
}

#[derive(Accounts)]
pub struct DepositTreasury<'info> {
    pub depositor: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub gc_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: validated against pool_id seed in handler
    pub treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = gc_mint,
        token::token_program = token_program,
    )]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = gc_mint,
        token::authority = depositor,
        token::token_program = token_program,
    )]
    pub depositor_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    pub authority: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub gc_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: validated against pool_id seed
    pub treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = gc_mint,
        token::token_program = token_program,
    )]
    pub treasury_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = gc_mint,
        token::token_program = token_program,
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

// ─── Account contexts ────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ListNft<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub nft_mint: Account<'info, token::Mint>,

    #[account(
        init,
        payer = seller,
        space = Listing::LEN,
        seeds = [LISTING_SEED, nft_mint.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,

    #[account(
        mut,
        constraint = seller_nft_ata.mint == nft_mint.key() @ GreenCatError::MintMismatch,
        constraint = seller_nft_ata.owner == seller.key() @ GreenCatError::Unauthorized,
    )]
    pub seller_nft_ata: Account<'info, token::TokenAccount>,

    /// CHECK: listing-owned NFT ATA (created in handler if empty)
    #[account(mut)]
    pub escrow_nft_ata: UncheckedAccount<'info>,

    pub nft_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,

    /// AUDIT(GC-08): only NFTs minted by this program (NftRecord exists) can be listed.
    /// Appended last so existing clients only need to add one trailing account.
    #[account(
        seeds = [NFT_RECORD_SEED, nft_mint.key().as_ref()],
        bump = nft_record.bump,
        constraint = nft_record.mint == nft_mint.key() @ GreenCatError::MintMismatch,
    )]
    pub nft_record: Account<'info, NftRecord>,
}

#[derive(Accounts)]
pub struct CancelListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub nft_mint: Account<'info, token::Mint>,

    #[account(
        mut,
        seeds = [LISTING_SEED, nft_mint.key().as_ref()],
        bump = listing.bump,
        has_one = seller @ GreenCatError::Unauthorized,
        has_one = nft_mint @ GreenCatError::MintMismatch,
        constraint = listing.active @ GreenCatError::ListingInactive,
        close = seller
    )]
    pub listing: Account<'info, Listing>,

    /// CHECK: escrow ATA owned by listing
    #[account(mut)]
    pub escrow_nft_ata: UncheckedAccount<'info>,

    /// CHECK: seller NFT ATA (created if needed)
    #[account(mut)]
    pub seller_nft_ata: UncheckedAccount<'info>,

    pub nft_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyNft<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: listing seller — receives net proceeds + rent
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: $GC mint (Token-2022 or classic)
    pub gc_mint: UncheckedAccount<'info>,

    pub nft_mint: Account<'info, token::Mint>,

    #[account(
        mut,
        seeds = [LISTING_SEED, nft_mint.key().as_ref()],
        bump = listing.bump,
        has_one = nft_mint @ GreenCatError::MintMismatch,
        constraint = listing.active @ GreenCatError::ListingInactive,
        close = seller
    )]
    pub listing: Account<'info, Listing>,

    /// CHECK: escrow NFT ATA
    #[account(mut)]
    pub escrow_nft_ata: UncheckedAccount<'info>,

    /// CHECK: buyer NFT ATA
    #[account(mut)]
    pub buyer_nft_ata: UncheckedAccount<'info>,

    /// CHECK: buyer $GC ATA
    #[account(mut)]
    pub buyer_gc_ata: UncheckedAccount<'info>,

    /// CHECK: seller $GC ATA
    #[account(mut)]
    pub seller_gc_ata: UncheckedAccount<'info>,

    /// CHECK: nft_fee_treasury PDA
    #[account(seeds = [NFT_FEE_TREASURY_SEED], bump = config.nft_fee_treasury_bump)]
    pub nft_fee_treasury: UncheckedAccount<'info>,

    /// CHECK: fee vault ATA
    #[account(mut)]
    pub nft_fee_treasury_vault: UncheckedAccount<'info>,

    /// CHECK: $GC token program
    pub gc_token_program: UncheckedAccount<'info>,
    pub nft_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MakeOffer<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: $GC mint
    pub gc_mint: UncheckedAccount<'info>,

    pub nft_mint: Account<'info, token::Mint>,

    #[account(
        seeds = [NFT_RECORD_SEED, nft_mint.key().as_ref()],
        bump = nft_record.bump,
        constraint = nft_record.mint == nft_mint.key() @ GreenCatError::MintMismatch,
    )]
    pub nft_record: Account<'info, NftRecord>,

    #[account(
        init,
        payer = bidder,
        space = Offer::LEN,
        seeds = [OFFER_SEED, nft_mint.key().as_ref(), bidder.key().as_ref()],
        bump
    )]
    pub offer: Account<'info, Offer>,

    /// CHECK: bidder $GC ATA
    #[account(mut)]
    pub bidder_gc_ata: UncheckedAccount<'info>,

    /// CHECK: offer-owned $GC escrow ATA
    #[account(mut)]
    pub offer_gc_escrow: UncheckedAccount<'info>,

    /// CHECK: $GC token program
    pub gc_token_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelOffer<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: $GC mint
    pub gc_mint: UncheckedAccount<'info>,

    pub nft_mint: Account<'info, token::Mint>,

    #[account(
        mut,
        seeds = [OFFER_SEED, nft_mint.key().as_ref(), bidder.key().as_ref()],
        bump = offer.bump,
        has_one = bidder @ GreenCatError::Unauthorized,
        has_one = nft_mint @ GreenCatError::MintMismatch,
        constraint = offer.active @ GreenCatError::OfferInactive,
        close = bidder
    )]
    pub offer: Account<'info, Offer>,

    /// CHECK: bidder $GC ATA
    #[account(mut)]
    pub bidder_gc_ata: UncheckedAccount<'info>,

    /// CHECK: offer escrow
    #[account(mut)]
    pub offer_gc_escrow: UncheckedAccount<'info>,

    /// CHECK: $GC token program
    pub gc_token_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: bidder receives NFT; offer rent returned here
    #[account(mut)]
    pub bidder: UncheckedAccount<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// CHECK: $GC mint
    pub gc_mint: UncheckedAccount<'info>,

    pub nft_mint: Account<'info, token::Mint>,

    #[account(
        mut,
        seeds = [OFFER_SEED, nft_mint.key().as_ref(), bidder.key().as_ref()],
        bump = offer.bump,
        has_one = nft_mint @ GreenCatError::MintMismatch,
        constraint = offer.active @ GreenCatError::OfferInactive,
        close = bidder
    )]
    pub offer: Account<'info, Offer>,

    /// CHECK: offer $GC escrow
    #[account(mut)]
    pub offer_gc_escrow: UncheckedAccount<'info>,

    /// CHECK: owner $GC ATA (net proceeds)
    #[account(mut)]
    pub owner_gc_ata: UncheckedAccount<'info>,

    /// CHECK: nft_fee_treasury PDA
    #[account(seeds = [NFT_FEE_TREASURY_SEED], bump = config.nft_fee_treasury_bump)]
    pub nft_fee_treasury: UncheckedAccount<'info>,

    /// CHECK: fee vault
    #[account(mut)]
    pub nft_fee_treasury_vault: UncheckedAccount<'info>,

    /// CHECK: owner NFT ATA (used when not listed)
    #[account(mut)]
    pub owner_nft_ata: UncheckedAccount<'info>,

    /// CHECK: listing escrow NFT ATA (used when listed)
    #[account(mut)]
    pub escrow_nft_ata: UncheckedAccount<'info>,

    /// CHECK: listing PDA — closed if active for this mint/owner
    #[account(mut)]
    pub listing: UncheckedAccount<'info>,

    /// CHECK: bidder NFT ATA
    #[account(mut)]
    pub bidder_nft_ata: UncheckedAccount<'info>,

    /// CHECK: $GC token program
    pub gc_token_program: UncheckedAccount<'info>,
    pub nft_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StakeDaily<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub gc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = staker,
        space = DailyStake::LEN,
        seeds = [DAILY_STAKE_SEED, staker.key().as_ref()],
        bump
    )]
    pub daily_stake: Account<'info, DailyStake>,

    /// CHECK: PDA authority for daily principal vault
    #[account(seeds = [DAILY_PRINCIPAL_SEED], bump)]
    pub daily_principal: UncheckedAccount<'info>,
    /// CHECK: ATA owned by daily_principal (created via CPI if empty)
    #[account(mut)]
    pub daily_principal_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub staker_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddDaily<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub gc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [DAILY_STAKE_SEED, staker.key().as_ref()],
        bump = daily_stake.bump,
        constraint = daily_stake.owner == staker.key() @ GreenCatError::Unauthorized,
    )]
    pub daily_stake: Account<'info, DailyStake>,

    /// CHECK: PDA authority for daily principal vault
    #[account(seeds = [DAILY_PRINCIPAL_SEED], bump)]
    pub daily_principal: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub daily_principal_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub staker_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimDaily<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub gc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [DAILY_STAKE_SEED, staker.key().as_ref()],
        bump = daily_stake.bump,
    )]
    pub daily_stake: Account<'info, DailyStake>,

    /// CHECK: daily_rewards treasury PDA
    #[account(seeds = [DAILY_REWARDS_SEED], bump = config.daily_rewards_bump)]
    pub daily_rewards: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = daily_rewards_vault.owner == daily_rewards.key() @ GreenCatError::InvalidVault,
        constraint = daily_rewards_vault.mint == gc_mint.key() @ GreenCatError::MintMismatch,
    )]
    pub daily_rewards_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub staker_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct UnstakeDaily<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub gc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [DAILY_STAKE_SEED, staker.key().as_ref()],
        bump = daily_stake.bump,
    )]
    pub daily_stake: Account<'info, DailyStake>,

    /// CHECK: daily principal PDA
    #[account(seeds = [DAILY_PRINCIPAL_SEED], bump)]
    pub daily_principal: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub daily_principal_vault: UncheckedAccount<'info>,

    /// CHECK: daily_rewards treasury PDA
    #[account(seeds = [DAILY_REWARDS_SEED], bump = config.daily_rewards_bump)]
    pub daily_rewards: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = daily_rewards_vault.owner == daily_rewards.key() @ GreenCatError::InvalidVault,
        constraint = daily_rewards_vault.mint == gc_mint.key() @ GreenCatError::MintMismatch,
    )]
    pub daily_rewards_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub staker_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(amount: u64, tranche_id: u64)]
pub struct StakeLong<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub gc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = staker,
        space = LongState::LEN,
        seeds = [LONG_STATE_SEED, staker.key().as_ref()],
        bump
    )]
    pub long_state: Account<'info, LongState>,

    #[account(
        init,
        payer = staker,
        space = LongTranche::LEN,
        seeds = [LONG_TRANCHE_SEED, staker.key().as_ref(), &tranche_id.to_le_bytes()],
        bump
    )]
    pub tranche: Account<'info, LongTranche>,

    /// CHECK: long principal PDA
    #[account(seeds = [LONG_PRINCIPAL_SEED], bump)]
    pub long_principal: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub long_principal_vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub staker_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tranche_id: u64)]
pub struct ClaimLong<'info> {
    #[account(mut)]
    pub staker: Signer<'info>,

    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub gc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [LONG_TRANCHE_SEED, staker.key().as_ref(), &tranche_id.to_le_bytes()],
        bump = tranche.bump,
    )]
    pub tranche: Account<'info, LongTranche>,

    /// CHECK: long principal PDA
    #[account(seeds = [LONG_PRINCIPAL_SEED], bump)]
    pub long_principal: UncheckedAccount<'info>,
    /// CHECK: ATA
    #[account(mut)]
    pub long_principal_vault: UncheckedAccount<'info>,

    /// CHECK: long_rewards treasury PDA
    #[account(seeds = [LONG_REWARDS_SEED], bump = config.long_rewards_bump)]
    pub long_rewards: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = long_rewards_vault.owner == long_rewards.key() @ GreenCatError::InvalidVault,
        constraint = long_rewards_vault.mint == gc_mint.key() @ GreenCatError::MintMismatch,
    )]
    pub long_rewards_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub staker_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum GreenCatError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Program is paused")]
    Paused,
    #[msg("Invalid pool_id (expected 0..5)")]
    InvalidPool,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("Mint does not match config")]
    MintMismatch,
    #[msg("Treasury vault authority mismatch")]
    InvalidVault,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Collection sold out")]
    SoldOut,
    #[msg("Token id already minted")]
    AlreadyMinted,
    #[msg("Metadata base URI too long (max 128)")]
    UriTooLong,
    #[msg("Invalid Metaplex metadata/edition PDA")]
    InvalidMetadata,
    #[msg("Invalid SlotHashes sysvar (removed)")]
    InvalidSlotHashes,
    #[msg("Listing is not active")]
    ListingInactive,
    #[msg("Offer is not active")]
    OfferInactive,
    #[msg("Cannot trade with yourself")]
    SelfTrade,
    #[msg("Seller does not hold the NFT")]
    InsufficientNft,
    #[msg("Invalid listing account")]
    InvalidListing,
    #[msg("Invalid offer account")]
    InvalidOffer,
    #[msg("Daily lifetime payout allowance exhausted")]
    DailyPayoutExhausted,
    #[msg("Reward pool empty or insufficient")]
    EmptyRewardPool,
    #[msg("Nothing to claim (need a full accrual period)")]
    NothingToClaim,
    #[msg("Minimum 24h lock not finished")]
    MinLockNotMet,
    #[msg("Stake is not active")]
    StakeInactive,
    #[msg("365-day staking capacity full site-wide")]
    LongCapacityFull,
    #[msg("Tranche still locked until unlock_at")]
    StillLocked,
    #[msg("tranche_id does not match next_tranche_id")]
    BadTrancheId,
    #[msg("Airdrop pool is empty")]
    EmptyAirdropPool,
    #[msg("(removed) No qualifiers")]
    NoQualifiers,
    #[msg("(removed) per_user would be 0")]
    ZeroPerUser,
    #[msg("(removed) Airdrop prepare already active")]
    AirdropAlreadyPrepared,
    #[msg("(removed) No active airdrop prepare")]
    AirdropNotPrepared,
    #[msg("(removed) No recipient ATAs")]
    NoRecipients,
    #[msg("(removed) Recipient below threshold")]
    RecipientBelowThreshold,
    #[msg("Recipient account is not a valid token account")]
    InvalidRecipientAta,
    #[msg("(removed) Recipient token account must be writable")]
    RecipientNotWritable,
    #[msg("(removed) Too many recipients in one batch")]
    AirdropBatchTooLarge,
    #[msg("(removed) Batch size exceeds remaining airdrop slots")]
    AirdropSlotsExhausted,
    #[msg("(removed) Duplicate recipient ATA in batch")]
    DuplicateRecipient,
    #[msg("Wheel locked: lifetime payout allowance or bank cannot cover max win")]
    WheelLocked,
    #[msg("SpinRequest nonce mismatch")]
    BadSpinNonce,
    #[msg("SpinRequest already settled")]
    SpinAlreadySettled,
    #[msg("VRF provider not configured")]
    VrfNotConfigured,
    // ── audit round 1 ──
    #[msg("Payment vault is not the mint_proceeds ATA")]
    InvalidProceedsVault,
    #[msg("Principal vault is not the staking principal ATA")]
    InvalidPrincipalVault,
    #[msg("Fee vault is not the nft_fee_treasury ATA")]
    InvalidFeeVault,
    #[msg("Counterparty token account is not the expected ATA")]
    InvalidPayoutAccount,
    #[msg("Escrow account is not the expected PDA-owned ATA")]
    InvalidEscrow,
    #[msg("Withdrawal would dip into wheel funds reserved for pending spins")]
    WheelReserveLocked,
    #[msg("Airdrop recipient cannot be the airdrop vault")]
    AirdropRecipientIsVault,
    // ── audit round 2 ──
    #[msg("Signer is not the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Withdrawal would dip into funds owed to users (liability floor)")]
    LiabilityFloor,
    #[msg("Listing price changed (expected_price mismatch)")]
    PriceMismatch,
    #[msg("Offer amount is below min_amount")]
    OfferBelowMinimum,
    #[msg("Bet outside [wheel_min_bet, wheel_max_bet]")]
    BetOutOfRange,
    #[msg("House edge above the caller's max_house_edge_bps")]
    HouseEdgeChanged,
    #[msg("Invalid wheel parameters (edge ≤ 10%, 0 < min ≤ max ≤ hard cap)")]
    InvalidWheelParams,
    #[msg("Account is not the expected ORAO VRF randomness account")]
    InvalidVrfAccount,
    #[msg("VRF randomness not fulfilled yet")]
    VrfNotFulfilled,
    #[msg("VRF randomness already fulfilled; settle instead")]
    VrfAlreadyFulfilled,
    #[msg("VRF request not expired yet")]
    VrfNotExpired,
    #[msg("Expiry outside the allowed window")]
    InvalidExpiry,
    #[msg("No pending authority / signer is not the pending authority")]
    NoPendingAuthority,
    #[msg("Invalid authority (default pubkey or unchanged)")]
    InvalidAuthority,
    #[msg("Mint is closed")]
    MintClosed,
    #[msg("Reveal not available yet (needs sell-out or closed mint)")]
    RevealNotReady,
    #[msg("Reveal already requested")]
    RevealAlreadyRequested,
    #[msg("Collection already revealed / NFT already revealed")]
    AlreadyRevealed,
    #[msg("Collection not revealed yet")]
    NotRevealed,
    #[msg("Collection NFT not created yet")]
    CollectionNftMissing,
    #[msg("Collection NFT already created")]
    CollectionNftExists,
    #[msg("Royalty above the 10% cap")]
    RoyaltyTooHigh,
    #[msg("Royalty can only change before the first mint")]
    RoyaltyLocked,
    #[msg("Invalid Merkle proof")]
    InvalidMerkleProof,
    #[msg("Merkle proof too long")]
    ProofTooLong,
    #[msg("Airdrop claim window has ended")]
    AirdropExpired,
    #[msg("Airdrop claim window still open")]
    AirdropNotExpired,
    #[msg("Airdrop already reclaimed")]
    AirdropAlreadyReclaimed,
    #[msg("Claim exceeds distribution total")]
    AirdropOverClaim,
    #[msg("Airdrop vault lacks unreserved funds for this distribution")]
    AirdropInsufficientFunds,
    #[msg("Reclaim blocked while paused or within the post-unpause grace period")]
    ReclaimGracePeriod,
    #[msg("Collection mint does not match")]
    InvalidCollectionMint,
    #[msg("Invalid parameter")]
    InvalidParam,
    // ── per-mint reveal ──
    #[msg("Mint pool already fully initialized")]
    MintPoolReady,
    #[msg("Too many mints waiting to be revealed; settle the queue first")]
    MintQueueFull,
    #[msg("Not the reveal-queue head; settle earlier mints first")]
    NotQueueHead,
    #[msg("Reveal queue slot belongs to a different NFT")]
    MintRequestMismatch,
    // ── staking switch ──
    #[msg("Staking is locked (opens after the launch airdrop); unstake and claim still work")]
    StakingLocked,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_id_mapping() {
        assert_eq!(pool_seed(0).unwrap(), DAILY_REWARDS_SEED);
        assert_eq!(pool_seed(4).unwrap(), MINT_PROCEEDS_SEED);
        assert_eq!(pool_seed(5).unwrap(), AIRDROP_SEED);
        assert!(pool_seed(6).is_err());
    }

    #[test]
    fn config_len_and_defaults_raw() {
        assert_eq!(Config::LEN, 312);
        assert_eq!(MINT_PRICE_RAW, 10_000 * 1_000_000);
        assert_eq!(NftRecord::LEN, 84);
        assert_eq!(DEFAULT_AIRDROP_MIN_HOLDING, 100_000 * 1_000_000);
    }

    #[test]
    fn marketplace_fee_math() {
        let (fee, net) = marketplace::split_marketplace_fee(10_000 * 1_000_000).unwrap();
        assert_eq!(fee, 100 * 1_000_000);
        assert_eq!(net, 9_900 * 1_000_000);
        assert_eq!(MARKETPLACE_FEE_BPS, 100);
        assert_eq!(Listing::LEN, 82);
        assert_eq!(Offer::LEN, 82);
    }

    #[test]
    fn program_id_matches_keys() {
        #[cfg(not(feature = "mainnet"))]
        assert_eq!(
            ID.to_string(),
            "8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE"
        );
        #[cfg(feature = "mainnet")]
        assert_eq!(
            ID.to_string(),
            "2pwrnxCswbq9cjgfRWQAMJUp6n1MRALpURLBjbmFURdc"
        );
        assert_eq!(
            MAINNET_GC_MINT.to_string(),
            "G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump"
        );
    }

    #[test]
    fn require_ata_rejects_substitute() {
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let tp = anchor_spl::token::ID;
        let good =
            associated_token::get_associated_token_address_with_program_id(&owner, &mint, &tp);
        assert!(require_ata(&good, &owner, &mint, &tp, GreenCatError::InvalidEscrow).is_ok());
        let attacker = Pubkey::new_unique();
        assert!(require_ata(&attacker, &owner, &mint, &tp, GreenCatError::InvalidEscrow).is_err());
        let t22 = anchor_spl::token_2022::ID;
        assert!(require_ata(&good, &owner, &mint, &t22, GreenCatError::InvalidEscrow).is_err());
    }

    /// Off-chain parity: these vectors are asserted identically in
    /// packages/sdk/test/vrfMerkle.test.ts (seed derivation, Merkle leaf/node, mapping).
    #[test]
    fn sdk_parity_vectors() {
        let a = Pubkey::new_from_array([1; 32]);
        let b = Pubkey::new_from_array([2; 32]);
        let p = Pubkey::new_from_array([3; 32]);
        let hex = |x: &[u8]| x.iter().map(|v| format!("{v:02x}")).collect::<String>();
        assert_eq!(
            hex(&airdrop::merkle_leaf(&a, 7, &b, 1000)),
            "b5658ac0e1c023da1eb4c882a865d90fa6cf62fa6f6c397ab0bf33c87b2aba30"
        );
        assert_eq!(
            hex(&airdrop::merkle_node(&[9; 32], &[4; 32])),
            "9bfb1d42619a095d43c65a1d2f3b201a184e512c14cc6dfdff55838d7ee8bdb8"
        );
        assert_eq!(
            hex(&vrf::mint_vrf_seed(&p, &a, 1)),
            "c77b282c19d31f3a8b20ca0d5bbcf4ebe3c2114289c2bdc7468538fb49e5174d"
        );
        assert_eq!(nft::pool_index_from_randomness(&[5; 64], &a, 10_000), 9818);
    }

    /// GC-19: withdraw floors cover every pool that holds user liabilities.
    #[test]
    fn withdraw_floors() {
        let mut c = Config {
            authority: Pubkey::default(),
            gc_mint: Pubkey::default(),
            token_program: Pubkey::default(),
            bump: 0,
            daily_rewards_bump: 0,
            long_rewards_bump: 0,
            wheel_bank_bump: 0,
            nft_fee_treasury_bump: 0,
            mint_proceeds_bump: 0,
            airdrop_bump: 0,
            paused: false,
            airdrop_min_holding: 0,
            daily_payout_allowance: 0,
            wheel_payout_allowance: 0,
            long_stake_capacity: 0,
            total_deposited: 0,
            total_withdrawn: 0,
            daily_lifetime_paid: 0,
            long_staked: 0,
            airdrop_reserved: 7,
            long_bonus_outstanding: 5,
            wheel_lifetime_paid: 0,
            wheel_lifetime_lost: 0,
            wheel_reserved: 3,
            pending_authority: Pubkey::default(),
            wheel_min_bet: 0,
            wheel_max_bet: 0,
            vrf_expiry_secs: 0,
            last_pause_change_ts: 0,
            wheel_house_edge_bps: 0,
            staking_enabled: false,
            staking_flag_set: false,
            _reserved: [0; 28],
        };
        assert_eq!(pool_withdraw_floor(&c, 0), 0);
        assert_eq!(pool_withdraw_floor(&c, 1), 5);
        assert_eq!(pool_withdraw_floor(&c, 2), 3);
        assert_eq!(pool_withdraw_floor(&c, 3), 0);
        assert_eq!(pool_withdraw_floor(&c, 4), 0);
        assert_eq!(pool_withdraw_floor(&c, 5), 7);
        c.paused = true;
        assert!(require_not_paused(&c).is_err());
    }

    /// Staking switch: legacy Config (both bytes 0) = open; fresh init = locked; admin toggles.
    #[test]
    fn staking_switch() {
        let mut raw = vec![0u8; Config::LEN];
        raw[..8].copy_from_slice(Config::DISCRIMINATOR);
        let mut c = Config::try_deserialize(&mut raw.as_slice()).unwrap();
        assert!(
            staking_enabled(&c),
            "pre-upgrade Config (zeroed reserved) stays open"
        );
        assert!(require_staking_enabled(&c).is_ok());
        // what initialize_treasuries writes
        c.staking_enabled = false;
        c.staking_flag_set = true;
        assert!(!staking_enabled(&c));
        assert!(require_staking_enabled(&c).is_err());
        // set_staking_enabled(true)
        c.staking_enabled = true;
        assert!(staking_enabled(&c));
        // field offsets: the two bools sit right after wheel_house_edge_bps (old _reserved[0..2])
        let mut buf = Vec::new();
        c.staking_enabled = true;
        c.staking_flag_set = true;
        c.try_serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), Config::LEN);
        assert_eq!(Config::LEN, 312);
        assert_eq!(&buf[282..284], &[1, 1]);
        assert!(buf[284..].iter().all(|b| *b == 0));
    }
}
