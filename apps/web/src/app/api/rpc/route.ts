import { CLUSTER } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Solana-Client",
  "Cache-Control": "no-store",
};

/**
 * Methods that MUST go to the official Solana RPC first:
 * - Indexed methods (`getTokenAccountBalance`, `getTokenAccountsByOwner`, `getProgramAccounts`, etc.)
 *   because publicnode rejects indexed requests without an API token.
 * - Blockhash / blockheight / confirmation methods (`getBlockHeight`, `getLatestBlockhash`, `isBlockhashValid`)
 *   because publicnode returns the current *slot* (~461M) for `getBlockHeight` while `getLatestBlockhash`
 *   returns the real `lastValidBlockHeight` (~439M), which causes `@solana/web3.js` `confirmTransaction`
 *   to falsely throw `TransactionExpiredBlockheightExceededError` ("has expired: block height exceeded")
 *   immediately on the first check!
 */
const OFFICIAL_FIRST_METHODS = new Set([
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getParsedTokenAccountsByOwner",
  "getProgramAccounts",
  "getParsedProgramAccounts",
  "getSignaturesForAddress",
  "getTokenLargestAccounts",
  "getTokenSupply",
  "getBlockHeight",
  "getLatestBlockhash",
  "isBlockhashValid",
]);

function getUpstreams(): { fast: string; official: string } {
  const custom = process.env.SOLANA_RPC_UPSTREAM?.trim();
  if (custom) return { fast: custom, official: custom };
  if (CLUSTER === "devnet") {
    return {
      fast: "https://api.devnet.solana.com",
      official: "https://api.devnet.solana.com",
    };
  }
  return {
    fast: "https://solana-rpc.publicnode.com",
    official: "https://api.mainnet-beta.solana.com",
  };
}

async function forwardRpc(url: string, body: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store",
  });
  const text = await res.text();
  return { status: res.status, text };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: Request) {
  let body: string;
  try {
    body = await req.text();
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let method = "";
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      const match = parsed.find((item) => OFFICIAL_FIRST_METHODS.has(item?.method));
      method = match ? match.method : (parsed[0]?.method ?? "");
    } else if (parsed && typeof parsed.method === "string") {
      method = parsed.method;
    }
  } catch {
    // Forward raw body and let upstream return JSON-RPC error
  }

  const { fast, official } = getUpstreams();

  // For sendTransaction on mainnet, broadcast to BOTH official and publicnode in parallel
  // so the transaction reaches mainnet leaders immediately via multiple paths.
  if (method === "sendTransaction" && fast !== official) {
    try {
      const [rFast, rOff] = await Promise.allSettled([
        forwardRpc(fast, body),
        forwardRpc(official, body),
      ]);
      const okFast = rFast.status === "fulfilled" && rFast.value.status === 200 && !rFast.value.text.includes('"error"');
      if (okFast) {
        return new Response(rFast.value.text, {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      const okOff = rOff.status === "fulfilled" && rOff.value.status === 200 && !rOff.value.text.includes('"error"');
      if (okOff) {
        return new Response(rOff.value.text, {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      const fallback = rOff.status === "fulfilled" ? rOff.value : rFast.status === "fulfilled" ? rFast.value : null;
      if (fallback) {
        return new Response(fallback.text, {
          status: fallback.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    } catch {
      // Fall through to standard path
    }
  }

  const useOfficialFirst = OFFICIAL_FIRST_METHODS.has(method);
  const primary = useOfficialFirst ? official : fast;
  const secondary = useOfficialFirst ? fast : official;

  try {
    const first = await forwardRpc(primary, body);
    const needsFallback =
      primary !== secondary &&
      method !== "getBlockHeight" &&
      (first.status !== 200 ||
        first.text.includes("personal token") ||
        first.text.includes("Too many requests") ||
        first.text.includes("-32005"));

    if (needsFallback) {
      const second = await forwardRpc(secondary, body);
      if (second.status === 200 && !second.text.includes("personal token")) {
        return new Response(second.text, {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(first.text, {
      status: first.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch {
    if (primary !== secondary && method !== "getBlockHeight") {
      try {
        const second = await forwardRpc(secondary, body);
        return new Response(second.text, {
          status: second.status,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      } catch {
        // Fall through
      }
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "RPC upstream unreachable" }, id: null }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}
