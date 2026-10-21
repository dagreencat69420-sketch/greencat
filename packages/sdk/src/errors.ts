/**
 * GreenCat program error codes (Anchor custom errors start at 6000, in enum order) with
 * user-facing messages. Generated from `programs/greencat/src/lib.rs` (enum GreenCatError);
 * `errors.test.ts` fails if the enum and this table drift apart.
 */

export const PROGRAM_ERROR_OFFSET = 6000;

export type ProgramErrorInfo = { code: number; name: string; msg: string; friendly: string };

export const PROGRAM_ERRORS: readonly ProgramErrorInfo[] = [
  { code: 6000, name: "Unauthorized", msg: "Unauthorized", friendly: "This wallet isn't allowed to do that (admin only)." },
  { code: 6001, name: "Paused", msg: "Program is paused", friendly: "GreenCat is paused for maintenance. Please try again after it resumes." },
  { code: 6002, name: "InvalidPool", msg: "Invalid pool_id (expected 0..5)", friendly: "Invalid pool_id (expected 0..5)" },
  { code: 6003, name: "ZeroAmount", msg: "Amount must be > 0", friendly: "Enter an amount greater than zero." },
  { code: 6004, name: "MintMismatch", msg: "Mint does not match config", friendly: "Wrong $GC token for this deployment. Check that your wallet and the app are on the same network." },
  { code: 6005, name: "InvalidVault", msg: "Treasury vault authority mismatch", friendly: "Treasury vault authority mismatch" },
  { code: 6006, name: "Overflow", msg: "Arithmetic overflow", friendly: "Arithmetic overflow" },
  { code: 6007, name: "SoldOut", msg: "Collection sold out", friendly: "The collection is sold out." },
  { code: 6008, name: "AlreadyMinted", msg: "Token id already minted", friendly: "Token id already minted" },
  { code: 6009, name: "UriTooLong", msg: "Metadata base URI too long (max 128)", friendly: "Metadata base URI too long (max 128)" },
  { code: 6010, name: "InvalidMetadata", msg: "Invalid Metaplex metadata/edition PDA", friendly: "Invalid Metaplex metadata/edition PDA" },
  { code: 6011, name: "InvalidSlotHashes", msg: "Invalid SlotHashes sysvar (removed)", friendly: "Invalid SlotHashes sysvar (removed)" },
  { code: 6012, name: "ListingInactive", msg: "Listing is not active", friendly: "This listing is no longer active. It may have just sold or been cancelled." },
  { code: 6013, name: "OfferInactive", msg: "Offer is not active", friendly: "This offer is no longer active." },
  { code: 6014, name: "SelfTrade", msg: "Cannot trade with yourself", friendly: "You can't buy your own listing or accept your own offer." },
  { code: 6015, name: "InsufficientNft", msg: "Seller does not hold the NFT", friendly: "The seller no longer holds this NFT." },
  { code: 6016, name: "InvalidListing", msg: "Invalid listing account", friendly: "Invalid listing account" },
  { code: 6017, name: "InvalidOffer", msg: "Invalid offer account", friendly: "Invalid offer account" },
  { code: 6018, name: "DailyPayoutExhausted", msg: "Daily lifetime payout allowance exhausted", friendly: "Daily staking rewards have run out for now (lifetime allowance used up)." },
  { code: 6019, name: "EmptyRewardPool", msg: "Reward pool empty or insufficient", friendly: "The reward pool is empty right now. Your principal is safe; try claiming later." },
  { code: 6020, name: "NothingToClaim", msg: "Nothing to claim (need a full accrual period)", friendly: "Nothing to claim yet. Rewards accrue per full 24 h period." },
  { code: 6021, name: "MinLockNotMet", msg: "Minimum 24h lock not finished", friendly: "Your stake is still inside the 24 h minimum lock." },
  { code: 6022, name: "StakeInactive", msg: "Stake is not active", friendly: "Stake is not active" },
  { code: 6023, name: "LongCapacityFull", msg: "365-day staking capacity full site-wide", friendly: "365-day staking is full site-wide." },
  { code: 6024, name: "StillLocked", msg: "Tranche still locked until unlock_at", friendly: "This 365-day tranche is still locked." },
  { code: 6025, name: "BadTrancheId", msg: "tranche_id does not match next_tranche_id", friendly: "Tranche number changed. Refresh and try again." },
  { code: 6026, name: "EmptyAirdropPool", msg: "Airdrop pool is empty", friendly: "Airdrop pool is empty" },
  { code: 6027, name: "NoQualifiers", msg: "(removed) No qualifiers", friendly: "(removed) No qualifiers" },
  { code: 6028, name: "ZeroPerUser", msg: "(removed) per_user would be 0", friendly: "(removed) per_user would be 0" },
  { code: 6029, name: "AirdropAlreadyPrepared", msg: "(removed) Airdrop prepare already active", friendly: "(removed) Airdrop prepare already active" },
  { code: 6030, name: "AirdropNotPrepared", msg: "(removed) No active airdrop prepare", friendly: "(removed) No active airdrop prepare" },
  { code: 6031, name: "NoRecipients", msg: "(removed) No recipient ATAs", friendly: "(removed) No recipient ATAs" },
  { code: 6032, name: "RecipientBelowThreshold", msg: "(removed) Recipient below threshold", friendly: "(removed) Recipient below threshold" },
  { code: 6033, name: "InvalidRecipientAta", msg: "Recipient account is not a valid token account", friendly: "Recipient account is not a valid token account" },
  { code: 6034, name: "RecipientNotWritable", msg: "(removed) Recipient token account must be writable", friendly: "(removed) Recipient token account must be writable" },
  { code: 6035, name: "AirdropBatchTooLarge", msg: "(removed) Too many recipients in one batch", friendly: "(removed) Too many recipients in one batch" },
  { code: 6036, name: "AirdropSlotsExhausted", msg: "(removed) Batch size exceeds remaining airdrop slots", friendly: "(removed) Batch size exceeds remaining airdrop slots" },
  { code: 6037, name: "DuplicateRecipient", msg: "(removed) Duplicate recipient ATA in batch", friendly: "(removed) Duplicate recipient ATA in batch" },
  { code: 6038, name: "WheelLocked", msg: "Wheel locked: lifetime payout allowance or bank cannot cover max win", friendly: "The wheel bank can't cover a win of this size right now. Try a smaller bet later." },
  { code: 6039, name: "BadSpinNonce", msg: "SpinRequest nonce mismatch", friendly: "That spin doesn't match. Refresh and try again." },
  { code: 6040, name: "SpinAlreadySettled", msg: "SpinRequest already settled", friendly: "This spin was already settled." },
  { code: 6041, name: "VrfNotConfigured", msg: "VRF provider not configured", friendly: "VRF provider not configured" },
  { code: 6042, name: "InvalidProceedsVault", msg: "Payment vault is not the mint_proceeds ATA", friendly: "Payment vault is not the mint_proceeds ATA" },
  { code: 6043, name: "InvalidPrincipalVault", msg: "Principal vault is not the staking principal ATA", friendly: "Principal vault is not the staking principal ATA" },
  { code: 6044, name: "InvalidFeeVault", msg: "Fee vault is not the nft_fee_treasury ATA", friendly: "Fee vault is not the nft_fee_treasury ATA" },
  { code: 6045, name: "InvalidPayoutAccount", msg: "Counterparty token account is not the expected ATA", friendly: "Counterparty token account is not the expected ATA" },
  { code: 6046, name: "InvalidEscrow", msg: "Escrow account is not the expected PDA-owned ATA", friendly: "Escrow account is not the expected PDA-owned ATA" },
  { code: 6047, name: "WheelReserveLocked", msg: "Withdrawal would dip into wheel funds reserved for pending spins", friendly: "That withdrawal would dip into funds reserved for pending spins." },
  { code: 6048, name: "AirdropRecipientIsVault", msg: "Airdrop recipient cannot be the airdrop vault", friendly: "Airdrop recipient cannot be the airdrop vault" },
  { code: 6049, name: "NotUpgradeAuthority", msg: "Signer is not the program upgrade authority", friendly: "Signer is not the program upgrade authority" },
  { code: 6050, name: "LiabilityFloor", msg: "Withdrawal would dip into funds owed to users (liability floor)", friendly: "That withdrawal would dip into funds owed to users." },
  { code: 6051, name: "PriceMismatch", msg: "Listing price changed (expected_price mismatch)", friendly: "The seller changed the price after you loaded it. Refresh to see the new price." },
  { code: 6052, name: "OfferBelowMinimum", msg: "Offer amount is below min_amount", friendly: "The offer dropped below the amount you accepted. Refresh the offer." },
  { code: 6053, name: "BetOutOfRange", msg: "Bet outside [wheel_min_bet, wheel_max_bet]", friendly: "Bet is outside the allowed range." },
  { code: 6054, name: "HouseEdgeChanged", msg: "House edge above the caller's max_house_edge_bps", friendly: "The house edge changed since you loaded the wheel. Refresh and confirm the new edge." },
  { code: 6055, name: "InvalidWheelParams", msg: "Invalid wheel parameters (edge ≤ 10%, 0 < min ≤ max ≤ hard cap)", friendly: "Invalid wheel parameters (edge ≤ 10%, 0 < min ≤ max ≤ hard cap)" },
  { code: 6056, name: "InvalidVrfAccount", msg: "Account is not the expected ORAO VRF randomness account", friendly: "Account is not the expected ORAO VRF randomness account" },
  { code: 6057, name: "VrfNotFulfilled", msg: "VRF randomness not fulfilled yet", friendly: "The randomness oracle hasn't answered yet. Wait a few seconds and press Settle again." },
  { code: 6058, name: "VrfAlreadyFulfilled", msg: "VRF randomness already fulfilled; settle instead", friendly: "The oracle already answered, so this spin can't be refunded. Settle it instead." },
  { code: 6059, name: "VrfNotExpired", msg: "VRF request not expired yet", friendly: "Refunds open only after the request expires without an oracle answer." },
  { code: 6060, name: "InvalidExpiry", msg: "Expiry outside the allowed window", friendly: "Expiry outside the allowed window (an airdrop needs 7 to 365 days of claim window left when posted; VRF expiry must be 1 hour to 7 days)" },
  { code: 6061, name: "NoPendingAuthority", msg: "No pending authority / signer is not the pending authority", friendly: "No pending authority / signer is not the pending authority" },
  { code: 6062, name: "InvalidAuthority", msg: "Invalid authority (default pubkey or unchanged)", friendly: "Invalid authority (default pubkey or unchanged)" },
  { code: 6063, name: "MintClosed", msg: "Mint is closed", friendly: "Minting has closed." },
  { code: 6064, name: "RevealNotReady", msg: "Reveal not available yet (needs sell-out or closed mint)", friendly: "The reveal isn't available yet." },
  { code: 6065, name: "RevealAlreadyRequested", msg: "Reveal already requested", friendly: "This cat's reveal was already requested. Wait a few seconds for the oracle." },
  { code: 6066, name: "AlreadyRevealed", msg: "Collection already revealed / NFT already revealed", friendly: "Already revealed." },
  { code: 6067, name: "NotRevealed", msg: "Collection not revealed yet", friendly: "The collection isn't revealed yet." },
  { code: 6068, name: "CollectionNftMissing", msg: "Collection NFT not created yet", friendly: "The collection isn't set up yet." },
  { code: 6069, name: "CollectionNftExists", msg: "Collection NFT already created", friendly: "Collection NFT already created" },
  { code: 6070, name: "RoyaltyTooHigh", msg: "Royalty above the 10% cap", friendly: "Royalty above the 10% cap" },
  { code: 6071, name: "RoyaltyLocked", msg: "Royalty can only change before the first mint", friendly: "Royalties can only change before the first mint." },
  { code: 6072, name: "InvalidMerkleProof", msg: "Invalid Merkle proof", friendly: "Your airdrop proof doesn't match. Make sure you loaded the latest proofs file." },
  { code: 6073, name: "ProofTooLong", msg: "Merkle proof too long", friendly: "Merkle proof too long" },
  { code: 6074, name: "AirdropExpired", msg: "Airdrop claim window has ended", friendly: "The airdrop claim window has ended." },
  { code: 6075, name: "AirdropNotExpired", msg: "Airdrop claim window still open", friendly: "The claim window is still open." },
  { code: 6076, name: "AirdropAlreadyReclaimed", msg: "Airdrop already reclaimed", friendly: "Unclaimed airdrop funds were already reclaimed." },
  { code: 6077, name: "AirdropOverClaim", msg: "Claim exceeds distribution total", friendly: "This distribution has no funds left for that claim." },
  { code: 6078, name: "AirdropInsufficientFunds", msg: "Airdrop vault lacks unreserved funds for this distribution", friendly: "The airdrop vault doesn't have enough unreserved $GC." },
  { code: 6079, name: "ReclaimGracePeriod", msg: "Reclaim blocked while paused or within the post-unpause grace period", friendly: "Reclaim is blocked while paused and for 3 days after unpausing." },
  { code: 6080, name: "InvalidCollectionMint", msg: "Collection mint does not match", friendly: "Collection mint does not match" },
  { code: 6081, name: "InvalidParam", msg: "Invalid parameter", friendly: "Invalid parameter" },
  { code: 6082, name: "MintPoolReady", msg: "Mint pool already fully initialized", friendly: "The mint pool is already set up." },
  { code: 6083, name: "MintQueueFull", msg: "Too many mints waiting to be revealed; settle the queue first", friendly: "Lots of cats are being revealed right now. Try again in a few seconds." },
  { code: 6084, name: "NotQueueHead", msg: "Not the reveal-queue head; settle earlier mints first", friendly: "Earlier mints are still being revealed. Your cat is next in line." },
  { code: 6085, name: "MintRequestMismatch", msg: "Reveal queue slot belongs to a different NFT", friendly: "That reveal request doesn't match this NFT." },
  { code: 6086, name: "StakingLocked", msg: "Staking is locked (opens after the launch airdrop); unstake and claim still work", friendly: "🔒 Staking opens after the launch airdrop is complete. Unstake and claim still work." },
];

const BY_CODE = new Map(PROGRAM_ERRORS.map((e) => [e.code, e]));
const BY_NAME = new Map(PROGRAM_ERRORS.map((e) => [e.name, e]));

export function programErrorByCode(code: number): ProgramErrorInfo | undefined {
  return BY_CODE.get(code);
}

export function programErrorByName(name: string): ProgramErrorInfo | undefined {
  return BY_NAME.get(name);
}

/**
 * Find a GreenCat program error in an error message / simulation logs:
 * `custom program error: 0x1771`, `Error Code: Paused`, or `"Custom":6001`.
 * Only codes ≥ 6000 are attributed to GreenCat (lower codes belong to the token/system programs).
 */
export function findProgramError(text: string): ProgramErrorInfo | undefined {
  const named = /Error Code: (\w+)/.exec(text);
  if (named) {
    const e = programErrorByName(named[1]);
    if (e) return e;
  }
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (hex) {
    const e = programErrorByCode(parseInt(hex[1], 16));
    if (e) return e;
  }
  const dec = /"Custom":\s*(\d+)/.exec(text);
  if (dec) return programErrorByCode(Number(dec[1]));
  return undefined;
}
