import { describe, expect, it } from "vitest";
import {
  buildSignInInput,
  buildSignInMessage,
  parseSignInMessageText,
  phantomSiwsProblems,
  sameSignInFields,
  siwsChainIdFor,
} from "../src";

const base = {
  domain: "app.greencat69420.com",
  wallet: "bZbWRznf1eD1aUFECZu433vGdXcSdrqZ3iNvcxmyw5x",
  nonce: "L3uKFRLCPwJ1wfHyPseu2K",
  issuedAt: "2026-10-03T16:32:20.708Z",
  expirationTime: "2026-10-03T16:37:20.708Z",
  uri: "https://app.greencat69420.com",
};

describe("SIWS message (Phantom strict format)", () => {
  it("the old live message (Chain ID: solana) is exactly what Phantom refused", () => {
    const old = buildSignInMessage(base).replace("Chain ID: mainnet", "Chain ID: solana");
    expect(phantomSiwsProblems(old)).toEqual(["Chain ID 'solana' not allowed"]);
  });

  it("devnet message: valid, canonical order, ASCII, LF only", () => {
    const m = buildSignInMessage({ ...base, chainId: "devnet" });
    expect(phantomSiwsProblems(m)).toEqual([]);
    expect(m.split("\n")).toEqual([
      "app.greencat69420.com wants you to sign in with your Solana account:",
      base.wallet,
      "",
      "Sign in to GreenCat Points. This is free: it does not send a transaction or move funds.",
      "",
      "URI: https://app.greencat69420.com",
      "Version: 1",
      "Chain ID: devnet",
      `Nonce: ${base.nonce}`,
      `Issued At: ${base.issuedAt}`,
      `Expiration Time: ${base.expirationTime}`,
    ]);
    expect(parseSignInMessageText(m)?.chainId).toBe("devnet");
  });

  it("signIn input mirrors the message; field comparison tolerates trailing newline only", () => {
    const f = { ...base, chainId: "devnet" as const };
    const m = buildSignInMessage(f);
    const i = buildSignInInput(f);
    expect(i).toMatchObject({ domain: base.domain, address: base.wallet, version: "1", chainId: "devnet", nonce: base.nonce });
    expect(sameSignInFields(m, m + "\n")).toBe(true);
    expect(sameSignInFields(m, m.replace("devnet", "mainnet"))).toBe(false);
    expect(sameSignInFields(m, "hello")).toBe(false);
  });

  it("flags non-ASCII statements and bad nonces", () => {
    expect(phantomSiwsProblems(buildSignInMessage({ ...base, statement: "Sign in — free" }))).toContain("non-ASCII or control characters");
    expect(phantomSiwsProblems(buildSignInMessage({ ...base, nonce: "ab-1" }))).toContain("Nonce must be 8+ alphanumerics");
  });

  it("chain id from cluster / RPC", () => {
    expect(siwsChainIdFor("devnet")).toBe("devnet");
    expect(siwsChainIdFor("mainnet-beta")).toBe("mainnet");
    expect(siwsChainIdFor("https://api.devnet.solana.com")).toBe("devnet");
    expect(siwsChainIdFor("http://127.0.0.1:8899")).toBe("localnet");
    expect(siwsChainIdFor("https://api.mainnet-beta.solana.com")).toBe("mainnet");
  });
});
