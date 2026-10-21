/**
 * Sign-In-With-Solana (SIWS-style) message format shared by apps/api and apps/web.
 *
 * The server issues a nonce + the exact message text; the wallet signs the UTF-8 bytes
 * with `signMessage`; the server verifies the ed25519 signature against the pubkey and
 * re-derives the message from its own stored nonce record (client text is never trusted).
 */

export type SignInMessageFields = {
  /** Host the user is signing in to (e.g. "greencat.app" or "localhost:3001"). */
  domain: string;
  /** Base58 wallet pubkey. */
  wallet: string;
  /** Single-use random nonce issued by the API. */
  nonce: string;
  /** ISO-8601 issued-at timestamp. */
  issuedAt: string;
  /** ISO-8601 expiry of the nonce (signature must be submitted before this). */
  expirationTime: string;
  /** Origin URI (API base URL). */
  uri: string;
  /** Human statement shown in the wallet popup (single line, ASCII). */
  statement?: string;
  /**
   * SIWS Chain ID. Phantom only accepts `mainnet` | `testnet` | `devnet` | `localnet` | `solana:mainnet` |
   * `solana:testnet` | `solana:devnet` and refuses anything else with "The app's signature request cannot be
   * shown due to invalid formatting" (the old default `solana` hit exactly that). Default `mainnet`.
   */
  chainId?: SiwsChainId;
};

export type SiwsChainId = "mainnet" | "testnet" | "devnet" | "localnet" | "solana:mainnet" | "solana:testnet" | "solana:devnet";
export const SIWS_CHAIN_IDS: readonly SiwsChainId[] = [
  "mainnet",
  "testnet",
  "devnet",
  "localnet",
  "solana:mainnet",
  "solana:testnet",
  "solana:devnet",
];

/** Cluster name ("mainnet-beta", "devnet", ...) or RPC URL → SIWS chain id. */
export function siwsChainIdFor(clusterOrRpc: string | undefined | null): SiwsChainId {
  const v = (clusterOrRpc ?? "").toLowerCase();
  if (/\bdevnet\b/.test(v)) return "devnet";
  if (/\btestnet\b/.test(v)) return "testnet";
  if (/\blocal(net|host)?\b|127\.0\.0\.1/.test(v)) return "localnet";
  return "mainnet";
}

/**
 * Wallet Standard `solana:signIn` input (SolanaSignInInput) for the same fields, so a wallet that supports
 * signIn (Phantom, Solflare, Backpack, ...) builds byte-identical SIWS text itself.
 */
export type SiwsSignInInput = {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: "1";
  chainId: SiwsChainId;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
};

export function buildSignInInput(f: SignInMessageFields): SiwsSignInInput {
  return {
    domain: f.domain,
    address: f.wallet,
    statement: f.statement ?? SIWS_DEFAULT_STATEMENT,
    uri: f.uri,
    version: "1",
    chainId: f.chainId ?? "mainnet",
    nonce: f.nonce,
    issuedAt: f.issuedAt,
    expirationTime: f.expirationTime,
  };
}

export type ParsedSignInMessage = {
  domain: string;
  address: string;
  statement?: string;
  uri?: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
  notBefore?: string;
  requestId?: string;
  resources?: string[];
};

// Same grammar as @solana/wallet-standard-util parseSignInMessageText (SIWS / EIP-4361 field order).
const SIWS_RE = new RegExp(
  "^(?<domain>[^\\n]+?) wants you to sign in with your Solana account:\\n" +
    "(?<address>[^\\n]+)(?:\\n|$)" +
    "(?:\\n(?<statement>[\\S\\s]*?)(?:\\n|$))??" +
    "(?:\\nURI: (?<uri>[^\\n]+))?" +
    "(?:\\nVersion: (?<version>[^\\n]+))?" +
    "(?:\\nChain ID: (?<chainId>[^\\n]+))?" +
    "(?:\\nNonce: (?<nonce>[^\\n]+))?" +
    "(?:\\nIssued At: (?<issuedAt>[^\\n]+))?" +
    "(?:\\nExpiration Time: (?<expirationTime>[^\\n]+))?" +
    "(?:\\nNot Before: (?<notBefore>[^\\n]+))?" +
    "(?:\\nRequest ID: (?<requestId>[^\\n]+))?" +
    "(?:\\nResources:(?<resources>(?:\\n- [^\\n]+)*))?" +
    "\\n*$"
);

export function parseSignInMessageText(text: string): ParsedSignInMessage | null {
  const g = SIWS_RE.exec(text)?.groups;
  if (!g) return null;
  return {
    domain: g.domain,
    address: g.address,
    statement: g.statement,
    uri: g.uri,
    version: g.version,
    chainId: g.chainId,
    nonce: g.nonce,
    issuedAt: g.issuedAt,
    expirationTime: g.expirationTime,
    notBefore: g.notBefore,
    requestId: g.requestId,
    resources: g.resources?.split("\n- ").slice(1),
  };
}

const SIWS_KEYS = ["domain", "address", "statement", "uri", "version", "chainId", "nonce", "issuedAt", "expirationTime", "notBefore", "requestId"] as const;

/** True when two SIWS texts carry exactly the same fields (formatting differences such as a trailing newline are OK). */
export function sameSignInFields(a: string, b: string): boolean {
  const pa = parseSignInMessageText(a);
  const pb = parseSignInMessageText(b);
  if (!pa || !pb) return false;
  for (const k of SIWS_KEYS) if (pa[k] !== pb[k]) return false;
  return JSON.stringify(pa.resources ?? null) === JSON.stringify(pb.resources ?? null);
}

/**
 * Phantom's stricter SIWS rules (github.com/phantom/sign-in-with-solana ABNF). Returns the list of problems
 * (empty = OK). Used by tests so a regression in the message format is caught before a wallet refuses it.
 */
export function phantomSiwsProblems(text: string): string[] {
  const out: string[] = [];
  if (!/^[\x20-\x7e\n]*$/.test(text)) out.push("non-ASCII or control characters");
  if (/\r/.test(text)) out.push("CR line breaks");
  const p = parseSignInMessageText(text);
  if (!p) return [...out, "does not match the SIWS grammar"];
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.address)) out.push("address is not base58");
  if (p.statement !== undefined && (/\n/.test(p.statement) || !/^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;= ]+$/.test(p.statement)))
    out.push("statement must be one line of URI-safe ASCII");
  if (p.version !== undefined && p.version !== "1") out.push("Version must be 1");
  if (p.chainId !== undefined && !(SIWS_CHAIN_IDS as readonly string[]).includes(p.chainId)) out.push(`Chain ID '${p.chainId}' not allowed`);
  if (p.nonce !== undefined && !/^[A-Za-z0-9]{8,}$/.test(p.nonce)) out.push("Nonce must be 8+ alphanumerics");
  for (const k of ["issuedAt", "expirationTime", "notBefore"] as const) {
    const v = p[k];
    if (v !== undefined && Number.isNaN(Date.parse(v))) out.push(`${k} is not an ISO date`);
  }
  if (p.uri !== undefined) {
    try {
      new URL(p.uri);
    } catch {
      out.push("URI is not a URL");
    }
  }
  return out;
}

export const SIWS_DEFAULT_STATEMENT =
  "Sign in to GreenCat Points. This is free: it does not send a transaction or move funds.";

export function buildSignInMessage(f: SignInMessageFields): string {
  const lines = [
    `${f.domain} wants you to sign in with your Solana account:`,
    f.wallet,
    "",
    f.statement ?? SIWS_DEFAULT_STATEMENT,
    "",
    `URI: ${f.uri}`,
    "Version: 1",
    `Chain ID: ${f.chainId ?? "mainnet"}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
  ];
  return lines.join("\n");
}
