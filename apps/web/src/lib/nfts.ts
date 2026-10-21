"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { decodeNftRecordAccount, deriveNftRecordPda, type DecodedNftRecord } from "@greencat/sdk";

export type MyNft = { mint: string; record: DecodedNftRecord };

/**
 * GreenCat NFTs held by the connected wallet: classic-SPL token accounts with amount 1 / 0 decimals
 * whose mint has a GreenCat NftRecord PDA.
 */
export function useMyNfts() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [nfts, setNfts] = useState<MyNft[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!publicKey) {
      setNfts(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }, "confirmed");
      const mints = resp.value
        .map((a) => a.account.data.parsed?.info)
        .filter((i) => i?.tokenAmount?.decimals === 0 && i?.tokenAmount?.amount === "1")
        .map((i) => i.mint as string);
      const out: MyNft[] = [];
      for (let i = 0; i < mints.length; i += 100) {
        const chunk = mints.slice(i, i + 100);
        const recs = await connection.getMultipleAccountsInfo(
          chunk.map((m) => deriveNftRecordPda(new PublicKey(m))[0]),
          "confirmed"
        );
        recs.forEach((r, j) => {
          const rec = r ? decodeNftRecordAccount(Buffer.from(r.data)) : null;
          if (rec) out.push({ mint: chunk[j], record: rec });
        });
      }
      out.sort((a, b) => a.record.mintIndex - b.record.mintIndex);
      setNfts(out);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { nfts, loading, error, refresh };
}

export function nftLabel(n: MyNft): string {
  return n.record.revealed && n.record.tokenId > 0 ? `GreenCat #${n.record.tokenId}` : `Mint #${n.record.mintIndex + 1}`;
}
