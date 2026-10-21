//! Daily + 365-day staking (REAL-APP-SPEC §E / §F). Demo parity with holder-app economy.
//!
//! Daily: lazy accrual `DAILY_RATE` of principal per 86400s; pending scaled u128;
//! floor to whole raw units on claim (to wallet only). Payouts debit `daily_rewards` and
//! count toward `config.daily_lifetime_paid` vs `daily_payout_allowance`.
//!
//! 365: each deposit is a tranche (`unlock_at = start + 365d`). Add = new tranche.
//! Capacity vs `config.long_stake_capacity` / `long_staked`. Claim after unlock returns
//! principal + up to 100% promotional bonus from `long_rewards` if funded (not guaranteed).

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token,
    token_interface::{transfer_checked, TransferChecked},
};

use crate::{
    require_ata, require_not_paused, require_staking_enabled, AddDaily, ClaimDaily, ClaimLong,
    Config, GreenCatError, StakeDaily, StakeLong, UnstakeDaily, DAILY_PRINCIPAL_SEED,
    DAILY_REWARDS_SEED, LONG_PRINCIPAL_SEED, LONG_REWARDS_SEED,
};

/// Seconds in one accrual / min-unstake period (24h).
pub const SECONDS_PER_DAY: i64 = 86_400;
/// Lock duration for 365-day tranches.
pub const LONG_LOCK_SECONDS: i64 = SECONDS_PER_DAY * 365;

/// Pending fixed-point scale: `pending_raw ≈ pending_scaled / PENDING_SCALE`.
/// Rate = DAILY_RATE_NUM / PENDING_SCALE = 0.000136986301 of principal per period.
pub const PENDING_SCALE: u128 = 1_000_000_000_000; // 1e12
pub const DAILY_RATE_NUM: u128 = 136_986_301;

#[account]
pub struct DailyStake {
    pub owner: Pubkey,
    pub principal: u64,
    /// Accrued rewards × PENDING_SCALE (fractional raw preserved).
    pub pending_scaled: u128,
    pub last_accrual_ts: i64,
    pub started_at: i64,
    pub bump: u8,
}

impl DailyStake {
    pub const LEN: usize = 8 + 32 + 8 + 16 + 8 + 8 + 1;
}

#[account]
pub struct LongState {
    pub owner: Pubkey,
    pub next_tranche_id: u64,
    pub bump: u8,
}

impl LongState {
    pub const LEN: usize = 8 + 32 + 8 + 1;
}

#[account]
pub struct LongTranche {
    pub owner: Pubkey,
    pub tranche_id: u64,
    pub principal: u64,
    /// Remaining promotional bonus owed (target 100% of original principal).
    pub bonus_owed: u64,
    pub started_at: i64,
    pub unlock_at: i64,
    pub bump: u8,
}

impl LongTranche {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8 + 8 + 8 + 1;
}

/// Accrue whole periods onto pending. Returns (pending_scaled, last_accrual_ts, periods).
pub fn accrue_daily_pending(
    principal: u64,
    pending_scaled: u128,
    last_accrual_ts: i64,
    now: i64,
) -> Result<(u128, i64, u64)> {
    if principal == 0 || now <= last_accrual_ts {
        return Ok((pending_scaled, last_accrual_ts, 0));
    }
    let elapsed = now
        .checked_sub(last_accrual_ts)
        .ok_or(GreenCatError::Overflow)?;
    let periods = (elapsed / SECONDS_PER_DAY) as u64;
    if periods == 0 {
        return Ok((pending_scaled, last_accrual_ts, 0));
    }
    let earned = (principal as u128)
        .checked_mul(DAILY_RATE_NUM)
        .ok_or(GreenCatError::Overflow)?
        .checked_mul(periods as u128)
        .ok_or(GreenCatError::Overflow)?;
    let new_pending = pending_scaled
        .checked_add(earned)
        .ok_or(GreenCatError::Overflow)?;
    let advance = (periods as i64)
        .checked_mul(SECONDS_PER_DAY)
        .ok_or(GreenCatError::Overflow)?;
    let new_ts = last_accrual_ts
        .checked_add(advance)
        .ok_or(GreenCatError::Overflow)?;
    Ok((new_pending, new_ts, periods))
}

/// AUDIT(GC-11): used before a principal top-up. Accrues whole periods as usual,
/// then credits the elapsed *partial* period pro-rata for the OLD principal and
/// moves `last_accrual_ts` to `now`. New principal therefore starts accruing at
/// `now` instead of being back-dated to the start of the current 24h period
/// (which let a whale add capital seconds before a boundary and collect a full
/// day of rewards on it). Honest stakers lose nothing: the old principal's
/// partial period is credited linearly instead of being rounded away.
pub fn accrue_daily_pending_for_topup(
    principal: u64,
    pending_scaled: u128,
    last_accrual_ts: i64,
    now: i64,
) -> Result<(u128, i64)> {
    let (p, ts, _) = accrue_daily_pending(principal, pending_scaled, last_accrual_ts, now)?;
    if principal == 0 || now <= ts {
        return Ok((p, ts));
    }
    let partial = (now - ts) as u128; // < SECONDS_PER_DAY
    let earned = (principal as u128)
        .checked_mul(DAILY_RATE_NUM)
        .ok_or(GreenCatError::Overflow)?
        .checked_mul(partial)
        .ok_or(GreenCatError::Overflow)?
        / (SECONDS_PER_DAY as u128);
    let p = p.checked_add(earned).ok_or(GreenCatError::Overflow)?;
    Ok((p, now))
}

/// Floor pending to whole raw token units.
pub fn floor_claimable(pending_scaled: u128) -> u64 {
    let v = pending_scaled / PENDING_SCALE;
    if v > u64::MAX as u128 {
        u64::MAX
    } else {
        v as u64
    }
}

pub fn subtract_pending_raw(pending_scaled: u128, raw: u64) -> Result<u128> {
    let scaled = (raw as u128)
        .checked_mul(PENDING_SCALE)
        .ok_or(GreenCatError::Overflow)?;
    pending_scaled
        .checked_sub(scaled)
        .ok_or(GreenCatError::Overflow.into())
}

pub fn daily_remain_payout(config: &Config) -> u64 {
    config
        .daily_payout_allowance
        .saturating_sub(config.daily_lifetime_paid)
}

fn gc_decimals(gc_mint: &AccountInfo) -> Result<u8> {
    let data = gc_mint.try_borrow_data()?;
    require!(data.len() > 44, GreenCatError::MintMismatch);
    Ok(data[44])
}

fn require_gc(config: &Config, gc_mint: &Pubkey, token_program: &Pubkey) -> Result<()> {
    require_keys_eq!(config.gc_mint, *gc_mint, GreenCatError::MintMismatch);
    require_keys_eq!(
        config.token_program,
        *token_program,
        GreenCatError::MintMismatch
    );
    Ok(())
}

fn ensure_ata<'info>(
    payer: &AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
) -> Result<()> {
    if ata.data_is_empty() {
        associated_token::create(CpiContext::new(
            associated_token_program.clone(),
            associated_token::Create {
                payer: payer.clone(),
                associated_token: ata.clone(),
                authority: authority.clone(),
                mint: mint.clone(),
                system_program: system_program.clone(),
                token_program: token_program.clone(),
            },
        ))?;
    }
    Ok(())
}

fn transfer_gc<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(
        CpiContext::new(
            token_program.clone(),
            TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
        ),
        amount,
        decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn transfer_gc_signed<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer_checked(
        CpiContext::new_with_signer(
            token_program.clone(),
            TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
            seeds,
        ),
        amount,
        decimals,
    )
}

/// stake_daily: init DailyStake if needed; transfer amount into daily_principal vault.
/// Locked when lifetime payout remaining ≤ 0. Does not reset started_at on add.
pub fn process_stake_daily(ctx: Context<StakeDaily>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    require_staking_enabled(&ctx.accounts.config)?;
    require!(amount > 0, GreenCatError::ZeroAmount);
    require_gc(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
    )?;
    require!(
        daily_remain_payout(&ctx.accounts.config) > 0,
        GreenCatError::DailyPayoutExhausted
    );

    // AUDIT(GC-02): principal must be custodied in the daily_principal PDA's ATA.
    require_ata(
        &ctx.accounts.daily_principal_vault.key(),
        &ctx.accounts.daily_principal.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
        GreenCatError::InvalidPrincipalVault,
    )?;

    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    ensure_ata(
        &ctx.accounts.staker.to_account_info(),
        &ctx.accounts.daily_principal_vault.to_account_info(),
        &ctx.accounts.daily_principal.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
    )?;

    let stake = &mut ctx.accounts.daily_stake;
    let is_new = stake.principal == 0 && stake.started_at == 0 && stake.pending_scaled == 0;
    // Accrue before increasing principal when stake already active
    if stake.principal > 0 || stake.pending_scaled > 0 {
        let (p, ts) = accrue_daily_pending_for_topup(
            stake.principal,
            stake.pending_scaled,
            stake.last_accrual_ts,
            now,
        )?;
        stake.pending_scaled = p;
        stake.last_accrual_ts = ts;
    }

    transfer_gc(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.staker_ata.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.daily_principal_vault.to_account_info(),
        &ctx.accounts.staker.to_account_info(),
        amount,
        decimals,
    )?;

    if is_new || stake.principal == 0 {
        // Fresh open (or restart after full unstake with no residual)
        if stake.owner == Pubkey::default() {
            stake.owner = ctx.accounts.staker.key();
            stake.bump = ctx.bumps.daily_stake;
        }
        stake.started_at = now;
        stake.last_accrual_ts = now;
    }
    stake.principal = stake
        .principal
        .checked_add(amount)
        .ok_or(GreenCatError::Overflow)?;

    msg!(
        "stake_daily: staker={} amount={} principal={}",
        ctx.accounts.staker.key(),
        amount,
        stake.principal
    );
    Ok(())
}

/// add_daily: require active principal; accrue then top up (same locks as stake).
pub fn process_add_daily(ctx: Context<AddDaily>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    require_staking_enabled(&ctx.accounts.config)?;
    require!(amount > 0, GreenCatError::ZeroAmount);
    require_gc(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
    )?;
    require!(
        daily_remain_payout(&ctx.accounts.config) > 0,
        GreenCatError::DailyPayoutExhausted
    );

    let stake = &mut ctx.accounts.daily_stake;
    require_keys_eq!(
        stake.owner,
        ctx.accounts.staker.key(),
        GreenCatError::Unauthorized
    );
    require!(stake.principal > 0, GreenCatError::StakeInactive);

    require_ata(
        &ctx.accounts.daily_principal_vault.key(),
        &ctx.accounts.daily_principal.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
        GreenCatError::InvalidPrincipalVault,
    )?;

    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;
    let now = Clock::get()?.unix_timestamp;

    let (p, ts) = accrue_daily_pending_for_topup(
        stake.principal,
        stake.pending_scaled,
        stake.last_accrual_ts,
        now,
    )?;
    stake.pending_scaled = p;
    stake.last_accrual_ts = ts;

    ensure_ata(
        &ctx.accounts.staker.to_account_info(),
        &ctx.accounts.daily_principal_vault.to_account_info(),
        &ctx.accounts.daily_principal.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
    )?;

    transfer_gc(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.staker_ata.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.daily_principal_vault.to_account_info(),
        &ctx.accounts.staker.to_account_info(),
        amount,
        decimals,
    )?;

    stake.principal = stake
        .principal
        .checked_add(amount)
        .ok_or(GreenCatError::Overflow)?;

    msg!(
        "add_daily: staker={} amount={} principal={}",
        ctx.accounts.staker.key(),
        amount,
        stake.principal
    );
    Ok(())
}

/// claim_daily: accrue; pay = min(floor(pending), pool, remain) to staker wallet.
/// No compound path — rewards never add into principal.
pub fn process_claim_daily(ctx: Context<ClaimDaily>) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    require_gc(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
    )?;

    let stake = &mut ctx.accounts.daily_stake;
    require_keys_eq!(
        stake.owner,
        ctx.accounts.staker.key(),
        GreenCatError::Unauthorized
    );

    let now = Clock::get()?.unix_timestamp;
    let (p, ts, _) = accrue_daily_pending(
        stake.principal,
        stake.pending_scaled,
        stake.last_accrual_ts,
        now,
    )?;
    stake.pending_scaled = p;
    stake.last_accrual_ts = ts;

    let claimable = floor_claimable(stake.pending_scaled);
    if claimable == 0 {
        return err!(GreenCatError::NothingToClaim);
    }

    let remain = daily_remain_payout(&ctx.accounts.config);
    let pool_bal = ctx.accounts.daily_rewards_vault.amount;
    let pay = claimable.min(pool_bal).min(remain);
    if pay == 0 {
        if remain == 0 {
            return err!(GreenCatError::DailyPayoutExhausted);
        }
        return err!(GreenCatError::EmptyRewardPool);
    }

    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;
    let bump = ctx.accounts.config.daily_rewards_bump;
    let seeds: &[&[&[u8]]] = &[&[DAILY_REWARDS_SEED, &[bump]]];

    transfer_gc_signed(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.daily_rewards_vault.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.staker_ata.to_account_info(),
        &ctx.accounts.daily_rewards.to_account_info(),
        pay,
        decimals,
        seeds,
    )?;

    stake.pending_scaled = subtract_pending_raw(stake.pending_scaled, pay)?;
    let config = &mut ctx.accounts.config;
    config.daily_lifetime_paid = config
        .daily_lifetime_paid
        .checked_add(pay)
        .ok_or(GreenCatError::Overflow)?;

    msg!(
        "claim_daily: pay={} pending_left_scaled={} lifetime_paid={}",
        pay,
        stake.pending_scaled,
        config.daily_lifetime_paid
    );
    Ok(())
}

/// unstake_daily: min 24h from started_at; return principal + auto-claim pending (same caps).
/// AUDIT(GC-19): not pause-gated so principal can always exit; while paused the
/// reward part is skipped and stays in `pending_scaled` for a later claim.
pub fn process_unstake_daily(ctx: Context<UnstakeDaily>) -> Result<()> {
    let paused = ctx.accounts.config.paused;
    require_gc(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
    )?;

    require_ata(
        &ctx.accounts.daily_principal_vault.key(),
        &ctx.accounts.daily_principal.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
        GreenCatError::InvalidPrincipalVault,
    )?;

    let stake = &mut ctx.accounts.daily_stake;
    require_keys_eq!(
        stake.owner,
        ctx.accounts.staker.key(),
        GreenCatError::Unauthorized
    );
    require!(stake.principal > 0, GreenCatError::StakeInactive);

    let now = Clock::get()?.unix_timestamp;
    require!(
        now.saturating_sub(stake.started_at) >= SECONDS_PER_DAY,
        GreenCatError::MinLockNotMet
    );

    let (p, ts, _) = accrue_daily_pending(
        stake.principal,
        stake.pending_scaled,
        stake.last_accrual_ts,
        now,
    )?;
    stake.pending_scaled = p;
    stake.last_accrual_ts = ts;

    let principal = stake.principal;
    let claimable = floor_claimable(stake.pending_scaled);
    let remain = daily_remain_payout(&ctx.accounts.config);
    let pool_bal = ctx.accounts.daily_rewards_vault.amount;
    let pay = if paused {
        0
    } else {
        claimable.min(pool_bal).min(remain)
    };

    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;
    let principal_bump = ctx.bumps.daily_principal;
    let principal_seeds: &[&[&[u8]]] = &[&[DAILY_PRINCIPAL_SEED, &[principal_bump]]];

    transfer_gc_signed(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.daily_principal_vault.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.staker_ata.to_account_info(),
        &ctx.accounts.daily_principal.to_account_info(),
        principal,
        decimals,
        principal_seeds,
    )?;

    if pay > 0 {
        let reward_bump = ctx.accounts.config.daily_rewards_bump;
        let reward_seeds: &[&[&[u8]]] = &[&[DAILY_REWARDS_SEED, &[reward_bump]]];
        transfer_gc_signed(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.daily_rewards_vault.to_account_info(),
            &ctx.accounts.gc_mint.to_account_info(),
            &ctx.accounts.staker_ata.to_account_info(),
            &ctx.accounts.daily_rewards.to_account_info(),
            pay,
            decimals,
            reward_seeds,
        )?;
        stake.pending_scaled = subtract_pending_raw(stake.pending_scaled, pay)?;
        let config = &mut ctx.accounts.config;
        config.daily_lifetime_paid = config
            .daily_lifetime_paid
            .checked_add(pay)
            .ok_or(GreenCatError::Overflow)?;
    }

    stake.principal = 0;
    // Keep account if residual pending ≥ 1 raw; else zero started_at so next stake is fresh
    if floor_claimable(stake.pending_scaled) == 0 {
        stake.pending_scaled = 0;
        stake.started_at = 0;
        stake.last_accrual_ts = 0;
    }

    msg!(
        "unstake_daily: principal={} pay={} residual_scaled={}",
        principal,
        pay,
        stake.pending_scaled
    );
    Ok(())
}

/// stake_long: create LongState if needed + new tranche; capacity check; transfer to long_principal.
pub fn process_stake_long(ctx: Context<StakeLong>, amount: u64, tranche_id: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    require_staking_enabled(&ctx.accounts.config)?;
    require!(amount > 0, GreenCatError::ZeroAmount);
    require_gc(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
    )?;

    let config = &ctx.accounts.config;
    let new_total = config
        .long_staked
        .checked_add(amount)
        .ok_or(GreenCatError::Overflow)?;
    require!(
        new_total <= config.long_stake_capacity,
        GreenCatError::LongCapacityFull
    );

    // AUDIT(GC-03): principal must be custodied in the long_principal PDA's ATA.
    require_ata(
        &ctx.accounts.long_principal_vault.key(),
        &ctx.accounts.long_principal.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
        GreenCatError::InvalidPrincipalVault,
    )?;

    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;
    let now = Clock::get()?.unix_timestamp;

    ensure_ata(
        &ctx.accounts.staker.to_account_info(),
        &ctx.accounts.long_principal_vault.to_account_info(),
        &ctx.accounts.long_principal.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
    )?;

    let long_state = &mut ctx.accounts.long_state;
    if long_state.owner == Pubkey::default() {
        long_state.owner = ctx.accounts.staker.key();
        long_state.next_tranche_id = 0;
        long_state.bump = ctx.bumps.long_state;
    }
    require_keys_eq!(
        long_state.owner,
        ctx.accounts.staker.key(),
        GreenCatError::Unauthorized
    );
    require!(
        long_state.next_tranche_id == tranche_id,
        GreenCatError::BadTrancheId
    );
    long_state.next_tranche_id = long_state
        .next_tranche_id
        .checked_add(1)
        .ok_or(GreenCatError::Overflow)?;

    transfer_gc(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.staker_ata.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.long_principal_vault.to_account_info(),
        &ctx.accounts.staker.to_account_info(),
        amount,
        decimals,
    )?;

    let tranche = &mut ctx.accounts.tranche;
    tranche.owner = ctx.accounts.staker.key();
    tranche.tranche_id = tranche_id;
    tranche.principal = amount;
    tranche.bonus_owed = amount; // 100% promotional target
    tranche.started_at = now;
    tranche.unlock_at = now
        .checked_add(LONG_LOCK_SECONDS)
        .ok_or(GreenCatError::Overflow)?;
    tranche.bump = ctx.bumps.tranche;

    let config = &mut ctx.accounts.config;
    config.long_staked = new_total;
    config.long_bonus_outstanding = config
        .long_bonus_outstanding
        .checked_add(amount)
        .ok_or(GreenCatError::Overflow)?;

    msg!(
        "stake_long: staker={} tranche={} amount={} unlock_at={} long_staked={}",
        ctx.accounts.staker.key(),
        tranche_id,
        amount,
        tranche.unlock_at,
        config.long_staked
    );
    Ok(())
}

/// claim_long: after unlock_at, return principal + min(bonus_owed, pool) from long_rewards.
/// Partial bonus OK; residual stays claimable. Copy must not say guaranteed 100%.
/// AUDIT(GC-19): principal exits even while paused; the bonus is skipped while paused
/// (it stays owed and can be claimed after unpause).
pub fn process_claim_long(ctx: Context<ClaimLong>) -> Result<()> {
    let paused = ctx.accounts.config.paused;
    require_gc(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
    )?;

    require_ata(
        &ctx.accounts.long_principal_vault.key(),
        &ctx.accounts.long_principal.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.token_program.key,
        GreenCatError::InvalidPrincipalVault,
    )?;

    let tranche = &mut ctx.accounts.tranche;
    require_keys_eq!(
        tranche.owner,
        ctx.accounts.staker.key(),
        GreenCatError::Unauthorized
    );

    let now = Clock::get()?.unix_timestamp;
    require!(now >= tranche.unlock_at, GreenCatError::StillLocked);
    require!(
        tranche.principal > 0 || tranche.bonus_owed > 0,
        GreenCatError::StakeInactive
    );

    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;
    let principal = tranche.principal;

    if principal > 0 {
        let bump = ctx.bumps.long_principal;
        let seeds: &[&[&[u8]]] = &[&[LONG_PRINCIPAL_SEED, &[bump]]];
        transfer_gc_signed(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.long_principal_vault.to_account_info(),
            &ctx.accounts.gc_mint.to_account_info(),
            &ctx.accounts.staker_ata.to_account_info(),
            &ctx.accounts.long_principal.to_account_info(),
            principal,
            decimals,
            seeds,
        )?;
        tranche.principal = 0;
        let config = &mut ctx.accounts.config;
        config.long_staked = config.long_staked.saturating_sub(principal);
    }

    let pool_bal = ctx.accounts.long_rewards_vault.amount;
    let bonus_pay = if paused {
        0
    } else {
        tranche.bonus_owed.min(pool_bal)
    };
    if bonus_pay > 0 {
        let bump = ctx.accounts.config.long_rewards_bump;
        let seeds: &[&[&[u8]]] = &[&[LONG_REWARDS_SEED, &[bump]]];
        transfer_gc_signed(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.long_rewards_vault.to_account_info(),
            &ctx.accounts.gc_mint.to_account_info(),
            &ctx.accounts.staker_ata.to_account_info(),
            &ctx.accounts.long_rewards.to_account_info(),
            bonus_pay,
            decimals,
            seeds,
        )?;
        tranche.bonus_owed = tranche
            .bonus_owed
            .checked_sub(bonus_pay)
            .ok_or(GreenCatError::Overflow)?;
        let config = &mut ctx.accounts.config;
        config.long_bonus_outstanding = config.long_bonus_outstanding.saturating_sub(bonus_pay);
    }

    msg!(
        "claim_long: tranche={} principal_returned={} bonus_paid={} bonus_owed_left={}",
        tranche.tranche_id,
        principal,
        bonus_pay,
        tranche.bonus_owed
    );

    // Close empty tranche to reclaim rent
    if tranche.principal == 0 && tranche.bonus_owed == 0 {
        // Account close handled by close constraint if we add it — zero fields and leave;
        // caller may leave dust account. Prefer explicit close via Anchor `close = staker`.
        // Mark inactive by zeroing (already done).
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_matches_demo() {
        // 136986301 / 1e12 = 0.000136986301
        assert_eq!(DAILY_RATE_NUM, 136_986_301);
        assert_eq!(PENDING_SCALE, 1_000_000_000_000);
    }

    #[test]
    fn accrue_one_period_1m_ui_raw() {
        // 1_000_000 UI × 10^6 = 1e12 raw
        let principal: u64 = 1_000_000 * 1_000_000;
        let (pending, ts, periods) =
            accrue_daily_pending(principal, 0, 1_000_000, 1_000_000 + SECONDS_PER_DAY).unwrap();
        assert_eq!(periods, 1);
        assert_eq!(ts, 1_000_000 + SECONDS_PER_DAY);
        // earned_scaled = principal * RATE_NUM = 1e12 * 136986301
        assert_eq!(pending, (principal as u128) * DAILY_RATE_NUM);
        assert_eq!(floor_claimable(pending), 136_986_301);
    }

    #[test]
    fn accrue_two_periods() {
        let principal: u64 = 1_000_000 * 1_000_000;
        let (pending, _, periods) =
            accrue_daily_pending(principal, 0, 0, SECONDS_PER_DAY * 2).unwrap();
        assert_eq!(periods, 2);
        assert_eq!(floor_claimable(pending), 136_986_301 * 2);
    }

    #[test]
    fn partial_period_no_accrual() {
        let (pending, ts, periods) =
            accrue_daily_pending(1_000_000, 0, 100, 100 + SECONDS_PER_DAY - 1).unwrap();
        assert_eq!(periods, 0);
        assert_eq!(pending, 0);
        assert_eq!(ts, 100);
    }

    #[test]
    fn floor_and_subtract_preserves_fraction() {
        // pending = 1.5 raw → scaled 1.5e12
        let scaled = PENDING_SCALE + PENDING_SCALE / 2;
        assert_eq!(floor_claimable(scaled), 1);
        let left = subtract_pending_raw(scaled, 1).unwrap();
        assert_eq!(left, PENDING_SCALE / 2);
        assert_eq!(floor_claimable(left), 0);
    }

    #[test]
    fn account_lens() {
        assert_eq!(DailyStake::LEN, 81);
        assert_eq!(LongState::LEN, 49);
        assert_eq!(LongTranche::LEN, 81);
    }

    /// GC-11 negative test: adding capital 1s before a period boundary must NOT
    /// earn a full day of rewards on the new capital.
    #[test]
    fn topup_just_before_boundary_is_not_backdated() {
        let t0: i64 = 1_000_000;
        let small: u64 = 1_000 * 1_000_000; // 1k GC
        let whale: u64 = 100_000_000 * 1_000_000; // 100M GC flash top-up
                                                  // top-up at t0 + 86399 (1s before the boundary)
        let topup_at = t0 + SECONDS_PER_DAY - 1;
        let (p, ts) = accrue_daily_pending_for_topup(small, 0, t0, topup_at).unwrap();
        assert_eq!(ts, topup_at);
        let principal = small + whale;
        // claim at the boundary (+1s)
        let (p2, _, _) = accrue_daily_pending(principal, p, ts, t0 + SECONDS_PER_DAY).unwrap();
        let claim = floor_claimable(p2);
        // old (vulnerable) behaviour: last_accrual stays t0 → full day on 100.001M
        let (old_p, old_ts, _) = accrue_daily_pending(small, 0, t0, topup_at).unwrap();
        let (old_p2, _, _) =
            accrue_daily_pending(principal, old_p, old_ts, t0 + SECONDS_PER_DAY).unwrap();
        let old_claim = floor_claimable(old_p2);
        let full_day_on_whale = floor_claimable((whale as u128) * DAILY_RATE_NUM);
        assert!(
            old_claim >= full_day_on_whale,
            "sanity: old path was exploitable"
        );
        // new: ≈ one day on `small` only (+ nothing for the whale until a full day passes)
        let one_day_small = floor_claimable((small as u128) * DAILY_RATE_NUM);
        assert!(
            claim <= one_day_small + 1,
            "claim {} > {}",
            claim,
            one_day_small
        );
        assert!(claim + 1 >= one_day_small - one_day_small / 86_400 - 1);
    }

    #[test]
    fn topup_value_neutral_for_old_principal() {
        // honest staker: half-day partial gets credited linearly on top-up
        let (p, ts) =
            accrue_daily_pending_for_topup(1_000_000_000_000, 0, 0, SECONDS_PER_DAY / 2).unwrap();
        assert_eq!(ts, SECONDS_PER_DAY / 2);
        assert_eq!(floor_claimable(p), 136_986_301 / 2);
        // no principal → no-op
        let (p0, ts0) = accrue_daily_pending_for_topup(0, 7, 5, 100).unwrap();
        assert_eq!((p0, ts0), (7, 5));
    }

    #[test]
    fn long_lock_is_365_days() {
        assert_eq!(LONG_LOCK_SECONDS, 86_400 * 365);
    }
}
