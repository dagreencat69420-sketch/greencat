"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { decodeAirdropDistributionAccount, deriveAirdropDistributionPda, GREENCAT_PROGRAM_ID, type DecodedAirdropDistribution } from "@greencat/sdk";
import { UserFacingError } from "@/lib/errors";

/** `airdrop-<id>-proofs.json` written by `scripts/airdrop.ts snapshot` (published by the team, e.g. on the website). */
export type ProofsFile = {
  version: 1;
  programId: string;
  gcMint: string;
  distributionId: string;
  distribution: string;
  merkleRoot: string;
  totalAmountRaw: string;
  expiryTs: number;
  claims: { index: number; claimant: string; amountRaw: string; proof: string[] }[];
};

/** Optional build-time override set by the operator (never by a URL/query param), e.g. a CDN copy of the published file. */
const ENV_PROOFS_URL = process.env.NEXT_PUBLIC_AIRDROP_PROOFS_URL?.trim() || "";
/**
 * Published by the team in `apps/web/public/airdrops/current.json`: either a full proofs file, or a pointer
 * `{ "current": "airdrop-1-proofs.json" }` (relative to /airdrops/), or `{ "current": null }` for "no airdrop".
 * Used when NEXT_PUBLIC_AIRDROP_PROOFS_URL isn't set, so publishing an airdrop is a file commit + redeploy (no env change).
 */
export const PUBLISHED_PROOFS_URL = "/airdrops/current.json";
const AUTO_PROOFS_URL = ENV_PROOFS_URL || PUBLISHED_PROOFS_URL;

/** Where the loaded file came from: the site's published file, or pasted by an admin on /admin. */
export type ProofsSource = "published" | "pasted";

/**
 * Load + validate the published proofs file and the matching on-chain distribution (root must match).
 * Holders (/airdrop) only ever get the auto-loaded published file; `loadText` (paste) is for the admin fallback on /admin.
 */
export function useAirdropProofs() {
  const { connection } = useConnection();
  const [file, setFile] = useState<ProofsFile | null>(null);
  const [dist, setDist] = useState<DecodedAirdropDistribution | null>(null);
  const [source, setSource] = useState<ProofsSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const apply = useCallback(
    async (text: string, from: ProofsSource) => {
      setLoading(true);
      setError(null);
      try {
        let f: ProofsFile;
        try {
          f = JSON.parse(text) as ProofsFile;
        } catch {
          throw new UserFacingError("unknown", "That isn't valid JSON. Paste the whole proofs file.");
        }
        if (f.version !== 1 || !f.merkleRoot || !Array.isArray(f.claims)) throw new UserFacingError("unknown", "That isn't a GreenCat airdrop proofs file.");
        if (f.programId !== GREENCAT_PROGRAM_ID) throw new UserFacingError("wrong_network", "These proofs are for a different GreenCat deployment.");
        const [distPk] = deriveAirdropDistributionPda(BigInt(f.distributionId));
        const info = await connection.getAccountInfo(distPk, "confirmed");
        const d = info ? decodeAirdropDistributionAccount(Buffer.from(info.data)) : null;
        if (d && Buffer.from(d.merkleRoot).toString("hex") !== f.merkleRoot) {
          throw new UserFacingError("unknown", "This proofs file doesn't match the on-chain airdrop. Don't trust it.");
        }
        setFile(f);
        setDist(d);
        setSource(from);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    },
    [connection]
  );

  /** Admin-only fallback (/admin): load a pasted proofs file. */
  const loadText = useCallback((text: string) => apply(text, "pasted"), [apply]);

  /** Fetch the published file (AUTO_PROOFS_URL), following one `{ "current": … }` pointer. Not exposed: no arbitrary URLs. */
  const loadPublished = useCallback(
    async (url: string, opts: { quietIfMissing?: boolean } = {}) => {
      setLoading(true);
      setError(null);
      try {
        let target = url;
        for (let hop = 0; hop < 2; hop++) {
          const res = await fetch(target, { cache: "no-store" });
          if (!res.ok) {
            if (opts.quietIfMissing && res.status === 404) return setLoading(false);
            throw new UserFacingError("network", `Couldn't download the proofs file (HTTP ${res.status}).`);
          }
          const text = await res.text();
          let pointer: { current?: unknown } | null = null;
          try {
            const j = JSON.parse(text) as { current?: unknown; claims?: unknown };
            if (j && typeof j === "object" && "current" in j && !("claims" in j)) pointer = j;
          } catch {
            /* not JSON: loadText reports it */
          }
          if (!pointer) return await apply(text, "published");
          if (typeof pointer.current !== "string" || !pointer.current) return setLoading(false); // "no airdrop published"
          target = new URL(pointer.current, new URL(target, window.location.href)).toString();
        }
        throw new UserFacingError("unknown", "The published airdrop pointer doesn't lead to a proofs file.");
      } catch (e) {
        setError(e);
        setLoading(false);
      }
    },
    [apply]
  );

  useEffect(() => {
    void loadPublished(AUTO_PROOFS_URL, { quietIfMissing: !ENV_PROOFS_URL });
  }, [loadPublished]);

  const reload = useCallback(async () => {
    if (file && source) await apply(JSON.stringify(file), source);
  }, [file, source, apply]);

  return { file, dist, source, loading, error, loadText, reload };
}
