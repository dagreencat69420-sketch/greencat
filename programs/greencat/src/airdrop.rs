//! Merkle airdrop (AUDIT GC-22) — replaces the authority-curated even split.
//!
//! Off-chain (`scripts/airdrop.ts snapshot`): snapshot $GC holders (min balance
//! across one or more snapshots ≥ `airdrop_min_holding`), split the amount, build a
//! sorted-pair SHA-256 Merkle tree with leaves
//! `sha256(0x00 ‖ distribution ‖ index u64le ‖ claimant ‖ amount u64le)` and
//! internal nodes `sha256(0x01 ‖ min(a,b) ‖ max(a,b))` (domain-separated so a node
//! can never be passed off as a leaf), and publish the tree + proofs.
//!
//! On-chain:
//! * `create_airdrop(id, root, total, expiry)` — authority; reserves `total` of the
//!   airdrop vault (`Config.airdrop_reserved`, also the withdraw floor of pool 5).
//! * `claim_airdrop(index, amount, proof)` — the claimant signs; one `ClaimRecord`
//!   PDA per (distribution, index) prevents double claims.
//! * `reclaim_airdrop` — authority, after expiry (and not within 3 days of an
//!   unpause, so a pause can't be used to run the window out): releases the
//!   unclaimed reservation. Tokens stay in the airdrop vault for the next round
//!   (or `withdraw_treasury`).

use anchor_lang::solana_program::hash::hashv;
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::*;

pub const MAX_PROOF_LEN: usize = 32;
#[cfg(not(feature = "localnet-short-windows"))]
pub const MIN_AIRDROP_WINDOW_SECS: i64 = 7 * 86_400;
#[cfg(feature = "localnet-short-windows")]
pub const MIN_AIRDROP_WINDOW_SECS: i64 = 2;
pub const MAX_AIRDROP_WINDOW_SECS: i64 = 365 * 86_400;
#[cfg(not(feature = "localnet-short-windows"))]
pub const RECLAIM_GRACE_AFTER_UNPAUSE_SECS: i64 = 3 * 86_400;
#[cfg(feature = "localnet-short-windows")]
pub const RECLAIM_GRACE_AFTER_UNPAUSE_SECS: i64 = 1;

#[account]
pub struct AirdropDistribution {
    pub id: u64,
    pub merkle_root: [u8; 32],
    pub total_amount: u64,
    pub claimed_amount: u64,
    pub claimed_count: u64,
    pub expiry_ts: i64,
    pub created_ts: i64,
    pub reclaimed: bool,
    pub bump: u8,
    pub _pad: [u8; 6],
}

impl AirdropDistribution {
    pub const LEN: usize = 8 + 8 + 32 + 8 * 5 + 8;
}

#[account]
pub struct ClaimRecord {
    pub claimant: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

impl ClaimRecord {
    pub const LEN: usize = 8 + 32 + 8 + 1;
}

pub fn merkle_leaf(distribution: &Pubkey, index: u64, claimant: &Pubkey, amount: u64) -> [u8; 32] {
    hashv(&[
        &[0u8],
        distribution.as_ref(),
        &index.to_le_bytes(),
        claimant.as_ref(),
        &amount.to_le_bytes(),
    ])
    .to_bytes()
}

pub fn merkle_node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (l, r) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&[1u8], l, r]).to_bytes()
}

pub fn verify_proof(proof: &[[u8; 32]], root: &[u8; 32], leaf: [u8; 32]) -> bool {
    let mut h = leaf;
    for p in proof {
        h = merkle_node(&h, p);
    }
    &h == root
}

/// Reclaim predicate (unit-tested).
pub fn can_reclaim(now: i64, expiry: i64, paused: bool, last_pause_change: i64) -> Result<()> {
    require!(now >= expiry, GreenCatError::AirdropNotExpired);
    require!(
        !paused && now >= last_pause_change.saturating_add(RECLAIM_GRACE_AFTER_UNPAUSE_SECS),
        GreenCatError::ReclaimGracePeriod
    );
    Ok(())
}

#[inline(never)]
pub fn process_create_airdrop(
    ctx: Context<CreateAirdrop>,
    id: u64,
    merkle_root: [u8; 32],
    total_amount: u64,
    expiry_ts: i64,
) -> Result<()> {
    let a = &ctx.accounts;
    require_not_paused(&a.config)?;
    require!(total_amount > 0, GreenCatError::ZeroAmount);
    require!(merkle_root != [0u8; 32], GreenCatError::InvalidParam);
    require_keys_eq!(
        a.config.gc_mint,
        a.gc_mint.key(),
        GreenCatError::MintMismatch
    );
    require_ata(
        &a.airdrop_vault.key(),
        &a.airdrop.key(),
        &a.config.gc_mint,
        &a.config.token_program,
        GreenCatError::InvalidVault,
    )?;
    let now = Clock::get()?.unix_timestamp;
    require!(
        expiry_ts >= now.saturating_add(MIN_AIRDROP_WINDOW_SECS)
            && expiry_ts <= now.saturating_add(MAX_AIRDROP_WINDOW_SECS),
        GreenCatError::InvalidExpiry
    );
    let free = a
        .airdrop_vault
        .amount
        .saturating_sub(a.config.airdrop_reserved);
    require!(
        free >= total_amount,
        GreenCatError::AirdropInsufficientFunds
    );

    let config = &mut ctx.accounts.config;
    config.airdrop_reserved = config
        .airdrop_reserved
        .checked_add(total_amount)
        .ok_or(GreenCatError::Overflow)?;

    let d = &mut ctx.accounts.distribution;
    d.id = id;
    d.merkle_root = merkle_root;
    d.total_amount = total_amount;
    d.claimed_amount = 0;
    d.claimed_count = 0;
    d.expiry_ts = expiry_ts;
    d.created_ts = now;
    d.reclaimed = false;
    d.bump = ctx.bumps.distribution;
    msg!(
        "create_airdrop: id={} total={} expiry={} distribution={}",
        id,
        total_amount,
        expiry_ts,
        d.key()
    );
    Ok(())
}

#[inline(never)]
pub fn process_claim_airdrop(
    ctx: Context<ClaimAirdrop>,
    index: u64,
    amount: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    let a = &ctx.accounts;
    require_not_paused(&a.config)?;
    require!(amount > 0, GreenCatError::ZeroAmount);
    require!(proof.len() <= MAX_PROOF_LEN, GreenCatError::ProofTooLong);
    require_keys_eq!(
        a.config.gc_mint,
        a.gc_mint.key(),
        GreenCatError::MintMismatch
    );
    require_keys_eq!(
        a.token_program.key(),
        a.config.token_program,
        GreenCatError::MintMismatch
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        !a.distribution.reclaimed && now < a.distribution.expiry_ts,
        GreenCatError::AirdropExpired
    );
    let claimant = a.claimant.key();
    let leaf = merkle_leaf(&a.distribution.key(), index, &claimant, amount);
    require!(
        verify_proof(&proof, &a.distribution.merkle_root, leaf),
        GreenCatError::InvalidMerkleProof
    );
    let new_claimed = a
        .distribution
        .claimed_amount
        .checked_add(amount)
        .ok_or(GreenCatError::Overflow)?;
    require!(
        new_claimed <= a.distribution.total_amount,
        GreenCatError::AirdropOverClaim
    );
    require_ata(
        &a.airdrop_vault.key(),
        &a.airdrop.key(),
        &a.config.gc_mint,
        &a.config.token_program,
        GreenCatError::InvalidVault,
    )?;
    require_ata(
        &a.claimant_ata.key(),
        &claimant,
        &a.config.gc_mint,
        &a.config.token_program,
        GreenCatError::InvalidRecipientAta,
    )?;
    if a.claimant_ata.data_is_empty() {
        associated_token::create(CpiContext::new(
            a.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: a.claimant.to_account_info(),
                associated_token: a.claimant_ata.to_account_info(),
                authority: a.claimant.to_account_info(),
                mint: a.gc_mint.to_account_info(),
                system_program: a.system_program.to_account_info(),
                token_program: a.token_program.to_account_info(),
            },
        ))?;
    }
    let bump = [a.config.airdrop_bump];
    let seeds: &[&[&[u8]]] = &[&[AIRDROP_SEED, &bump]];
    transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            TransferChecked {
                from: a.airdrop_vault.to_account_info(),
                mint: a.gc_mint.to_account_info(),
                to: a.claimant_ata.to_account_info(),
                authority: a.airdrop.to_account_info(),
            },
            seeds,
        ),
        amount,
        a.gc_mint.decimals,
    )?;

    let dist_key = a.distribution.key();
    let config = &mut ctx.accounts.config;
    config.airdrop_reserved = config.airdrop_reserved.saturating_sub(amount);
    let d = &mut ctx.accounts.distribution;
    d.claimed_amount = new_claimed;
    d.claimed_count = d.claimed_count.saturating_add(1);
    let r = &mut ctx.accounts.claim_record;
    r.claimant = claimant;
    r.amount = amount;
    r.bump = ctx.bumps.claim_record;
    emit!(AirdropClaimed {
        distribution: dist_key,
        index,
        claimant,
        amount
    });
    msg!(
        "claim_airdrop: index={} claimant={} amount={}",
        index,
        claimant,
        amount
    );
    Ok(())
}

pub fn process_reclaim_airdrop(ctx: Context<ReclaimAirdrop>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cfg = &ctx.accounts.config;
    require!(
        !ctx.accounts.distribution.reclaimed,
        GreenCatError::AirdropAlreadyReclaimed
    );
    can_reclaim(
        now,
        ctx.accounts.distribution.expiry_ts,
        cfg.paused,
        cfg.last_pause_change_ts,
    )?;
    let d = &mut ctx.accounts.distribution;
    let unclaimed = d.total_amount.saturating_sub(d.claimed_amount);
    d.reclaimed = true;
    let config = &mut ctx.accounts.config;
    config.airdrop_reserved = config.airdrop_reserved.saturating_sub(unclaimed);
    msg!("reclaim_airdrop: id={} released={}", d.id, unclaimed);
    Ok(())
}

// ─── Account contexts ───────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateAirdrop<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ GreenCatError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    pub gc_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: airdrop PDA
    #[account(seeds = [AIRDROP_SEED], bump = config.airdrop_bump)]
    pub airdrop: UncheckedAccount<'info>,
    #[account(token::mint = gc_mint)]
    pub airdrop_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = authority,
        space = AirdropDistribution::LEN,
        seeds = [AIRDROP_DIST_SEED, &id.to_le_bytes()],
        bump,
    )]
    pub distribution: Box<Account<'info, AirdropDistribution>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(index: u64)]
pub struct ClaimAirdrop<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [AIRDROP_DIST_SEED, &distribution.id.to_le_bytes()], bump = distribution.bump)]
    pub distribution: Box<Account<'info, AirdropDistribution>>,
    #[account(
        init,
        payer = claimant,
        space = ClaimRecord::LEN,
        seeds = [AIRDROP_CLAIM_SEED, distribution.key().as_ref(), &index.to_le_bytes()],
        bump,
    )]
    pub claim_record: Box<Account<'info, ClaimRecord>>,
    pub gc_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: airdrop PDA
    #[account(seeds = [AIRDROP_SEED], bump = config.airdrop_bump)]
    pub airdrop: UncheckedAccount<'info>,
    #[account(mut, token::mint = gc_mint, token::token_program = token_program)]
    pub airdrop_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: claimant canonical ATA (require_ata; created if empty)
    #[account(mut)]
    pub claimant_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReclaimAirdrop<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ GreenCatError::Unauthorized,
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [AIRDROP_DIST_SEED, &distribution.id.to_le_bytes()], bump = distribution.bump)]
    pub distribution: Box<Account<'info, AirdropDistribution>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(leaves: &[[u8; 32]]) -> (Vec<Vec<[u8; 32]>>, [u8; 32]) {
        let mut layers = vec![leaves.to_vec()];
        while layers.last().unwrap().len() > 1 {
            let prev = layers.last().unwrap();
            let mut next = vec![];
            for pair in prev.chunks(2) {
                next.push(if pair.len() == 2 {
                    merkle_node(&pair[0], &pair[1])
                } else {
                    pair[0]
                });
            }
            layers.push(next);
        }
        let root = layers.last().unwrap()[0];
        (layers, root)
    }

    fn proof(layers: &[Vec<[u8; 32]>], mut i: usize) -> Vec<[u8; 32]> {
        let mut p = vec![];
        for l in &layers[..layers.len() - 1] {
            let sib = i ^ 1;
            if sib < l.len() {
                p.push(l[sib]);
            }
            i /= 2;
        }
        p
    }

    /// GC-22: valid proofs verify; wrong amount / claimant / index / proof fail.
    #[test]
    fn merkle_roundtrip_and_negatives() {
        let dist = Pubkey::new_unique();
        let users: Vec<Pubkey> = (0..5).map(|_| Pubkey::new_unique()).collect();
        let leaves: Vec<[u8; 32]> = users
            .iter()
            .enumerate()
            .map(|(i, u)| merkle_leaf(&dist, i as u64, u, 1_000 + i as u64))
            .collect();
        let (layers, root) = build(&leaves);
        for (i, u) in users.iter().enumerate() {
            let p = proof(&layers, i);
            assert!(verify_proof(
                &p,
                &root,
                merkle_leaf(&dist, i as u64, u, 1_000 + i as u64)
            ));
            assert!(!verify_proof(
                &p,
                &root,
                merkle_leaf(&dist, i as u64, u, 9_999_999)
            ));
            assert!(!verify_proof(
                &p,
                &root,
                merkle_leaf(&dist, i as u64, &Pubkey::new_unique(), 1_000 + i as u64)
            ));
            assert!(!verify_proof(
                &p,
                &root,
                merkle_leaf(&Pubkey::new_unique(), i as u64, u, 1_000 + i as u64)
            ));
        }
        // an internal node is not a valid leaf (domain separation)
        assert!(!verify_proof(&[], &root, layers[1][0]));
    }

    #[test]
    fn reclaim_rules() {
        let g = RECLAIM_GRACE_AFTER_UNPAUSE_SECS;
        assert!(can_reclaim(99, 100, false, 0).is_err());
        assert!(can_reclaim(100 + g, 100, true, 0).is_err());
        assert!(can_reclaim(100, 100, false, 100 - g + 1).is_err());
        assert!(can_reclaim(100 + g, 100, false, 100).is_ok());
    }
}
