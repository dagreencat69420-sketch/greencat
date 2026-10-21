/**
 * Placeholder IDL shape. Replace with `anchor build` output from
 * `target/idl/greencat.json` once the program builds.
 */
export const GREENCAT_IDL_PLACEHOLDER = {
  version: "0.1.0",
  name: "greencat",
  instructions: [
    { name: "initializeTreasuries" },
    { name: "mintNft" },
    { name: "listNft" },
    { name: "buyNft" },
    { name: "stakeDaily" },
    { name: "claimDaily" },
    { name: "stakeLong" },
    { name: "claimLong" },
    { name: "setAirdropThreshold" },
    { name: "runAirdrop" },
  ],
} as const;
