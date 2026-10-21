//! NFT secondary marketplace (REAL-APP-SPEC §D).
//!
//! Fee: 100 bps (1%). Buyer pays full price; seller nets 99%; fee → nft_fee_treasury.
//! `fee = price * 100 / 10000` (integer floor); `seller = price - fee`.
//! Primary mint is not fee'd (handled in mint_nft).

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::{
    associated_token,
    token::{self, TransferChecked as TokenTransferChecked},
    token_interface::{self, transfer_checked, CloseAccount, TransferChecked},
};

use crate::{
    require_ata, require_not_paused, AcceptOffer, BuyNft, CancelListing, CancelOffer, Config,
    GreenCatError, ListNft, MakeOffer, LISTING_SEED, OFFER_SEED,
};

/// Marketplace fee in basis points (100 = 1%).
pub const MARKETPLACE_FEE_BPS: u64 = 100;

/// `(fee, seller_net)` with integer floor. Buyer pays `price` total.
pub fn split_marketplace_fee(price: u64) -> Result<(u64, u64)> {
    let fee = price
        .checked_mul(MARKETPLACE_FEE_BPS)
        .ok_or(GreenCatError::Overflow)?
        / 10_000;
    let seller_net = price.checked_sub(fee).ok_or(GreenCatError::Overflow)?;
    Ok((fee, seller_net))
}

#[account]
pub struct Listing {
    pub seller: Pubkey,
    pub nft_mint: Pubkey,
    pub price: u64,
    pub bump: u8,
    pub active: bool,
}

impl Listing {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 1;
}

#[account]
pub struct Offer {
    pub bidder: Pubkey,
    pub nft_mint: Pubkey,
    pub amount: u64,
    pub bump: u8,
    pub active: bool,
}

impl Offer {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 1;
}

fn gc_decimals(gc_mint: &AccountInfo) -> Result<u8> {
    let data = gc_mint.try_borrow_data()?;
    require!(data.len() > 44, GreenCatError::MintMismatch);
    Ok(data[44])
}

fn require_gc_mint(config: &Config, gc_mint: &Pubkey, gc_token_program: &Pubkey) -> Result<()> {
    require_keys_eq!(config.gc_mint, *gc_mint, GreenCatError::MintMismatch);
    require_keys_eq!(
        config.token_program,
        *gc_token_program,
        GreenCatError::MintMismatch
    );
    Ok(())
}

/// Transfer classic SPL NFT (amount=1) with PDA signer seeds.
/// AUDIT(GC-05): `transfer_checked` binds the transfer to `mint` (decimals 0), so a
/// caller cannot substitute token accounts of a different (worthless) mint.
fn transfer_nft_signed<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.clone(),
            TokenTransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
            seeds,
        ),
        1,
        0,
    )
}

fn transfer_nft<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new(
            token_program.clone(),
            TokenTransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
        ),
        1,
        0,
    )
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

fn close_token_account_signed<'info>(
    token_program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    // AUDIT(GC-16): `anchor_spl::token::close_account` hard-codes the classic SPL
    // Token program id, so closing a Token-2022 $GC escrow always failed
    // (InvalidAccountData) → cancel_offer / accept_offer were impossible with the
    // mainnet mint and escrowed bids were stuck. The interface version uses the
    // program id of `token_program`.
    token_interface::close_account(CpiContext::new_with_signer(
        token_program.clone(),
        CloseAccount {
            account: account.clone(),
            destination: destination.clone(),
            authority: authority.clone(),
        },
        seeds,
    ))
}

#[inline(never)]
pub fn process_list_nft(ctx: Context<ListNft>, price: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    require!(price > 0, GreenCatError::ZeroAmount);
    require!(
        ctx.accounts.seller_nft_ata.amount == 1,
        GreenCatError::InsufficientNft
    );
    // AUDIT(GC-07): NFT must go to the listing PDA's ATA (real escrow).
    require_ata(
        &ctx.accounts.escrow_nft_ata.key(),
        &ctx.accounts.listing.key(),
        &ctx.accounts.nft_mint.key(),
        &token::ID,
        GreenCatError::InvalidEscrow,
    )?;

    ensure_ata(
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.escrow_nft_ata.to_account_info(),
        &ctx.accounts.listing.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
    )?;

    transfer_nft(
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.seller_nft_ata.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.escrow_nft_ata.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
    )?;

    let listing = &mut ctx.accounts.listing;
    listing.seller = ctx.accounts.seller.key();
    listing.nft_mint = ctx.accounts.nft_mint.key();
    listing.price = price;
    listing.bump = ctx.bumps.listing;
    listing.active = true;

    msg!(
        "list_nft: mint={} seller={} price={}",
        listing.nft_mint,
        listing.seller,
        price
    );
    Ok(())
}

#[inline(never)]
/// AUDIT(GC-19): not pause-gated — returns the seller's own NFT.
pub fn process_cancel_listing(ctx: Context<CancelListing>) -> Result<()> {
    require!(ctx.accounts.listing.active, GreenCatError::ListingInactive);

    let mint_key = ctx.accounts.nft_mint.key();
    let bump = ctx.accounts.listing.bump;
    let seeds: &[&[u8]] = &[LISTING_SEED, mint_key.as_ref(), &[bump]];
    let signer = &[seeds];

    // Ensure seller ATA exists
    ensure_ata(
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.seller_nft_ata.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
    )?;

    transfer_nft_signed(
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.escrow_nft_ata.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.seller_nft_ata.to_account_info(),
        &ctx.accounts.listing.to_account_info(),
        signer,
    )?;

    close_token_account_signed(
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.escrow_nft_ata.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.listing.to_account_info(),
        signer,
    )?;

    ctx.accounts.listing.active = false;

    msg!(
        "cancel_listing: mint={} seller={}",
        mint_key,
        ctx.accounts.seller.key()
    );
    Ok(())
}

#[inline(never)]
pub fn process_buy_nft(ctx: Context<BuyNft>, expected_price: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    // AUDIT(GC-21): slippage guard — seller can't cancel + relist higher in front of us.
    require!(
        ctx.accounts.listing.price == expected_price,
        GreenCatError::PriceMismatch
    );
    require_gc_mint(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.gc_token_program.key,
    )?;
    require!(ctx.accounts.listing.active, GreenCatError::ListingInactive);
    require_keys_eq!(
        ctx.accounts.listing.seller,
        ctx.accounts.seller.key(),
        GreenCatError::Unauthorized
    );
    require_keys_neq!(
        ctx.accounts.buyer.key(),
        ctx.accounts.seller.key(),
        GreenCatError::SelfTrade
    );

    // AUDIT(GC-04): seller proceeds must go to the seller's $GC ATA (not an
    // account chosen by the buyer, e.g. the buyer's own).
    require_ata(
        &ctx.accounts.seller_gc_ata.key(),
        &ctx.accounts.seller.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.gc_token_program.key,
        GreenCatError::InvalidPayoutAccount,
    )?;
    // AUDIT(GC-06): fee must go to the nft_fee_treasury ATA.
    require_ata(
        &ctx.accounts.nft_fee_treasury_vault.key(),
        &ctx.accounts.nft_fee_treasury.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.gc_token_program.key,
        GreenCatError::InvalidFeeVault,
    )?;
    require_ata(
        &ctx.accounts.escrow_nft_ata.key(),
        &ctx.accounts.listing.key(),
        &ctx.accounts.nft_mint.key(),
        &token::ID,
        GreenCatError::InvalidEscrow,
    )?;

    let price = ctx.accounts.listing.price;
    require!(price > 0, GreenCatError::ZeroAmount);
    let (fee, seller_net) = split_marketplace_fee(price)?;
    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;

    // Pay seller
    if seller_net > 0 {
        ensure_ata(
            &ctx.accounts.buyer.to_account_info(),
            &ctx.accounts.seller_gc_ata.to_account_info(),
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.gc_mint.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.gc_token_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
        )?;
        transfer_checked(
            CpiContext::new(
                ctx.accounts.gc_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_gc_ata.to_account_info(),
                    mint: ctx.accounts.gc_mint.to_account_info(),
                    to: ctx.accounts.seller_gc_ata.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            seller_net,
            decimals,
        )?;
    }

    // Pay fee treasury
    if fee > 0 {
        transfer_checked(
            CpiContext::new(
                ctx.accounts.gc_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_gc_ata.to_account_info(),
                    mint: ctx.accounts.gc_mint.to_account_info(),
                    to: ctx.accounts.nft_fee_treasury_vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            fee,
            decimals,
        )?;
    }

    // NFT → buyer
    ensure_ata(
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.buyer_nft_ata.to_account_info(),
        &ctx.accounts.buyer.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
    )?;

    let mint_key = ctx.accounts.nft_mint.key();
    let bump = ctx.accounts.listing.bump;
    let seeds: &[&[u8]] = &[LISTING_SEED, mint_key.as_ref(), &[bump]];
    let signer = &[seeds];

    transfer_nft_signed(
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.escrow_nft_ata.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.buyer_nft_ata.to_account_info(),
        &ctx.accounts.listing.to_account_info(),
        signer,
    )?;

    close_token_account_signed(
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.escrow_nft_ata.to_account_info(),
        &ctx.accounts.seller.to_account_info(),
        &ctx.accounts.listing.to_account_info(),
        signer,
    )?;

    ctx.accounts.listing.active = false;

    msg!(
        "buy_nft: mint={} buyer={} price={} fee={} seller_net={}",
        mint_key,
        ctx.accounts.buyer.key(),
        price,
        fee,
        seller_net
    );
    Ok(())
}

#[inline(never)]
pub fn process_make_offer(ctx: Context<MakeOffer>, amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    require_gc_mint(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.gc_token_program.key,
    )?;
    require!(amount > 0, GreenCatError::ZeroAmount);
    require_keys_eq!(
        ctx.accounts.nft_record.mint,
        ctx.accounts.nft_mint.key(),
        GreenCatError::MintMismatch
    );

    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;
    // AUDIT(GC-07): bid must be escrowed in the offer PDA's ATA.
    require_ata(
        &ctx.accounts.offer_gc_escrow.key(),
        &ctx.accounts.offer.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.gc_token_program.key,
        GreenCatError::InvalidEscrow,
    )?;

    ensure_ata(
        &ctx.accounts.bidder.to_account_info(),
        &ctx.accounts.offer_gc_escrow.to_account_info(),
        &ctx.accounts.offer.to_account_info(),
        &ctx.accounts.gc_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.gc_token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
    )?;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.gc_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.bidder_gc_ata.to_account_info(),
                mint: ctx.accounts.gc_mint.to_account_info(),
                to: ctx.accounts.offer_gc_escrow.to_account_info(),
                authority: ctx.accounts.bidder.to_account_info(),
            },
        ),
        amount,
        decimals,
    )?;

    let offer = &mut ctx.accounts.offer;
    offer.bidder = ctx.accounts.bidder.key();
    offer.nft_mint = ctx.accounts.nft_mint.key();
    offer.amount = amount;
    offer.bump = ctx.bumps.offer;
    offer.active = true;

    msg!(
        "make_offer: mint={} bidder={} amount={}",
        offer.nft_mint,
        offer.bidder,
        amount
    );
    Ok(())
}

#[inline(never)]
/// AUDIT(GC-19): not pause-gated — returns the bidder's own escrow.
pub fn process_cancel_offer(ctx: Context<CancelOffer>) -> Result<()> {
    require_gc_mint(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.gc_token_program.key,
    )?;
    require!(ctx.accounts.offer.active, GreenCatError::OfferInactive);

    let amount = ctx.accounts.offer.amount;
    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;
    let mint_key = ctx.accounts.nft_mint.key();
    let bidder_key = ctx.accounts.bidder.key();
    let bump = ctx.accounts.offer.bump;
    let seeds: &[&[u8]] = &[OFFER_SEED, mint_key.as_ref(), bidder_key.as_ref(), &[bump]];
    let signer = &[seeds];

    if amount > 0 {
        ensure_ata(
            &ctx.accounts.bidder.to_account_info(),
            &ctx.accounts.bidder_gc_ata.to_account_info(),
            &ctx.accounts.bidder.to_account_info(),
            &ctx.accounts.gc_mint.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.gc_token_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
        )?;
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.gc_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.offer_gc_escrow.to_account_info(),
                    mint: ctx.accounts.gc_mint.to_account_info(),
                    to: ctx.accounts.bidder_gc_ata.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                signer,
            ),
            amount,
            decimals,
        )?;
    }

    // Close empty escrow ATA → bidder
    close_token_account_signed(
        &ctx.accounts.gc_token_program.to_account_info(),
        &ctx.accounts.offer_gc_escrow.to_account_info(),
        &ctx.accounts.bidder.to_account_info(),
        &ctx.accounts.offer.to_account_info(),
        signer,
    )?;

    ctx.accounts.offer.active = false;

    msg!(
        "cancel_offer: mint={} bidder={} amount={}",
        mint_key,
        bidder_key,
        amount
    );
    Ok(())
}

#[inline(never)]
pub fn process_accept_offer(ctx: Context<AcceptOffer>, min_amount: u64) -> Result<()> {
    require_not_paused(&ctx.accounts.config)?;
    // AUDIT(GC-21): bidder can't cancel + re-offer lower in front of the seller.
    require!(
        ctx.accounts.offer.amount >= min_amount,
        GreenCatError::OfferBelowMinimum
    );
    require_gc_mint(
        &ctx.accounts.config,
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.gc_token_program.key,
    )?;
    require!(ctx.accounts.offer.active, GreenCatError::OfferInactive);
    require_keys_neq!(
        ctx.accounts.owner.key(),
        ctx.accounts.bidder.key(),
        GreenCatError::SelfTrade
    );
    require_keys_eq!(
        ctx.accounts.offer.bidder,
        ctx.accounts.bidder.key(),
        GreenCatError::Unauthorized
    );
    require_keys_eq!(
        ctx.accounts.offer.nft_mint,
        ctx.accounts.nft_mint.key(),
        GreenCatError::MintMismatch
    );

    // AUDIT(GC-05): the NFT must land in the bidder's ATA for *this* nft_mint.
    require_ata(
        &ctx.accounts.bidder_nft_ata.key(),
        &ctx.accounts.bidder.key(),
        &ctx.accounts.nft_mint.key(),
        &token::ID,
        GreenCatError::InvalidPayoutAccount,
    )?;
    // AUDIT(GC-06): fee must go to the nft_fee_treasury ATA.
    require_ata(
        &ctx.accounts.nft_fee_treasury_vault.key(),
        &ctx.accounts.nft_fee_treasury.key(),
        &ctx.accounts.gc_mint.key(),
        ctx.accounts.gc_token_program.key,
        GreenCatError::InvalidFeeVault,
    )?;

    let amount = ctx.accounts.offer.amount;
    require!(amount > 0, GreenCatError::ZeroAmount);
    let (fee, seller_net) = split_marketplace_fee(amount)?;
    let decimals = gc_decimals(&ctx.accounts.gc_mint.to_account_info())?;

    let nft_mint_key = ctx.accounts.nft_mint.key();
    let bidder_key = ctx.accounts.bidder.key();
    let offer_bump = ctx.accounts.offer.bump;
    let offer_seeds: &[&[u8]] = &[
        OFFER_SEED,
        nft_mint_key.as_ref(),
        bidder_key.as_ref(),
        &[offer_bump],
    ];
    let offer_signer = &[offer_seeds];

    // Pay owner from offer escrow
    if seller_net > 0 {
        ensure_ata(
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.owner_gc_ata.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.gc_mint.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.gc_token_program.to_account_info(),
            &ctx.accounts.associated_token_program.to_account_info(),
        )?;
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.gc_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.offer_gc_escrow.to_account_info(),
                    mint: ctx.accounts.gc_mint.to_account_info(),
                    to: ctx.accounts.owner_gc_ata.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                offer_signer,
            ),
            seller_net,
            decimals,
        )?;
    }

    if fee > 0 {
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.gc_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.offer_gc_escrow.to_account_info(),
                    mint: ctx.accounts.gc_mint.to_account_info(),
                    to: ctx.accounts.nft_fee_treasury_vault.to_account_info(),
                    authority: ctx.accounts.offer.to_account_info(),
                },
                offer_signer,
            ),
            fee,
            decimals,
        )?;
    }

    // Close offer GC escrow
    close_token_account_signed(
        &ctx.accounts.gc_token_program.to_account_info(),
        &ctx.accounts.offer_gc_escrow.to_account_info(),
        &ctx.accounts.bidder.to_account_info(),
        &ctx.accounts.offer.to_account_info(),
        offer_signer,
    )?;

    // Ensure bidder NFT ATA
    ensure_ata(
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.bidder_nft_ata.to_account_info(),
        &ctx.accounts.bidder.to_account_info(),
        &ctx.accounts.nft_mint.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.nft_token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
    )?;

    // If active listing for this mint/owner → take NFT from escrow & close listing
    let listing_ai = ctx.accounts.listing.to_account_info();
    // AUDIT(GC-10): only treat `listing` as a listing if it is the canonical
    // Listing PDA for this mint and carries the Listing discriminator (an Offer
    // has an identical byte layout).
    let (expected_listing, _) =
        Pubkey::find_program_address(&[LISTING_SEED, nft_mint_key.as_ref()], ctx.program_id);
    let from_listing = {
        if listing_ai.key() == expected_listing
            && listing_ai.owner == ctx.program_id
            && !listing_ai.data_is_empty()
        {
            let data = listing_ai.try_borrow_data()?;
            if data.len() >= Listing::LEN && data[..8] == Listing::DISCRIMINATOR[..] {
                // Skip 8-byte disc
                let seller = Pubkey::new_from_array(data[8..40].try_into().unwrap());
                let mint = Pubkey::new_from_array(data[40..72].try_into().unwrap());
                let active = data[8 + 32 + 32 + 8 + 1] != 0;
                active && seller == ctx.accounts.owner.key() && mint == nft_mint_key
            } else {
                false
            }
        } else {
            false
        }
    };

    if from_listing {
        let listing_bump = {
            let data = listing_ai.try_borrow_data()?;
            data[8 + 32 + 32 + 8]
        };
        let listing_seeds: &[&[u8]] = &[LISTING_SEED, nft_mint_key.as_ref(), &[listing_bump]];
        let listing_signer = &[listing_seeds];
        require_ata(
            &ctx.accounts.escrow_nft_ata.key(),
            &expected_listing,
            &nft_mint_key,
            &token::ID,
            GreenCatError::InvalidEscrow,
        )?;

        transfer_nft_signed(
            &ctx.accounts.nft_token_program.to_account_info(),
            &ctx.accounts.escrow_nft_ata.to_account_info(),
            &ctx.accounts.nft_mint.to_account_info(),
            &ctx.accounts.bidder_nft_ata.to_account_info(),
            &ctx.accounts.listing.to_account_info(),
            listing_signer,
        )?;

        close_token_account_signed(
            &ctx.accounts.nft_token_program.to_account_info(),
            &ctx.accounts.escrow_nft_ata.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.listing.to_account_info(),
            listing_signer,
        )?;

        // Mark inactive + close listing account (return rent to owner)
        {
            let mut data = listing_ai.try_borrow_mut_data()?;
            let active_idx = 8 + 32 + 32 + 8 + 1;
            if active_idx < data.len() {
                data[active_idx] = 0;
            }
        }
        // Manual close: drain lamports to owner
        let dest = ctx.accounts.owner.to_account_info();
        let listing_lamports = listing_ai.lamports();
        **dest.try_borrow_mut_lamports()? += listing_lamports;
        **listing_ai.try_borrow_mut_lamports()? = 0;
        listing_ai.assign(&anchor_lang::system_program::ID);
        listing_ai.resize(0)?;
    } else {
        // NFT must be in owner's wallet
        require!(
            !ctx.accounts.owner_nft_ata.data_is_empty(),
            GreenCatError::InsufficientNft
        );
        transfer_nft(
            &ctx.accounts.nft_token_program.to_account_info(),
            &ctx.accounts.owner_nft_ata.to_account_info(),
            &ctx.accounts.nft_mint.to_account_info(),
            &ctx.accounts.bidder_nft_ata.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
        )?;
    }

    ctx.accounts.offer.active = false;

    msg!(
        "accept_offer: mint={} owner={} bidder={} amount={} fee={} seller_net={} from_listing={}",
        nft_mint_key,
        ctx.accounts.owner.key(),
        bidder_key,
        amount,
        fee,
        seller_net,
        from_listing
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_split_1_percent_floor() {
        let (fee, net) = split_marketplace_fee(10_000).unwrap();
        assert_eq!(fee, 100);
        assert_eq!(net, 9_900);

        let (fee, net) = split_marketplace_fee(1_000_000_000).unwrap(); // 1000 GC @ 6dp
        assert_eq!(fee, 10_000_000);
        assert_eq!(net, 990_000_000);

        // floor: price 99 → fee 0
        let (fee, net) = split_marketplace_fee(99).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(net, 99);

        let (fee, net) = split_marketplace_fee(100).unwrap();
        assert_eq!(fee, 1);
        assert_eq!(net, 99);
    }

    #[test]
    fn account_lens() {
        assert_eq!(Listing::LEN, 82);
        assert_eq!(Offer::LEN, 82);
    }
}
