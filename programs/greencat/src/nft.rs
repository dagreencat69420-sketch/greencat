//! NFT collection: init, verified collection NFT, mint, **instant per-mint reveal**.
//!
//! AUDIT(GC-17) — per-mint VRF reveal with a FIFO settle queue (replaces the old
//! "reveal after sell-out" rotation, which left every NFT unrevealed until the end):
//! 1. `mint_nft` takes the $GC payment, mints the NFT (placeholder metadata for a few
//!    seconds), appends the NFT to a 256-slot reveal queue at position
//!    `mint_index % 256`, and CPIs one ORAO VRF request with
//!    seed `H("greencat-mint-vrf-v1", program, nft_mint, attempt)`.
//! 2. ORAO fulfils off-chain (seconds).
//! 3. `settle_mint` (permissionless crank, the web UI sends it automatically) only
//!    accepts the **queue head** (`nft_record.mint_index == collection.revealed_count`).
//!    It draws `j = H(domain, randomness, nft_mint) mod remaining` and takes the id at
//!    `j` from the remaining-ids pool with swap-and-pop, then rewrites name/URI to
//!    `GreenCat #id` / `{base}{id}.json`.
//!
//! Why this cannot be sniped or steered:
//! * the id depends on VRF output that does not exist when the minter commits and pays;
//! * strict FIFO settlement means the pool state each NFT draws from is fixed by the
//!   NFTs ahead of it. Nobody (minter, cranker, admin) can reorder or delay settles to
//!   "re-roll" a known randomness against a different pool;
//! * a fulfilled request can never be re-requested; only an expired *unfulfilled* one
//!   (ORAO outage) can, with a new, unknown seed;
//! * swap-and-pop over 1..=10_000 hands out every id exactly once, so the rarity
//!   counts (100/900/2000/7000, seed `greencat-meme-collection-v1`) stay exact.
//!
//! The pool lives in its own PDA `["mint_pool"]` (zero-copy, 32 296 B): `ids[i] == 0`
//! means "identity" (id `i + 1`), so the account needs no 10k-entry initialisation.
//! It is created/grown permissionlessly in ≤ 10 KiB steps by `init_mint_pool`.
//!
//! AUDIT(GC-18) — the `nft_authority` PDA is mint-time update authority of every NFT
//! and of the sized collection NFT; it is also a verified 0-share creator so
//! marketplaces can authenticate the collection. Holders never receive update
//! authority. Royalty (`seller_fee_basis_points`) goes to `royalty_recipient`
//! (default: the nft_fee_treasury PDA, 500 bps), changeable only before the first mint.

use anchor_spl::{
    associated_token::{self, AssociatedToken},
    metadata::{
        create_master_edition_v3, create_metadata_accounts_v3,
        mpl_token_metadata::{
            self,
            types::{Collection as MplCollection, CollectionDetails, Creator, DataV2},
        },
        update_metadata_accounts_v2, verify_sized_collection_item, CreateMasterEditionV3,
        CreateMetadataAccountsV3, Metadata as MetaplexMetadata, UpdateMetadataAccountsV2,
        VerifySizedCollectionItem,
    },
    token::{self, Token},
    token_interface::{transfer_checked, TransferChecked},
};

use crate::rarity::{fill_rarity_table_into, rarity_label, COLLECTION_SIZE};
use crate::vrf::{self, VrfState};
use crate::*;
use anchor_lang::solana_program::entrypoint::MAX_PERMITTED_DATA_INCREASE;

pub const NFT_SYMBOL: &str = "GCAT";
pub const COLLECTION_NAME: &str = "GreenCat";
pub const DEFAULT_ROYALTY_BPS: u16 = 500;
pub const MAX_ROYALTY_BPS: u16 = 1_000;

/// Legacy collection-wide reveal state. Always `REVEAL_NONE` now; the old
/// request/finalize/reveal instructions were removed (per-mint reveal instead).
pub const REVEAL_NONE: u8 = 0;

/// Max NFTs minted but not yet settled. `mint_nft` fails with `MintQueueFull` beyond
/// this until the queue head is settled (anyone can crank `settle_mint`).
pub const MINT_QUEUE_LEN: usize = 256;

/// Zero-copy collection state (rarity table packed 2 bits/token).
#[account(zero_copy)]
#[repr(C)]
pub struct Collection {
    pub bump: u8,
    pub metadata_base_uri_len: u8,
    /// Legacy (always 0). Kept for layout compatibility.
    pub reveal_state: u8,
    pub mint_closed: u8,
    pub collection_nft_created: u8,
    /// Legacy (unused).
    pub reveal_attempts: u8,
    pub royalty_bps: u16,
    pub minted_count: u64,
    pub collection_size: u64,
    pub mint_price_raw: u64,
    pub metadata_base_uri: [u8; 128],
    /// 2 bits per token index (00 common … 11 legendary). 2500 used + 4 pad.
    pub rarity_bits: [u8; 2504],
    pub collection_mint: Pubkey,
    pub royalty_recipient: Pubkey,
    /// Legacy collection-reveal fields (unused since the per-mint reveal upgrade).
    pub reveal_seed: [u8; 32],
    pub reveal_randomness: [u8; 32],
    pub reveal_offset: u64,
    pub reveal_requested_ts: i64,
    /// Number of settled (revealed) NFTs = mint_index of the reveal-queue head.
    pub revealed_count: u64,
}

impl Collection {
    pub const LEN: usize = 8 + 8 + 8 * 3 + 128 + 2504 + 32 * 4 + 8 * 3;

    pub fn base_uri(&self) -> &str {
        core::str::from_utf8(&self.metadata_base_uri[..self.metadata_base_uri_len as usize])
            .unwrap_or(DEFAULT_METADATA_BASE_URI)
    }
}

pub fn rarity_bits_get(bits: &[u8], idx: u16) -> u8 {
    let i = idx as usize;
    (bits[i / 4] >> ((i % 4) * 2)) & 0b11
}

pub fn rarity_bits_set(bits: &mut [u8], idx: u16, rarity: u8) {
    let i = idx as usize;
    let shift = (i % 4) * 2;
    bits[i / 4] = (bits[i / 4] & !(0b11u8 << shift)) | ((rarity & 0b11) << shift);
}

/// One pending reveal (queue slot `mint_index % MINT_QUEUE_LEN`). Empty = default key.
#[zero_copy]
#[repr(C)]
pub struct MintSlot {
    pub nft_mint: Pubkey,
    pub requested_ts: i64,
    pub attempt: u8,
    pub _pad: [u8; 7],
}

/// Remaining-ids pool + reveal queue (PDA `["mint_pool"]`, zero-copy).
#[account(zero_copy)]
#[repr(C)]
pub struct MintPool {
    /// Swap-and-pop pool over token ids. Only `ids[..remaining]` is live, where
    /// `remaining = collection_size - revealed_count`. 0 = identity (id `i + 1`).
    pub ids: [u16; 10_000],
    pub queue: [MintSlot; MINT_QUEUE_LEN],
}

impl MintPool {
    pub const LEN: usize = 8 + 2 * 10_000 + 48 * MINT_QUEUE_LEN;
}

/// Value at pool position `i` (0 = identity).
pub fn pool_get(ids: &[u16], i: usize) -> u16 {
    match ids[i] {
        0 => (i + 1) as u16,
        v => v,
    }
}

/// Swap-and-pop: return the id at position `j` (< remaining) and move the last live
/// id into its place. Every id 1..=N comes out exactly once over N draws.
pub fn pool_take(ids: &mut [u16], j: usize, remaining: usize) -> u16 {
    let id = pool_get(ids, j);
    let last = remaining - 1;
    ids[j] = pool_get(ids, last);
    id
}

/// Pool position drawn for one NFT from its fulfilled VRF output.
pub fn pool_index_from_randomness(randomness: &[u8; 64], nft_mint: &Pubkey, remaining: u64) -> u64 {
    let e = vrf::entropy_from_vrf(vrf::MINT_VRF_DOMAIN, randomness, nft_mint.as_ref());
    vrf::u64_from(&e) % remaining
}

fn metadata_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"metadata", mpl_token_metadata::ID.as_ref(), mint.as_ref()],
        &mpl_token_metadata::ID,
    )
    .0
}

fn edition_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"metadata",
            mpl_token_metadata::ID.as_ref(),
            mint.as_ref(),
            b"edition",
        ],
        &mpl_token_metadata::ID,
    )
    .0
}

fn creators(nft_authority: Pubkey, recipient: Pubkey) -> Option<Vec<Creator>> {
    Some(vec![
        Creator {
            address: nft_authority,
            verified: true,
            share: 0,
        },
        Creator {
            address: recipient,
            verified: false,
            share: 100,
        },
    ])
}

fn collection_data(c: &Collection, nft_authority: Pubkey) -> DataV2 {
    DataV2 {
        name: COLLECTION_NAME.to_string(),
        symbol: NFT_SYMBOL.to_string(),
        uri: format!("{}collection.json", c.base_uri()),
        seller_fee_basis_points: c.royalty_bps,
        creators: creators(nft_authority, c.royalty_recipient),
        collection: None,
        uses: None,
    }
}

fn require_authority(config: &Config, signer: &Pubkey) -> Result<()> {
    require_keys_eq!(config.authority, *signer, GreenCatError::Unauthorized);
    Ok(())
}

// ─── initialize_collection ──────────────────────────────────────────────────

#[inline(never)]
pub fn process_initialize_collection(
    ctx: Context<InitializeCollection>,
    metadata_base_uri: String,
) -> Result<()> {
    require_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    let uri = if metadata_base_uri.is_empty() {
        DEFAULT_METADATA_BASE_URI.to_string()
    } else {
        metadata_base_uri
    };
    require!(uri.len() <= 128, GreenCatError::UriTooLong);

    let (fee_treasury, _) = Pubkey::find_program_address(&[NFT_FEE_TREASURY_SEED], ctx.program_id);
    let (collection_mint, _) =
        Pubkey::find_program_address(&[COLLECTION_MINT_SEED], ctx.program_id);

    let mut c = ctx.accounts.collection.load_init()?;
    c.bump = ctx.bumps.collection;
    c.minted_count = 0;
    c.collection_size = COLLECTION_SIZE as u64;
    c.mint_price_raw = MINT_PRICE_RAW;
    c.metadata_base_uri_len = uri.len() as u8;
    c.metadata_base_uri[..uri.len()].copy_from_slice(uri.as_bytes());
    c.royalty_bps = DEFAULT_ROYALTY_BPS;
    c.royalty_recipient = fee_treasury;
    c.collection_mint = collection_mint;
    let mut table = vec![0u8; COLLECTION_SIZE as usize];
    fill_rarity_table_into(&mut table);
    for (i, r) in table.iter().enumerate() {
        rarity_bits_set(&mut c.rarity_bits, i as u16, *r);
    }
    msg!(
        "initialize_collection: size={} price_raw={} royalty_bps={} uri={}",
        c.collection_size,
        c.mint_price_raw,
        c.royalty_bps,
        uri
    );
    Ok(())
}

// ─── create_collection_nft ──────────────────────────────────────────────────

#[inline(never)]
pub fn process_create_collection_nft(ctx: Context<CreateCollectionNft>) -> Result<()> {
    require_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    let a = &ctx.accounts;
    let mint_key = a.collection_mint.key();
    require_keys_eq!(
        a.collection_metadata.key(),
        metadata_pda(&mint_key),
        GreenCatError::InvalidMetadata
    );
    require_keys_eq!(
        a.collection_master_edition.key(),
        edition_pda(&mint_key),
        GreenCatError::InvalidMetadata
    );

    let data = {
        let c = a.collection.load()?;
        require!(
            c.collection_nft_created == 0,
            GreenCatError::CollectionNftExists
        );
        require_keys_eq!(
            c.collection_mint,
            mint_key,
            GreenCatError::InvalidCollectionMint
        );
        collection_data(&c, a.nft_authority.key())
    };

    let bump = [ctx.bumps.nft_authority];
    let signer: &[&[&[u8]]] = &[&[NFT_AUTHORITY_SEED, &bump]];

    token::mint_to(
        CpiContext::new_with_signer(
            a.nft_token_program.to_account_info(),
            token::MintTo {
                mint: a.collection_mint.to_account_info(),
                to: a.collection_token_account.to_account_info(),
                authority: a.nft_authority.to_account_info(),
            },
            signer,
        ),
        1,
    )?;

    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            a.token_metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: a.collection_metadata.to_account_info(),
                mint: a.collection_mint.to_account_info(),
                mint_authority: a.nft_authority.to_account_info(),
                payer: a.authority.to_account_info(),
                update_authority: a.nft_authority.to_account_info(),
                system_program: a.system_program.to_account_info(),
                rent: a.rent.to_account_info(),
            },
            signer,
        ),
        data,
        true,
        true,
        Some(CollectionDetails::V1 { size: 0 }),
    )?;

    create_master_edition_v3(
        CpiContext::new_with_signer(
            a.token_metadata_program.to_account_info(),
            CreateMasterEditionV3 {
                edition: a.collection_master_edition.to_account_info(),
                mint: a.collection_mint.to_account_info(),
                update_authority: a.nft_authority.to_account_info(),
                mint_authority: a.nft_authority.to_account_info(),
                payer: a.authority.to_account_info(),
                metadata: a.collection_metadata.to_account_info(),
                token_program: a.nft_token_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
                rent: a.rent.to_account_info(),
            },
            signer,
        ),
        Some(0),
    )?;

    a.collection.load_mut()?.collection_nft_created = 1;
    msg!("create_collection_nft: mint={}", mint_key);
    Ok(())
}

// ─── set_royalty / close_mint ───────────────────────────────────────────────

#[inline(never)]
pub fn process_set_royalty(
    ctx: Context<SetRoyalty>,
    royalty_bps: u16,
    recipient: Pubkey,
) -> Result<()> {
    require_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    require!(
        royalty_bps <= MAX_ROYALTY_BPS,
        GreenCatError::RoyaltyTooHigh
    );
    require!(
        recipient != Pubkey::default() && recipient != ctx.accounts.nft_authority.key(),
        GreenCatError::InvalidParam
    );
    let a = &ctx.accounts;
    let (created, data) = {
        let mut c = a.collection.load_mut()?;
        require!(c.minted_count == 0, GreenCatError::RoyaltyLocked);
        c.royalty_bps = royalty_bps;
        c.royalty_recipient = recipient;
        (
            c.collection_nft_created == 1,
            collection_data(&c, a.nft_authority.key()),
        )
    };
    if created {
        // keep the collection NFT's royalty in sync
        let mint_key = a.collection.load()?.collection_mint;
        require_keys_eq!(
            a.collection_metadata.key(),
            metadata_pda(&mint_key),
            GreenCatError::InvalidMetadata
        );
        let bump = [ctx.bumps.nft_authority];
        let signer: &[&[&[u8]]] = &[&[NFT_AUTHORITY_SEED, &bump]];
        update_metadata_accounts_v2(
            CpiContext::new_with_signer(
                a.token_metadata_program.to_account_info(),
                UpdateMetadataAccountsV2 {
                    metadata: a.collection_metadata.to_account_info(),
                    update_authority: a.nft_authority.to_account_info(),
                },
                signer,
            ),
            None,
            Some(data),
            None,
            None,
        )?;
    }
    emit!(AdminAction {
        action: 5,
        actor: a.authority.key(),
        value: royalty_bps as u64,
        key: recipient,
    });
    Ok(())
}

pub fn process_close_mint(ctx: Context<CloseMint>) -> Result<()> {
    require_authority(&ctx.accounts.config, &ctx.accounts.authority.key())?;
    let mut c = ctx.accounts.collection.load_mut()?;
    require!(c.mint_closed == 0, GreenCatError::MintClosed);
    c.mint_closed = 1;
    emit!(AdminAction {
        action: 6,
        actor: ctx.accounts.authority.key(),
        value: c.minted_count,
        key: Pubkey::default(),
    });
    Ok(())
}

// ─── mint_nft ───────────────────────────────────────────────────────────────

#[inline(never)]
pub fn process_mint_nft(ctx: Context<MintNft>) -> Result<()> {
    let a = &ctx.accounts;
    require_not_paused(&a.config)?;
    require_keys_eq!(
        a.config.gc_mint,
        a.gc_mint.key(),
        GreenCatError::MintMismatch
    );
    require_keys_eq!(
        *a.gc_token_program.key,
        a.config.token_program,
        GreenCatError::MintMismatch
    );
    require_ata(
        &a.mint_proceeds_vault.key(),
        &a.mint_proceeds.key(),
        &a.config.gc_mint,
        &a.config.token_program,
        GreenCatError::InvalidProceedsVault,
    )?;
    let nft_mint_key = a.nft_mint.key();
    require_keys_eq!(
        a.metadata.key(),
        metadata_pda(&nft_mint_key),
        GreenCatError::InvalidMetadata
    );
    require_keys_eq!(
        a.master_edition.key(),
        edition_pda(&nft_mint_key),
        GreenCatError::InvalidMetadata
    );

    // state checks + reserve the index
    let (mint_index, price, royalty_bps, recipient, base) = {
        let mut c = a.collection.load_mut()?;
        require!(
            c.collection_nft_created == 1,
            GreenCatError::CollectionNftMissing
        );
        require_keys_eq!(
            c.collection_mint,
            a.collection_mint.key(),
            GreenCatError::InvalidCollectionMint
        );
        require!(c.mint_closed == 0, GreenCatError::MintClosed);
        require!(c.reveal_state == REVEAL_NONE, GreenCatError::MintClosed);
        require!(c.minted_count < c.collection_size, GreenCatError::SoldOut);
        require!(c.mint_price_raw > 0, GreenCatError::ZeroAmount);
        let pending = c
            .minted_count
            .checked_sub(c.revealed_count)
            .ok_or(GreenCatError::Overflow)?;
        require!(
            pending < MINT_QUEUE_LEN as u64,
            GreenCatError::MintQueueFull
        );
        let idx = c.minted_count as u16;
        c.minted_count += 1;
        (
            idx,
            c.mint_price_raw,
            c.royalty_bps,
            c.royalty_recipient,
            c.base_uri().to_string(),
        )
    };
    require_keys_eq!(
        a.collection_metadata.key(),
        metadata_pda(&a.collection_mint.key()),
        GreenCatError::InvalidMetadata
    );
    require_keys_eq!(
        a.collection_master_edition.key(),
        edition_pda(&a.collection_mint.key()),
        GreenCatError::InvalidMetadata
    );

    let decimals = {
        let data = a.gc_mint.try_borrow_data()?;
        require!(data.len() > 44, GreenCatError::MintMismatch);
        data[44]
    };

    // 1) payment
    transfer_checked(
        CpiContext::new(
            a.gc_token_program.to_account_info(),
            TransferChecked {
                from: a.buyer_gc_ata.to_account_info(),
                mint: a.gc_mint.to_account_info(),
                to: a.mint_proceeds_vault.to_account_info(),
                authority: a.buyer.to_account_info(),
            },
        ),
        price,
        decimals,
    )?;

    // 2) SPL mint (client keypair) + buyer ATA + 1 token
    let mint_ai = a.nft_mint.to_account_info();
    let buyer_ai = a.buyer.to_account_info();
    anchor_lang::system_program::create_account(
        CpiContext::new(
            a.system_program.to_account_info(),
            anchor_lang::system_program::CreateAccount {
                from: buyer_ai.clone(),
                to: mint_ai.clone(),
            },
        ),
        Rent::get()?.minimum_balance(82),
        82,
        &token::ID,
    )?;
    token::initialize_mint2(
        CpiContext::new(
            a.nft_token_program.to_account_info(),
            token::InitializeMint2 {
                mint: mint_ai.clone(),
            },
        ),
        0,
        buyer_ai.key,
        Some(buyer_ai.key),
    )?;
    if a.buyer_nft_ata.data_is_empty() {
        associated_token::create(CpiContext::new(
            a.associated_token_program.to_account_info(),
            associated_token::Create {
                payer: buyer_ai.clone(),
                associated_token: a.buyer_nft_ata.to_account_info(),
                authority: buyer_ai.clone(),
                mint: mint_ai.clone(),
                system_program: a.system_program.to_account_info(),
                token_program: a.nft_token_program.to_account_info(),
            },
        ))?;
    }
    token::mint_to(
        CpiContext::new(
            a.nft_token_program.to_account_info(),
            token::MintTo {
                mint: mint_ai.clone(),
                to: a.buyer_nft_ata.to_account_info(),
                authority: buyer_ai.clone(),
            },
        ),
        1,
    )?;

    // 3) metadata (update authority = nft_authority PDA) + master edition + verify
    let bump = [ctx.bumps.nft_authority];
    let signer: &[&[&[u8]]] = &[&[NFT_AUTHORITY_SEED, &bump]];
    let nft_auth = a.nft_authority.key();
    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            a.token_metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: a.metadata.to_account_info(),
                mint: mint_ai.clone(),
                mint_authority: buyer_ai.clone(),
                payer: buyer_ai.clone(),
                update_authority: a.nft_authority.to_account_info(),
                system_program: a.system_program.to_account_info(),
                rent: a.rent.to_account_info(),
            },
            signer,
        ),
        DataV2 {
            name: format!("GreenCat Mint #{}", mint_index as u32 + 1),
            symbol: NFT_SYMBOL.to_string(),
            uri: format!("{}unrevealed.json", base),
            seller_fee_basis_points: royalty_bps,
            creators: creators(nft_auth, recipient),
            collection: Some(MplCollection {
                verified: false,
                key: a.collection_mint.key(),
            }),
            uses: None,
        },
        true,
        true,
        None,
    )?;
    create_master_edition_v3(
        CpiContext::new_with_signer(
            a.token_metadata_program.to_account_info(),
            CreateMasterEditionV3 {
                edition: a.master_edition.to_account_info(),
                mint: mint_ai.clone(),
                update_authority: a.nft_authority.to_account_info(),
                mint_authority: buyer_ai.clone(),
                payer: buyer_ai.clone(),
                metadata: a.metadata.to_account_info(),
                token_program: a.nft_token_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
                rent: a.rent.to_account_info(),
            },
            signer,
        ),
        Some(0),
    )?;
    verify_sized_collection_item(
        CpiContext::new_with_signer(
            a.token_metadata_program.to_account_info(),
            VerifySizedCollectionItem {
                payer: buyer_ai.clone(),
                metadata: a.metadata.to_account_info(),
                collection_authority: a.nft_authority.to_account_info(),
                collection_mint: a.collection_mint.to_account_info(),
                collection_metadata: a.collection_metadata.to_account_info(),
                collection_master_edition: a.collection_master_edition.to_account_info(),
            },
            signer,
        ),
        None,
    )?;

    // 4) per-mint reveal: queue slot + ORAO VRF request (buyer pays the oracle fee)
    let now = Clock::get()?.unix_timestamp;
    let seed = vrf::mint_vrf_seed(ctx.program_id, &nft_mint_key, 1);
    vrf::cpi_request(
        a.vrf_program.to_account_info(),
        buyer_ai.clone(),
        a.vrf_network_state.to_account_info(),
        a.vrf_treasury.to_account_info(),
        a.vrf_request.to_account_info(),
        a.system_program.to_account_info(),
        seed,
    )?;
    {
        let mut pool = a.mint_pool.load_mut()?;
        let slot = &mut pool.queue[mint_index as usize % MINT_QUEUE_LEN];
        require_keys_eq!(
            slot.nft_mint,
            Pubkey::default(),
            GreenCatError::MintQueueFull
        );
        slot.nft_mint = nft_mint_key;
        slot.requested_ts = now;
        slot.attempt = 1;
    }

    let record = &mut ctx.accounts.nft_record;
    record.mint = nft_mint_key;
    record.buyer = ctx.accounts.buyer.key();
    record.token_id = 0;
    record.rarity = RARITY_UNREVEALED;
    record.bump = ctx.bumps.nft_record;
    record.mint_index = mint_index;
    record.revealed = false;
    record._pad = [0; 5];

    emit!(NftMinted {
        token_id: 0,
        rarity: RARITY_UNREVEALED,
        buyer: record.buyer,
        mint: nft_mint_key,
        mint_index,
    });
    msg!(
        "mint_nft: mint_index={} buyer={} mint={} (unrevealed)",
        mint_index,
        record.buyer,
        nft_mint_key
    );
    Ok(())
}

// ─── per-mint reveal: pool init, (re-)request, settle ────────────────────────

/// Permissionless: create the `["mint_pool"]` PDA, or grow it by ≤ 10 KiB. Call until
/// it reaches `MintPool::LEN` (4 calls; they fit in one transaction). The
/// discriminator is written on the last step, so the pool is unusable until complete.
#[inline(never)]
pub fn process_init_mint_pool(ctx: Context<InitMintPool>) -> Result<()> {
    let pool = ctx.accounts.mint_pool.to_account_info();
    let target = MintPool::LEN;
    let cur = pool.data_len();
    require!(cur < target, GreenCatError::MintPoolReady);
    let new_len = cur + (target - cur).min(MAX_PERMITTED_DATA_INCREASE);

    let need = Rent::get()?
        .minimum_balance(new_len)
        .saturating_sub(pool.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: pool.clone(),
                },
            ),
            need,
        )?;
    }
    if cur == 0 && *pool.owner == anchor_lang::system_program::ID {
        let bump = [ctx.bumps.mint_pool];
        let signer: &[&[&[u8]]] = &[&[MINT_POOL_SEED, &bump]];
        anchor_lang::system_program::allocate(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Allocate {
                    account_to_allocate: pool.clone(),
                },
                signer,
            ),
            new_len as u64,
        )?;
        anchor_lang::system_program::assign(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Assign {
                    account_to_assign: pool.clone(),
                },
                signer,
            ),
            ctx.program_id,
        )?;
    } else {
        require_keys_eq!(*pool.owner, *ctx.program_id, GreenCatError::InvalidParam);
        pool.resize(new_len)?;
    }
    if new_len == target {
        let mut data = pool.try_borrow_mut_data()?;
        data[..8].copy_from_slice(MintPool::DISCRIMINATOR);
    }
    msg!("init_mint_pool: len={}/{}", new_len, target);
    Ok(())
}

/// Permissionless: request the reveal VRF for an NFT that has none (minted before
/// the per-mint upgrade), or re-request after an expired, *unfulfilled* request.
#[inline(never)]
pub fn process_request_mint_vrf(ctx: Context<RequestMintVrf>) -> Result<()> {
    let a = &ctx.accounts;
    require_not_paused(&a.config)?;
    require!(!a.nft_record.revealed, GreenCatError::AlreadyRevealed);
    let nft_mint_key = a.nft_mint.key();
    let idx = a.nft_record.mint_index as u64;
    {
        let c = a.collection.load()?;
        require!(
            idx >= c.revealed_count && idx < c.minted_count,
            GreenCatError::AlreadyRevealed
        );
    }
    let now = Clock::get()?.unix_timestamp;
    let slot_i = idx as usize % MINT_QUEUE_LEN;
    let (cur_mint, cur_attempt, cur_ts) = {
        let pool = a.mint_pool.load()?;
        let s = &pool.queue[slot_i];
        (s.nft_mint, s.attempt, s.requested_ts)
    };
    let next_attempt = if cur_mint == Pubkey::default() {
        // legacy NFT (minted with the old collection-reveal program): first request
        1u8
    } else {
        require_keys_eq!(cur_mint, nft_mint_key, GreenCatError::MintRequestMismatch);
        let prev = a
            .previous_request
            .as_ref()
            .ok_or(error!(GreenCatError::RevealAlreadyRequested))?;
        let prev_seed = vrf::mint_vrf_seed(ctx.program_id, &nft_mint_key, cur_attempt);
        let st = vrf::read_vrf(&prev.to_account_info(), &prev_seed)?;
        let expires = cur_ts
            .checked_add(a.config.vrf_expiry_secs)
            .ok_or(GreenCatError::Overflow)?;
        vrf::can_expire(now, expires, &st)?;
        cur_attempt.checked_add(1).ok_or(GreenCatError::Overflow)?
    };
    let seed = vrf::mint_vrf_seed(ctx.program_id, &nft_mint_key, next_attempt);
    vrf::cpi_request(
        a.vrf_program.to_account_info(),
        a.payer.to_account_info(),
        a.vrf_network_state.to_account_info(),
        a.vrf_treasury.to_account_info(),
        a.vrf_request.to_account_info(),
        a.system_program.to_account_info(),
        seed,
    )?;
    {
        let mut pool = a.mint_pool.load_mut()?;
        let s = &mut pool.queue[slot_i];
        s.nft_mint = nft_mint_key;
        s.attempt = next_attempt;
        s.requested_ts = now;
    }
    msg!(
        "request_mint_vrf: mint={} mint_index={} attempt={} vrf_request={}",
        nft_mint_key,
        idx,
        next_attempt,
        a.vrf_request.key()
    );
    Ok(())
}

/// Permissionless crank: reveal the queue head from its fulfilled VRF output.
#[inline(never)]
pub fn process_settle_mint(ctx: Context<SettleMint>) -> Result<()> {
    let a = &ctx.accounts;
    require_not_paused(&a.config)?;
    require!(!a.nft_record.revealed, GreenCatError::AlreadyRevealed);
    let mint_key = a.nft_mint.key();
    require_keys_eq!(
        a.metadata.key(),
        metadata_pda(&mint_key),
        GreenCatError::InvalidMetadata
    );
    let mint_index = a.nft_record.mint_index;

    let (token_id, rarity, data) = {
        let mut c = a.collection.load_mut()?;
        require_keys_eq!(
            c.collection_mint,
            a.collection_mint.key(),
            GreenCatError::InvalidCollectionMint
        );
        let head = c.revealed_count;
        require!(mint_index as u64 == head, GreenCatError::NotQueueHead);
        let remaining = c
            .collection_size
            .checked_sub(head)
            .ok_or(GreenCatError::Overflow)?;
        require!(remaining > 0, GreenCatError::SoldOut);

        let mut pool = a.mint_pool.load_mut()?;
        let slot_i = head as usize % MINT_QUEUE_LEN;
        let (slot_mint, attempt) = (pool.queue[slot_i].nft_mint, pool.queue[slot_i].attempt);
        require_keys_eq!(slot_mint, mint_key, GreenCatError::MintRequestMismatch);
        let seed = vrf::mint_vrf_seed(ctx.program_id, &mint_key, attempt);
        let r = match vrf::read_vrf(&a.vrf_request.to_account_info(), &seed)? {
            VrfState::Fulfilled(r) => r,
            VrfState::Pending => return err!(GreenCatError::VrfNotFulfilled),
        };
        let j = pool_index_from_randomness(&r, &mint_key, remaining);
        let token_id = pool_take(&mut pool.ids, j as usize, remaining as usize);
        pool.queue[slot_i] = MintSlot {
            nft_mint: Pubkey::default(),
            requested_ts: 0,
            attempt: 0,
            _pad: [0; 7],
        };
        c.revealed_count = head.checked_add(1).ok_or(GreenCatError::Overflow)?;

        let rarity = rarity_bits_get(&c.rarity_bits, token_id - 1);
        let data = DataV2 {
            name: format!("GreenCat #{}", token_id),
            symbol: NFT_SYMBOL.to_string(),
            uri: format!("{}{}.json", c.base_uri(), token_id),
            seller_fee_basis_points: c.royalty_bps,
            creators: creators(a.nft_authority.key(), c.royalty_recipient),
            collection: Some(MplCollection {
                verified: true,
                key: c.collection_mint,
            }),
            uses: None,
        };
        (token_id, rarity, data)
    };

    let bump = [ctx.bumps.nft_authority];
    let signer: &[&[&[u8]]] = &[&[NFT_AUTHORITY_SEED, &bump]];
    update_metadata_accounts_v2(
        CpiContext::new_with_signer(
            a.token_metadata_program.to_account_info(),
            UpdateMetadataAccountsV2 {
                metadata: a.metadata.to_account_info(),
                update_authority: a.nft_authority.to_account_info(),
            },
            signer,
        ),
        None,
        Some(data),
        None,
        None,
    )?;

    let record = &mut ctx.accounts.nft_record;
    record.token_id = token_id;
    record.rarity = rarity;
    record.revealed = true;
    emit!(NftRevealed {
        mint: mint_key,
        mint_index,
        token_id,
        rarity
    });
    // Same log format as the old reveal_nft so existing indexers keep working.
    msg!(
        "reveal_nft: mint={} mint_index={} token_id={} rarity={}",
        mint_key,
        mint_index,
        token_id,
        rarity_label(rarity)
    );
    Ok(())
}

// ─── Account contexts ───────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeCollection<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = authority, space = Collection::LEN, seeds = [COLLECTION_SEED], bump)]
    pub collection: AccountLoader<'info, Collection>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateCollectionNft<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [COLLECTION_SEED], bump)]
    pub collection: AccountLoader<'info, Collection>,
    /// CHECK: PDA signer (update/mint authority)
    #[account(seeds = [NFT_AUTHORITY_SEED], bump)]
    pub nft_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [COLLECTION_MINT_SEED],
        bump,
        mint::decimals = 0,
        mint::authority = nft_authority,
        mint::freeze_authority = nft_authority,
        mint::token_program = nft_token_program,
    )]
    pub collection_mint: Box<Account<'info, token::Mint>>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = collection_mint,
        associated_token::authority = nft_authority,
        associated_token::token_program = nft_token_program,
    )]
    pub collection_token_account: Box<Account<'info, token::TokenAccount>>,
    /// CHECK: Metaplex metadata PDA (checked in handler)
    #[account(mut)]
    pub collection_metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex edition PDA (checked in handler)
    #[account(mut)]
    pub collection_master_edition: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, MetaplexMetadata>,
    pub nft_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetRoyalty<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [COLLECTION_SEED], bump)]
    pub collection: AccountLoader<'info, Collection>,
    /// CHECK: PDA signer
    #[account(seeds = [NFT_AUTHORITY_SEED], bump)]
    pub nft_authority: UncheckedAccount<'info>,
    /// CHECK: collection metadata PDA (checked in handler when the collection NFT exists)
    #[account(mut)]
    pub collection_metadata: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, MetaplexMetadata>,
}

#[derive(Accounts)]
pub struct CloseMint<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [COLLECTION_SEED], bump)]
    pub collection: AccountLoader<'info, Collection>,
}

#[derive(Accounts)]
pub struct MintNft<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// Client-generated mint keypair.
    #[account(mut)]
    pub nft_mint: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [COLLECTION_SEED], bump)]
    pub collection: AccountLoader<'info, Collection>,
    /// CHECK: $GC mint (validated vs config in handler)
    pub gc_mint: UncheckedAccount<'info>,
    /// CHECK: mint_proceeds PDA
    #[account(seeds = [MINT_PROCEEDS_SEED], bump = config.mint_proceeds_bump)]
    pub mint_proceeds: UncheckedAccount<'info>,
    /// CHECK: mint_proceeds vault ATA (require_ata)
    #[account(mut)]
    pub mint_proceeds_vault: UncheckedAccount<'info>,
    /// CHECK: buyer $GC account (token program enforces authority)
    #[account(mut)]
    pub buyer_gc_ata: UncheckedAccount<'info>,
    /// CHECK: buyer NFT ATA (created if empty)
    #[account(mut)]
    pub buyer_nft_ata: UncheckedAccount<'info>,
    /// CHECK: metadata PDA (checked)
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: edition PDA (checked)
    #[account(mut)]
    pub master_edition: UncheckedAccount<'info>,
    #[account(
        init,
        payer = buyer,
        space = NftRecord::LEN,
        seeds = [NFT_RECORD_SEED, nft_mint.key().as_ref()],
        bump
    )]
    pub nft_record: Box<Account<'info, NftRecord>>,
    /// CHECK: PDA signer
    #[account(seeds = [NFT_AUTHORITY_SEED], bump)]
    pub nft_authority: UncheckedAccount<'info>,
    /// CHECK: must equal collection.collection_mint (checked)
    pub collection_mint: UncheckedAccount<'info>,
    /// CHECK: collection metadata PDA (checked)
    #[account(mut)]
    pub collection_metadata: UncheckedAccount<'info>,
    /// CHECK: collection edition PDA (checked)
    pub collection_master_edition: UncheckedAccount<'info>,
    /// CHECK: $GC token program (== config.token_program)
    pub gc_token_program: UncheckedAccount<'info>,
    pub nft_token_program: Program<'info, Token>,
    pub token_metadata_program: Program<'info, MetaplexMetadata>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    // ── per-mint reveal (appended) ──
    #[account(mut, seeds = [MINT_POOL_SEED], bump)]
    pub mint_pool: AccountLoader<'info, MintPool>,
    /// CHECK: ORAO network state (validated by ORAO)
    #[account(mut, seeds = [vrf::VRF_CONFIG_SEED], bump, seeds::program = orao_solana_vrf::ID)]
    pub vrf_network_state: UncheckedAccount<'info>,
    /// CHECK: ORAO treasury (validated by ORAO against network state)
    #[account(mut)]
    pub vrf_treasury: UncheckedAccount<'info>,
    /// CHECK: new ORAO randomness PDA (address checked vs derived seed)
    #[account(mut)]
    pub vrf_request: UncheckedAccount<'info>,
    pub vrf_program: Program<'info, vrf::OraoVrf>,
}

#[derive(Accounts)]
pub struct InitMintPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: PDA ["mint_pool"]; created / grown in the handler (owner checked there)
    #[account(mut, seeds = [MINT_POOL_SEED], bump)]
    pub mint_pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestMintVrf<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [COLLECTION_SEED], bump)]
    pub collection: AccountLoader<'info, Collection>,
    #[account(mut, seeds = [MINT_POOL_SEED], bump)]
    pub mint_pool: AccountLoader<'info, MintPool>,
    /// CHECK: key only (NftRecord seeds bind it)
    pub nft_mint: UncheckedAccount<'info>,
    #[account(
        seeds = [NFT_RECORD_SEED, nft_mint.key().as_ref()],
        bump = nft_record.bump,
        constraint = nft_record.mint == nft_mint.key() @ GreenCatError::MintMismatch,
    )]
    pub nft_record: Box<Account<'info, NftRecord>>,
    /// CHECK: ORAO network state (validated by ORAO)
    #[account(mut, seeds = [vrf::VRF_CONFIG_SEED], bump, seeds::program = orao_solana_vrf::ID)]
    pub vrf_network_state: UncheckedAccount<'info>,
    /// CHECK: ORAO treasury (validated by ORAO against network state)
    #[account(mut)]
    pub vrf_treasury: UncheckedAccount<'info>,
    /// CHECK: new ORAO randomness PDA (address checked vs derived seed)
    #[account(mut)]
    pub vrf_request: UncheckedAccount<'info>,
    /// CHECK: previous (expired, unfulfilled) request; required for a re-request
    pub previous_request: Option<UncheckedAccount<'info>>,
    pub vrf_program: Program<'info, vrf::OraoVrf>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleMint<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [COLLECTION_SEED], bump)]
    pub collection: AccountLoader<'info, Collection>,
    #[account(mut, seeds = [MINT_POOL_SEED], bump)]
    pub mint_pool: AccountLoader<'info, MintPool>,
    /// CHECK: key only
    pub nft_mint: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [NFT_RECORD_SEED, nft_mint.key().as_ref()],
        bump = nft_record.bump,
        constraint = nft_record.mint == nft_mint.key() @ GreenCatError::MintMismatch,
    )]
    pub nft_record: Box<Account<'info, NftRecord>>,
    /// CHECK: metadata PDA (checked)
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: PDA signer
    #[account(seeds = [NFT_AUTHORITY_SEED], bump)]
    pub nft_authority: UncheckedAccount<'info>,
    /// CHECK: must equal collection.collection_mint
    pub collection_mint: UncheckedAccount<'info>,
    /// CHECK: ORAO randomness account (address/owner/seed checked)
    pub vrf_request: UncheckedAccount<'info>,
    pub token_metadata_program: Program<'info, MetaplexMetadata>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rarity::*;

    #[test]
    fn collection_len() {
        assert_eq!(Collection::LEN, 2824);
        assert_eq!(core::mem::size_of::<Collection>() + 8, Collection::LEN);
    }

    #[test]
    fn mint_pool_len() {
        assert_eq!(MintPool::LEN, 32_296);
        assert_eq!(core::mem::size_of::<MintPool>() + 8, MintPool::LEN);
        assert_eq!(core::mem::size_of::<MintSlot>(), 48);
        const { assert!(MintPool::LEN - 8 <= 4 * MAX_PERMITTED_DATA_INCREASE) };
    }

    /// GC-17: swap-and-pop over the zero-initialised pool hands out every id exactly
    /// once, for any sequence of draws, and keeps the rarity counts exact.
    #[test]
    fn pool_swap_and_pop_exact() {
        let mut table = vec![0u8; COLLECTION_SIZE as usize];
        fill_rarity_table_into(&mut table);
        let mut bits = vec![0u8; 2504];
        for (i, r) in table.iter().enumerate() {
            rarity_bits_set(&mut bits, i as u16, *r);
        }
        for salt in 0u8..3 {
            let mut ids = vec![0u16; 10_000];
            let mut seen = vec![false; 10_000];
            let mut counts = [0usize; 4];
            let mint = Pubkey::new_from_array([salt; 32]);
            for k in 0..10_000u64 {
                let remaining = 10_000 - k;
                let mut r = [0u8; 64];
                r[..8].copy_from_slice(&k.to_le_bytes());
                r[8] = salt;
                let j = pool_index_from_randomness(&r, &mint, remaining);
                assert!(j < remaining);
                let id = pool_take(&mut ids, j as usize, remaining as usize);
                assert!((1..=10_000).contains(&id));
                assert!(!seen[(id - 1) as usize], "duplicate id {id}");
                seen[(id - 1) as usize] = true;
                counts[rarity_bits_get(&bits, id - 1) as usize] += 1;
            }
            assert_eq!(
                counts,
                [COUNT_COMMON, COUNT_UNCOMMON, COUNT_RARE, COUNT_LEGENDARY]
            );
        }
    }

    #[test]
    fn pool_take_edges() {
        let mut ids = vec![0u16; 5];
        assert_eq!(pool_take(&mut ids, 4, 5), 5); // take last
        assert_eq!(pool_take(&mut ids, 0, 4), 1); // id 4 moves to 0
        assert_eq!(pool_get(&ids, 0), 4);
        assert_eq!(pool_take(&mut ids, 0, 3), 4);
        assert_eq!(pool_take(&mut ids, 1, 2), 2);
        assert_eq!(pool_take(&mut ids, 0, 1), 3);
    }

    #[test]
    fn pool_index_bound_to_mint() {
        let r = [9u8; 64];
        let a = Pubkey::new_unique();
        let b = Pubkey::new_unique();
        assert!(pool_index_from_randomness(&r, &a, 10_000) < 10_000);
        assert_ne!(
            pool_index_from_randomness(&r, &a, 10_000),
            pool_index_from_randomness(&r, &b, 10_000)
        );
    }

    #[test]
    fn royalty_defaults() {
        assert_eq!(DEFAULT_ROYALTY_BPS, 500);
        const { assert!(MAX_ROYALTY_BPS <= 1_000) };
        let c = creators(Pubkey::new_unique(), Pubkey::new_unique()).unwrap();
        assert_eq!(c.iter().map(|x| x.share as u32).sum::<u32>(), 100);
    }
}
