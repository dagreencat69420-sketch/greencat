/**
 * Anchor account discriminators + getProgramAccounts filters used by the web app to list
 * list marketplace accounts.
 */
import { sha256 } from "@noble/hashes/sha256";
import type { GetProgramAccountsFilter } from "@solana/web3.js";

/** sha256("account:<Name>")[0..8] */
export function anchorAccountDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`account:${name}`))).subarray(0, 8);
}

export const LISTING_ACCOUNT_DISC = anchorAccountDiscriminator("Listing");
/** programs/greencat/src/marketplace.rs `Listing::LEN` */
export const LISTING_ACCOUNT_LEN = 8 + 32 + 32 + 8 + 1 + 1;

/** getProgramAccounts filters for marketplace listings; pass `seller` to narrow. */
export function listingFilters(seller?: string): GetProgramAccountsFilter[] {
  const filters: GetProgramAccountsFilter[] = [
    { dataSize: LISTING_ACCOUNT_LEN },
    { memcmp: { offset: 0, encoding: "base64", bytes: LISTING_ACCOUNT_DISC.toString("base64") } },
  ];
  if (seller) filters.push({ memcmp: { offset: 8, bytes: seller } });
  return filters;
}
