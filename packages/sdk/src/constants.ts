/**
 * Shared GreenCat constants.
 * Mainnet mint is Token-2022 (decimals=6). Devnet uses a classic SPL clone.
 */

/** Brand token — Solana mainnet pump.fun $GC (Token-2022). Canonical mint for the real app. */
export const MAINNET_GC_MINT =
  "G2b4ZNxLjgTnVtPbuHpK9WXpccFCedoLYQ5uxvdEpump" as const;

/** Mainnet mint decimals (verified via getTokenSupply 2026-09-25). */
export const MAINNET_GC_DECIMALS = 6 as const;

/**
 * Owner decisions (2026-10-02 PT): on mainnet the Config admin AND the NFT royalty recipient are the
 * owner's own wallet (MetaMask, Solana); no Squads multisig. `scripts/initialize-collection.ts` uses this
 * as the mainnet royalty recipient (the program's built-in default is the nft_fee_treasury PDA).
 */
export const MAINNET_ADMIN_WALLET = "13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6" as const;
export const MAINNET_ROYALTY_RECIPIENT = MAINNET_ADMIN_WALLET;
/** Mainnet-beta genesis hash (cluster detection in scripts). */
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" as const;

/** Devnet/localnet program id (declare_id! without the `mainnet` feature). */
export const DEVNET_PROGRAM_ID = "8Sy7mqZjHg9U9JW2qe1fEAfooyUrnDkz1XdqFB3ywvPE" as const;
/** Mainnet program id (declare_id! with `--features mainnet`; keys/mainnet-program.json, 2026-10-20 PT). */
export const MAINNET_PROGRAM_ID = "2pwrnxCswbq9cjgfRWQAMJUp6n1MRALpURLBjbmFURdc" as const;

function readProgramIdEnv(): string | undefined {
  try {
    // Literal accesses so Next.js inlines NEXT_PUBLIC_* at build time.
    return (
      process.env.NEXT_PUBLIC_GREENCAT_PROGRAM_ID?.trim() ||
      process.env.GREENCAT_PROGRAM_ID?.trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Active program id. Defaults to the Devnet id (CI/localnet/devnet unchanged). For mainnet set
 * `NEXT_PUBLIC_GREENCAT_PROGRAM_ID` (web) / `GREENCAT_PROGRAM_ID` (API, scripts) to MAINNET_PROGRAM_ID.
 */
export const GREENCAT_PROGRAM_ID: string = readProgramIdEnv() || DEVNET_PROGRAM_ID;

export type SolanaCluster = "devnet" | "mainnet-beta" | "localnet";

export const CLUSTER_RPC: Record<SolanaCluster, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
};

/** Default decimals for display when mint config is missing. */
export const DEFAULT_GC_DECIMALS = 6;

export const MINT_PRICE_GC = 10_000;

/** Collection size (token ids 1..10000). */
export const COLLECTION_SIZE = 10_000;
