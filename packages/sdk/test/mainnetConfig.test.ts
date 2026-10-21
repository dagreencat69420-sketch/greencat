import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { MAINNET_ADMIN_WALLET, MAINNET_ROYALTY_RECIPIENT } from "../src";

describe("mainnet owner decisions (2026-10-02)", () => {
  it("admin and royalty recipient are the owner's wallet", () => {
    expect(MAINNET_ADMIN_WALLET).toBe("13zewBMqmpvv9oJWaqBRn9ww59h6qBh7z5XNpowyfyj6");
    expect(MAINNET_ROYALTY_RECIPIENT).toBe(MAINNET_ADMIN_WALLET);
    expect(PublicKey.isOnCurve(new PublicKey(MAINNET_ROYALTY_RECIPIENT).toBytes())).toBe(true); // a wallet, not a PDA
  });
});
