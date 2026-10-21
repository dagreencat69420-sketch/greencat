//! Admin instructions (AUDIT GC-19).
//!
//! * Two-step authority handover: `propose_authority(new)` by the current authority,
//!   `accept_authority` signed by the proposed key (e.g. a Squads v4 vault PDA —
//!   Squads executes the accept as a CPI-signed vault transaction). Proposing
//!   `Pubkey::default()` cancels a pending proposal.
//! * `set_paused` gates every user-facing *entry* (mint, settle_mint / request_mint_vrf, trade, stake, spin,
//!   deposit, airdrop claim). Exits that only return a user's own funds stay open.
//! * Parameter setters are bounded by hard-coded caps so a compromised key can't
//!   set an extreme house edge, bet size or VRF expiry.

use anchor_lang::system_program;

use crate::vrf::{VRF_EXPIRY_MAX_SECS, VRF_EXPIRY_MIN_SECS};
use crate::*;

pub const ACTION_PROPOSE_AUTHORITY: u8 = 0;
pub const ACTION_ACCEPT_AUTHORITY: u8 = 1;
pub const ACTION_SET_PAUSED: u8 = 2;
/// Retired: set_wheel_params (wheel removed Oct 12, 2026). Number kept, never reused.
pub const ACTION_SET_WHEEL_PARAMS: u8 = 3;
pub const ACTION_SET_VRF_EXPIRY: u8 = 4;
pub const ACTION_SET_AIRDROP_THRESHOLD: u8 = 7;
pub const ACTION_SWEEP_SOL: u8 = 8;
pub const ACTION_SET_STAKING_ENABLED: u8 = 9;

pub fn process_propose_authority(
    ctx: Context<ProposeAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    require!(
        new_authority != cfg.authority,
        GreenCatError::InvalidAuthority
    );
    cfg.pending_authority = new_authority;
    emit!(AdminAction {
        action: ACTION_PROPOSE_AUTHORITY,
        actor: ctx.accounts.authority.key(),
        value: 0,
        key: new_authority,
    });
    msg!("propose_authority: pending={}", new_authority);
    Ok(())
}

pub fn process_accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    let signer = ctx.accounts.new_authority.key();
    require!(
        cfg.pending_authority != Pubkey::default() && cfg.pending_authority == signer,
        GreenCatError::NoPendingAuthority
    );
    let old = cfg.authority;
    cfg.authority = signer;
    cfg.pending_authority = Pubkey::default();
    emit!(AdminAction {
        action: ACTION_ACCEPT_AUTHORITY,
        actor: signer,
        value: 0,
        key: old
    });
    msg!("accept_authority: {} -> {}", old, signer);
    Ok(())
}

pub fn process_set_paused(ctx: Context<AdminConfig>, paused: bool) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    if cfg.paused != paused {
        cfg.paused = paused;
        cfg.last_pause_change_ts = Clock::get()?.unix_timestamp;
    }
    emit!(AdminAction {
        action: ACTION_SET_PAUSED,
        actor: ctx.accounts.authority.key(),
        value: paused as u64,
        key: Pubkey::default(),
    });
    msg!("set_paused: {}", paused);
    Ok(())
}

pub fn process_set_vrf_expiry(ctx: Context<AdminConfig>, expiry_secs: i64) -> Result<()> {
    require!(
        (VRF_EXPIRY_MIN_SECS..=VRF_EXPIRY_MAX_SECS).contains(&expiry_secs),
        GreenCatError::InvalidExpiry
    );
    ctx.accounts.config.vrf_expiry_secs = expiry_secs;
    emit!(AdminAction {
        action: ACTION_SET_VRF_EXPIRY,
        actor: ctx.accounts.authority.key(),
        value: expiry_secs as u64,
        key: Pubkey::default(),
    });
    Ok(())
}

/// Staking switch: lock/open NEW stakes. Writes the explicit flag, so after the first call a
/// legacy (pre-upgrade) Config follows `staking_enabled` exactly like a fresh deployment.
pub fn process_set_staking_enabled(ctx: Context<AdminConfig>, enabled: bool) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    cfg.staking_enabled = enabled;
    cfg.staking_flag_set = true;
    emit!(AdminAction {
        action: ACTION_SET_STAKING_ENABLED,
        actor: ctx.accounts.authority.key(),
        value: enabled as u64,
        key: Pubkey::default(),
    });
    msg!("set_staking_enabled: {}", enabled);
    Ok(())
}

pub fn process_set_airdrop_threshold(ctx: Context<AdminConfig>, min_holding: u64) -> Result<()> {
    require!(min_holding > 0, GreenCatError::ZeroAmount);
    ctx.accounts.config.airdrop_min_holding = min_holding;
    emit!(AdminAction {
        action: ACTION_SET_AIRDROP_THRESHOLD,
        actor: ctx.accounts.authority.key(),
        value: min_holding,
        key: Pubkey::default(),
    });
    Ok(())
}

/// The nft_fee_treasury PDA is a data-less system account; marketplaces pay SOL
/// royalties to it. Keeps the account either empty or rent-exempt.
pub fn process_sweep_fee_treasury_sol(
    ctx: Context<SweepFeeTreasurySol>,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, GreenCatError::ZeroAmount);
    let bal = ctx.accounts.nft_fee_treasury.lamports();
    let min = Rent::get()?.minimum_balance(0);
    let left = bal.checked_sub(amount).ok_or(GreenCatError::Overflow)?;
    require!(left == 0 || left >= min, GreenCatError::InvalidParam);
    let bump = [ctx.accounts.config.nft_fee_treasury_bump];
    let seeds: &[&[&[u8]]] = &[&[NFT_FEE_TREASURY_SEED, &bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.nft_fee_treasury.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
            },
            seeds,
        ),
        amount,
    )?;
    emit!(AdminAction {
        action: ACTION_SWEEP_SOL,
        actor: ctx.accounts.authority.key(),
        value: amount,
        key: ctx.accounts.destination.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ProposeAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ GreenCatError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub new_authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ GreenCatError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct SweepFeeTreasurySol<'info> {
    pub authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ GreenCatError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: PDA (system-owned, data-less)
    #[account(mut, seeds = [NFT_FEE_TREASURY_SEED], bump = config.nft_fee_treasury_bump)]
    pub nft_fee_treasury: UncheckedAccount<'info>,
    /// CHECK: any SOL destination chosen by the authority
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
