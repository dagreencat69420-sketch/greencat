/**
 * Sign-In-With-Solana style auth:
 *   POST /auth/nonce  {wallet}                                    → {nonce, message, input, expiresAt}
 *   POST /auth/verify {wallet, nonce, signature, signedMessage?}  → {token, expiresAt}
 * Two client paths:
 *  - Wallet Standard `solana:signIn(input)` (Phantom, Solflare, ...): the wallet builds the SIWS text from
 *    `input` and returns {signedMessage, signature}. The server parses signedMessage and requires every
 *    field to equal the stored message's (domain, address, statement, URI, version, chain id, nonce, times),
 *    then verifies the ed25519 signature over signedMessage.
 *  - `signMessage(message)`: signature over the exact stored UTF-8 message.
 * Verified with tweetnacl against the wallet pubkey. Nonces are single-use + short-lived.
 * Session = HS256 JWT (Authorization: Bearer <token>).
 */
import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { SignJWT, jwtVerify } from "jose";
import { buildSignInInput, buildSignInMessage, sameSignInFields, type SiwsChainId } from "@greencat/sdk";
import type { Db } from "./db";

export const JWT_ISSUER = "greencat-api";
export const JWT_AUDIENCE = "greencat-points";

export function parseWallet(w: unknown): string | null {
  if (typeof w !== "string" || w.length < 32 || w.length > 44) return null;
  try {
    const pk = new PublicKey(w);
    return pk.toBase58() === w ? w : null;
  } catch {
    return null;
  }
}

/** Accept base58 (Phantom-style) or base64 detached signatures. */
export function decodeSignature(sig: unknown): Uint8Array | null {
  if (typeof sig !== "string" || !sig) return null;
  try {
    const b = bs58.decode(sig);
    if (b.length === 64) return Uint8Array.from(b);
  } catch {
    /* not base58 */
  }
  try {
    const b = Buffer.from(sig, "base64");
    if (b.length === 64) return Uint8Array.from(b);
  } catch {
    /* not base64 */
  }
  return null;
}

/** base64 (or base58) encoded signed-message bytes from a Wallet Standard signIn output; max 2 KB. */
export function decodeMessageBytes(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || !v || v.length > 4096) return null;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0) {
    const b = Buffer.from(v, "base64");
    if (b.length > 0 && b.length <= 2048) return Uint8Array.from(b);
  }
  try {
    const b = bs58.decode(v);
    if (b.length > 0 && b.length <= 2048) return Uint8Array.from(b);
  } catch {
    /* neither */
  }
  return null;
}

export class AuthService {
  constructor(
    private db: Db,
    private cfg: {
      jwtSecret: Uint8Array;
      sessionTtlSec: number;
      nonceTtlSec: number;
      siwsDomain: string;
      siwsUri: string;
      siwsDomains?: string[];
      siwsChainId?: SiwsChainId;
    },
    private now: () => Date = () => new Date()
  ) {}

  /**
   * Pick the SIWS domain + URI for a request. If the browser's Origin host is allowlisted
   * (siwsDomains), the message names that site; otherwise fall back to SIWS_DOMAIN / SIWS_URI.
   */
  siwsSiteFor(origin: string | undefined | null): { domain: string; uri: string } {
    if (origin) {
      try {
        const u = new URL(origin);
        const host = u.host.toLowerCase();
        if ((u.protocol === "https:" || u.protocol === "http:") && (this.cfg.siwsDomains ?? []).includes(host)) {
          return { domain: host, uri: `${u.protocol}//${host}` };
        }
      } catch {
        /* malformed Origin → default */
      }
    }
    return { domain: this.cfg.siwsDomain, uri: this.cfg.siwsUri };
  }

  async issueNonce(wallet: string, origin?: string | null) {
    const now = this.now();
    const site = this.siwsSiteFor(origin);
    const nonce = bs58.encode(randomBytes(16));
    const expires = new Date(now.getTime() + this.cfg.nonceTtlSec * 1000);
    const fields = {
      domain: site.domain,
      wallet,
      nonce,
      issuedAt: now.toISOString(),
      expirationTime: expires.toISOString(),
      uri: site.uri,
      chainId: this.cfg.siwsChainId ?? ("mainnet" as const),
    };
    const message = buildSignInMessage(fields);
    const input = buildSignInInput(fields);
    // opportunistic cleanup
    if (Math.random() < 0.05) {
      await this.db.query("DELETE FROM auth_nonces WHERE expires_at < $1", [
        new Date(now.getTime() - 3600_000).toISOString(),
      ]);
    }
    await this.db.query(
      "INSERT INTO auth_nonces (nonce, wallet, message, expires_at) VALUES ($1, $2, $3, $4)",
      [nonce, wallet, message, expires.toISOString()]
    );
    return { nonce, message, input, expiresAt: expires.toISOString() };
  }

  /** @returns session token or an error code */
  async verify(
    wallet: string,
    nonce: string,
    signature: Uint8Array,
    /** Bytes the wallet actually signed (Wallet Standard signIn output). Omit for the signMessage path. */
    signedMessage?: Uint8Array
  ): Promise<{ ok: true; token: string; expiresAt: string } | { ok: false; code: string; message: string }> {
    const now = this.now();
    const { rows } = await this.db.query<{ wallet: string; message: string; expires_at: string | Date; used_at: unknown }>(
      "SELECT wallet, message, expires_at, used_at FROM auth_nonces WHERE nonce = $1",
      [nonce]
    );
    const row = rows[0];
    if (!row || row.wallet !== wallet) return { ok: false, code: "bad_nonce", message: "Unknown nonce" };
    if (row.used_at) return { ok: false, code: "nonce_used", message: "Nonce already used" };
    if (new Date(row.expires_at).getTime() < now.getTime()) {
      return { ok: false, code: "nonce_expired", message: "Nonce expired — request a new one" };
    }
    let signedBytes = new TextEncoder().encode(row.message);
    if (signedMessage) {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(signedMessage);
      } catch {
        return { ok: false, code: "bad_message", message: "Signed message is not UTF-8" };
      }
      if (text !== row.message && !sameSignInFields(text, row.message)) {
        return { ok: false, code: "bad_message", message: "Signed message does not match the issued sign-in request" };
      }
      signedBytes = Uint8Array.from(signedMessage);
    }
    const okSig = nacl.sign.detached.verify(
      signedBytes,
      signature,
      new PublicKey(wallet).toBytes()
    );
    if (!okSig) return { ok: false, code: "bad_signature", message: "Signature does not match wallet" };
    // single-use: atomic consume
    const consumed = await this.db.query(
      "UPDATE auth_nonces SET used_at = now() WHERE nonce = $1 AND used_at IS NULL RETURNING nonce",
      [nonce]
    );
    if (!consumed.rows.length) return { ok: false, code: "nonce_used", message: "Nonce already used" };

    const exp = Math.floor(now.getTime() / 1000) + this.cfg.sessionTtlSec;
    const token = await new SignJWT({ typ: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(wallet)
      .setIssuer(JWT_ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(exp)
      .sign(this.cfg.jwtSecret);
    return { ok: true, token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async walletFromToken(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.cfg.jwtSecret, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ["HS256"],
        currentDate: this.now(),
      });
      if (payload.typ !== "session" || typeof payload.sub !== "string") return null;
      return parseWallet(payload.sub);
    } catch {
      return null;
    }
  }
}
