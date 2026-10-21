//! ORAO VRF v2 helpers (AUDIT GC-15 / GC-17).
//!
//! Flow used by the wheel and the per-mint reveal:
//! 1. **request** — our instruction derives a unique, program-bound 32-byte seed and
//!    CPIs `orao_vrf::request_v2(seed)`; the randomness PDA
//!    `["orao-vrf-randomness-request", seed]` (owner = ORAO program) is created in the
//!    same instruction, so it can only ever belong to this request.
//! 2. **fulfill** — ORAO fulfillment authorities sign the seed (Ed25519) off-chain and
//!    call `fulfill_v2`; the 64-byte randomness becomes readable in that account.
//! 3. **consume** — a separate, permissionless instruction reads the *fulfilled*
//!    account (address + owner + discriminator checked) and settles. The outcome is
//!    fixed at fulfill time, so reverting / simulating the consume transaction
//!    cannot change it (fixes the SlotHashes revert-on-loss exploit).
//!
//! Expiry: if the request is still unfulfilled `vrf_expiry_secs` after it was made,
//! the wheel refunds the bet and a mint's reveal may be re-requested. A *fulfilled*
//! request can never be refunded / retried.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::AccountDeserialize;
use orao_solana_vrf::state::RandomnessAccountData;

use crate::GreenCatError;

pub use orao_solana_vrf::program::OraoVrf;
pub use orao_solana_vrf::state::NetworkState;
pub use orao_solana_vrf::{CONFIG_ACCOUNT_SEED as VRF_CONFIG_SEED, RANDOMNESS_ACCOUNT_SEED};

/// Per-mint reveal (instant reveal, replaces the old collection-wide `greencat-reveal-vrf-v1`).
pub const MINT_VRF_DOMAIN: &[u8] = b"greencat-mint-vrf-v1";

/// Hard bounds for `Config.vrf_expiry_secs`.
#[cfg(not(feature = "localnet-short-windows"))]
pub const VRF_EXPIRY_MIN_SECS: i64 = 3_600;
#[cfg(feature = "localnet-short-windows")]
pub const VRF_EXPIRY_MIN_SECS: i64 = 2;
pub const VRF_EXPIRY_MAX_SECS: i64 = 7 * 86_400;
pub const DEFAULT_VRF_EXPIRY_SECS: i64 = 86_400;

/// Unique, program-bound seed for one NFT's reveal request. The NFT mint is a fresh
/// keypair per mint, and `attempt` only increases after an expired *unfulfilled*
/// request, so a seed (and its ORAO account) can never be reused.
pub fn mint_vrf_seed(program_id: &Pubkey, nft_mint: &Pubkey, attempt: u8) -> [u8; 32] {
    hashv(&[
        MINT_VRF_DOMAIN,
        program_id.as_ref(),
        nft_mint.as_ref(),
        &[attempt],
    ])
    .to_bytes()
}

pub fn randomness_address(seed: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[RANDOMNESS_ACCOUNT_SEED, seed], &orao_solana_vrf::ID).0
}

/// State of the ORAO randomness account for `seed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VrfState {
    /// Account missing or not yet fulfilled.
    Pending,
    Fulfilled([u8; 64]),
}

/// Validate that `account` is the ORAO randomness PDA for `seed` and read it.
pub fn read_vrf(account: &AccountInfo, seed: &[u8; 32]) -> Result<VrfState> {
    require_keys_eq!(
        account.key(),
        randomness_address(seed),
        GreenCatError::InvalidVrfAccount
    );
    if account.data_is_empty() {
        return Ok(VrfState::Pending);
    }
    require_keys_eq!(
        *account.owner,
        orao_solana_vrf::ID,
        GreenCatError::InvalidVrfAccount
    );
    let data = account.try_borrow_data()?;
    let parsed = RandomnessAccountData::try_deserialize(&mut &data[..])
        .map_err(|_| error!(GreenCatError::InvalidVrfAccount))?;
    require!(parsed.seed() == seed, GreenCatError::InvalidVrfAccount);
    Ok(match parsed.fulfilled_randomness() {
        Some(r) => VrfState::Fulfilled(*r),
        None => VrfState::Pending,
    })
}

/// Pure expiry predicate (unit-tested): a request may be refunded / re-requested
/// only if it is past `expires_at` AND still unfulfilled.
pub fn can_expire(now: i64, expires_at: i64, state: &VrfState) -> Result<()> {
    if let VrfState::Fulfilled(_) = state {
        return err!(GreenCatError::VrfAlreadyFulfilled);
    }
    require!(now >= expires_at, GreenCatError::VrfNotExpired);
    Ok(())
}

/// CPI `orao_vrf::request_v2` (payer pays ORAO fee + request rent).
#[allow(clippy::too_many_arguments)]
pub fn cpi_request<'info>(
    vrf_program: AccountInfo<'info>,
    payer: AccountInfo<'info>,
    network_state: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    request: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    seed: [u8; 32],
) -> Result<()> {
    require_keys_eq!(
        request.key(),
        randomness_address(&seed),
        GreenCatError::InvalidVrfAccount
    );
    let accounts = orao_solana_vrf::cpi::accounts::RequestV2 {
        payer,
        network_state,
        treasury,
        request,
        system_program,
    };
    orao_solana_vrf::cpi::request_v2(CpiContext::new(vrf_program, accounts), seed)
}

/// Domain-separated 32-byte entropy from the 64-byte VRF output.
pub fn entropy_from_vrf(domain: &[u8], randomness: &[u8; 64], bind: &[u8]) -> [u8; 32] {
    hashv(&[domain, randomness, bind]).to_bytes()
}

pub fn u64_from(entropy: &[u8; 32]) -> u64 {
    u64::from_le_bytes(entropy[..8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_unique_and_nonzero() {
        let p = Pubkey::new_unique();
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        assert_ne!(mint_vrf_seed(&p, &a, 1), mint_vrf_seed(&p, &a, 2));
        assert_ne!(mint_vrf_seed(&p, &a, 1), mint_vrf_seed(&p, &b, 1));
    }

    /// GC-15 negative test: expiry never allows a refund/retry once fulfilled,
    /// and never before the deadline.
    #[test]
    fn expiry_rules() {
        let fulfilled = VrfState::Fulfilled([7u8; 64]);
        assert!(can_expire(1_000, 10, &fulfilled).is_err());
        assert!(can_expire(9, 10, &VrfState::Pending).is_err());
        assert!(can_expire(10, 10, &VrfState::Pending).is_ok());
    }

    #[test]
    fn expiry_bounds() {
        const { assert!(VRF_EXPIRY_MIN_SECS <= DEFAULT_VRF_EXPIRY_SECS) };
        const { assert!(DEFAULT_VRF_EXPIRY_SECS <= VRF_EXPIRY_MAX_SECS) };
    }
}
