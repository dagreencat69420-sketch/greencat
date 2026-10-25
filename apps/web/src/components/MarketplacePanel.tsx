"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildBuyNftIx,
  buildCancelListingIx,
  buildListNftIx,
  decodeListingAccount,
  decodeNftRecordAccount,
  deriveListingPda,
  deriveNftRecordPda,
  listingFilters,
  marketplaceFee,
  RARITY_COLORS,
  RARITY_LABELS,
  rarityFromU8,
  rawToUi,
  sellerNetAfterFee,
  uiToRaw,
  type DecodedListing,
  type DecodedNftRecord,
} from "@greencat/sdk";
import { CLUSTER, GC_DECIMALS } from "@/lib/config";
import { formatGc } from "@/lib/balances";
import { useSendTx } from "@/lib/useSendTx";
import { UserFacingError } from "@/lib/errors";
import { API_URL, publicApi } from "@/lib/api";
import { nftLabel, useMyNfts } from "@/lib/nfts";
import { shortKey } from "@/lib/explorer";
import { usePoints } from "@/context/PointsContext";
import { useProgram } from "@/context/ProgramContext";
import { MarketplaceBrowse } from "@/components/MarketplaceBrowse";
import { NftImage } from "@/components/NftArt";
import { WalletNotice } from "@/components/WalletNotice";
import { btn, EmptyState, ErrorNotice, field, labelCls, Notice, Panel, Skeleton, SuccessNotice, LaunchingSoon } from "@/components/ui";

type Row = DecodedListing & { record: DecodedNftRecord | null };

function cardTitle(r: Row) {
  return r.record?.revealed && r.record.tokenId > 0 ? `GreenCat #${r.record.tokenId}` : r.record ? `Mint #${r.record.mintIndex + 1}` : shortKey(r.nftMint);
}

export function MarketplacePanel() {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const { awardBonus } = usePoints();
  const p = useProgram();
  const send = useSendTx();
  const { nfts, loading: nftsLoading, refresh: refreshNfts } = useMyNfts();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [rowsErr, setRowsErr] = useState<unknown>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [lookup, setLookup] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState<{ title: string; sig: string } | null>(null);
  const [apiMatchesProgram, setApiMatchesProgram] = useState(false);

  useEffect(() => {
    if (!publicApi) {
      setApiMatchesProgram(false);
      return;
    }
    publicApi
      .health()
      .then((h) => setApiMatchesProgram(Boolean(h?.ok && h.programId === p.programId.toBase58())))
      .catch(() => setApiMatchesProgram(false));
  }, [p.programId]);

  const withRecords = useCallback(
    async (ls: DecodedListing[]): Promise<Row[]> => {
      const recs = ls.length ? await connection.getMultipleAccountsInfo(ls.map((l) => deriveNftRecordPda(new PublicKey(l.nftMint))[0]), "confirmed") : [];
      return ls.map((l, i) => ({ ...l, record: recs[i] ? decodeNftRecordAccount(Buffer.from(recs[i]!.data)) : null }));
    },
    [connection]
  );

  /** On-chain browse (no API): every active Listing account, cheapest first. */
  const loadRows = useCallback(async () => {
    try {
      const accts = await connection.getProgramAccounts(p.programId, { commitment: "confirmed", filters: listingFilters() });
      const ls = accts.map((a) => decodeListingAccount(Buffer.from(a.account.data))).filter((l): l is DecodedListing => !!l && l.active);
      ls.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
      setRows(await withRecords(ls));
      setRowsErr(null);
    } catch (e) {
      setRowsErr(e);
    }
  }, [connection, p.programId, withRecords]);

  useEffect(() => {
    if (p.status === "ready") void loadRows();
  }, [loadRows, p.status]);

  const selectMint = async (mint: string) => {
    setErr(null);
    try {
      const m = new PublicKey(mint.trim());
      const info = await connection.getAccountInfo(deriveListingPda(m, p.programId)[0], "confirmed");
      const l = info ? decodeListingAccount(Buffer.from(info.data)) : null;
      if (!l || !l.active) throw new UserFacingError("unknown", "That NFT isn't listed right now.");
      setSelected((await withRecords([l]))[0]);
    } catch (e) {
      setErr(e instanceof Error && e.message.includes("Invalid public key") ? new UserFacingError("unknown", "That isn't a valid mint address.") : e);
    }
  };

  const myListings = useMemo(() => (rows && publicKey ? rows.filter((r) => r.seller === publicKey.toBase58()) : []), [rows, publicKey]);
  const unlisted = nfts ?? [];

  const act = async (label: string, title: string, f: () => Promise<string>) => {
    setBusy(label);
    setErr(null);
    setOk(null);
    try {
      const sig = await f();
      setOk({ title, sig });
      await Promise.all([loadRows(), refreshNfts(), p.refreshBalances()]);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const onBuy = (r: Row) =>
    act(`buy:${r.nftMint}`, `You bought ${cardTitle(r)}!`, async () => {
      if (!publicKey || !p.gcMint) throw new UserFacingError("not_connected", "Connect your wallet first.");
      const price = rawToUi(r.price, GC_DECIMALS);
      if (p.gc !== null && p.gc < price) throw new UserFacingError("insufficient_gc", `This costs ${formatGc(price)} $GC; you have ${formatGc(p.gc)}.`);
      const nftMint = new PublicKey(r.nftMint);
      const seller = new PublicKey(r.seller);
      const sig = await send(
        [
          buildBuyNftIx({
            buyer: publicKey,
            seller,
            nftMint,
            gcMint: p.gcMint,
            buyerGcAta: getAssociatedTokenAddressSync(p.gcMint, publicKey, false, p.tokenProgram),
            sellerGcAta: getAssociatedTokenAddressSync(p.gcMint, seller, false, p.tokenProgram),
            buyerNftAta: getAssociatedTokenAddressSync(nftMint, publicKey, false, TOKEN_PROGRAM_ID),
            // audit GC-21: reverts if the seller changes the price after you saw it
            expectedPriceRaw: r.price,
            tokenProgramId: p.tokenProgram,
            programId: p.programId,
          }),
        ],
        { cu: 400_000, minSol: 0.01 }
      );
      setSelected(null);
      return sig;
    });

  const onList = (mint: string, label: string) =>
    act(`list:${mint}`, `${label} listed`, async () => {
      if (!publicKey) throw new UserFacingError("not_connected", "Connect your wallet first.");
      let priceRaw = 0n;
      try {
        priceRaw = uiToRaw(prices[mint] || "0", GC_DECIMALS);
      } catch {
        /* invalid */
      }
      if (priceRaw <= 0n) throw new UserFacingError("unknown", "Enter a price greater than zero.");
      const nftMint = new PublicKey(mint);
      const sig = await send(
        [buildListNftIx({ seller: publicKey, nftMint, sellerNftAta: getAssociatedTokenAddressSync(nftMint, publicKey, false, TOKEN_PROGRAM_ID), priceRaw, programId: p.programId })],
        { minSol: 0.005 }
      );
      void awardBonus("list", sig);
      return sig;
    });

  const onCancel = (r: Row) =>
    act(`cancel:${r.nftMint}`, "Listing cancelled. The NFT is back in your wallet.", async () => {
      if (!publicKey) throw new UserFacingError("not_connected", "Connect your wallet first.");
      const nftMint = new PublicKey(r.nftMint);
      return send([buildCancelListingIx({ seller: publicKey, nftMint, sellerNftAta: getAssociatedTokenAddressSync(nftMint, publicKey, false, TOKEN_PROGRAM_ID), programId: p.programId })], {
        minSol: 0.003,
      });
    });

  if (p.status === "error" && !API_URL) {
    return (
      <Panel title="Marketplace">
        <ErrorNotice error={p.error} onRetry={() => void p.refresh()} />
      </Panel>
    );
  }
  if (p.status === "not_deployed" || p.status === "not_initialized") {
    return (
      <Panel title="Marketplace">
        <LaunchingSoon feature="The marketplace" icon="🛒">
          <p>Buy and sell GreenCats for $GC with non-custodial escrow (1% fee) once the program is live on {CLUSTER}.</p>
        </LaunchingSoon>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <Panel title="Browse" subtitle="Buy and sell with $GC · 1% marketplace fee">
        {API_URL && apiMatchesProgram ? (
          <MarketplaceBrowse onSelect={(mint) => void selectMint(mint)} />
        ) : rowsErr ? (
          <ErrorNotice error={rowsErr} onRetry={() => void loadRows()} />
        ) : rows === null || p.status === "loading" ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" role="status">
            <span className="sr-only">Loading listings…</span>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="aspect-[3/4]" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon="🛒" title="No cats for sale yet">
            Be the first: list one of yours below.
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {rows.map((r) => {
              const rarity = r.record?.revealed ? rarityFromU8(r.record.rarity) : undefined;
              return (
                <li key={r.nftMint}>
                  <button
                    type="button"
                    onClick={() => setSelected(r)}
                    className="flex h-full w-full flex-col rounded-xl border border-gc-border bg-black/30 p-2 text-left transition hover:border-gc-lime/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon motion-reduce:transition-none"
                    aria-label={`${cardTitle(r)}, ${formatGc(rawToUi(r.price, GC_DECIMALS))} GC. View listing`}
                  >
                    <NftImage tokenId={r.record?.revealed ? r.record.tokenId : 0} rarity={rarity} />
                    <span className="mt-2 truncate text-sm font-semibold text-white">{cardTitle(r)}</span>
                    {rarity ? (
                      <span className="text-[11px] uppercase" style={{ color: RARITY_COLORS[rarity] }}>
                        {RARITY_LABELS[rarity]}
                      </span>
                    ) : (
                      <span className="text-[11px] uppercase text-gc-mute">Unrevealed</span>
                    )}
                    <span className="mt-1 text-sm font-black text-gc-neon">{formatGc(rawToUi(r.price, GC_DECIMALS))} $GC</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <form
          className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (lookup.trim()) void selectMint(lookup);
          }}
        >
          <div className="flex-1">
            <label htmlFor="lookup" className={labelCls}>
              Find a listing by NFT mint
            </label>
            <input id="lookup" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="NFT mint address" className={`${field} mt-1 font-mono text-xs`} />
          </div>
          <button type="submit" className={btn.secondary} disabled={!lookup.trim()}>
            Look up
          </button>
        </form>
      </Panel>

      {selected && (
        <Panel
          title={cardTitle(selected)}
          actions={
            <button type="button" className={btn.small} onClick={() => setSelected(null)} aria-label="Close listing">
              ✕
            </button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-[200px_1fr]">
            <NftImage tokenId={selected.record?.revealed ? selected.record.tokenId : 0} />
            <div className="space-y-3 text-sm">
              <p className="text-3xl font-black text-gc-neon">{formatGc(rawToUi(selected.price, GC_DECIMALS))} $GC</p>
              <p className="text-xs text-gc-mute">
                Seller {shortKey(selected.seller, 6)} receives {formatGc(rawToUi(sellerNetAfterFee(selected.price), GC_DECIMALS))} $GC · fee{" "}
                {formatGc(rawToUi(marketplaceFee(selected.price), GC_DECIMALS))} $GC. If the seller changes the price before you confirm, the purchase fails
                safely.
              </p>
              <WalletNotice action="buy" needGc={rawToUi(selected.price, GC_DECIMALS)} needSol={0.01} />
              {selected.seller === publicKey?.toBase58() ? (
                <Notice>This is your listing.</Notice>
              ) : (
                <button
                  type="button"
                  className={`${btn.primary} w-full sm:w-auto`}
                  disabled={!connected || !!busy || p.paused}
                  onClick={() => void onBuy(selected)}
                >
                  {busy === `buy:${selected.nftMint}` ? "Confirm in your wallet…" : `Buy for ${formatGc(rawToUi(selected.price, GC_DECIMALS))} $GC`}
                </button>
              )}
            </div>
          </div>
        </Panel>
      )}

      {(ok || !!err) && (
        <div className="space-y-2">
          {ok && <SuccessNotice title={ok.title} sig={ok.sig} />}
          {err ? <ErrorNotice error={err} onDismiss={() => setErr(null)} /> : null}
        </div>
      )}

      <Panel title="Sell your cats" subtitle="Listing moves the NFT into a program escrow until it sells or you cancel.">
        {!connected ? (
          <WalletNotice action="list your cats" />
        ) : (
          <div className="space-y-4">
            {myListings.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gc-mute">Your listings</h3>
                <ul className="space-y-2">
                  {myListings.map((r) => (
                    <li key={r.nftMint} className="flex flex-col gap-2 rounded-xl border border-gc-lime/30 bg-gc-lime/5 p-3 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
                      <span className="text-sm">
                        <span className="font-semibold text-white">{cardTitle(r)}</span>{" "}
                        <span className="text-gc-neon">{formatGc(rawToUi(r.price, GC_DECIMALS))} $GC</span>
                      </span>
                      <button type="button" className={btn.small} disabled={!!busy} onClick={() => void onCancel(r)} aria-label={`Cancel listing for ${cardTitle(r)}`}>
                        {busy === `cancel:${r.nftMint}` ? "…" : "Cancel listing"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {nftsLoading && !nfts ? (
              <Skeleton className="h-20" />
            ) : unlisted.length === 0 ? (
              <EmptyState icon="🐾" title="No cats in this wallet">
                Mint one or buy one above.
              </EmptyState>
            ) : (
              <ul className="space-y-2">
                {unlisted.map((n) => {
                  const label = nftLabel(n);
                  let raw = 0n;
                  try {
                    raw = uiToRaw(prices[n.mint] || "0", GC_DECIMALS);
                  } catch {
                    /* invalid */
                  }
                  return (
                    <li key={n.mint} className="rounded-xl border border-gc-border bg-black/30 p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                        <div className="min-w-0 sm:w-40">
                          <p className="font-semibold text-white">{label}</p>
                          <p className="truncate font-mono text-[10px] text-gc-mute">{shortKey(n.mint, 5)}</p>
                        </div>
                        <div className="flex-1">
                          <label htmlFor={`price-${n.mint}`} className={labelCls}>
                            Price ($GC)
                          </label>
                          <input
                            id={`price-${n.mint}`}
                            inputMode="decimal"
                            value={prices[n.mint] ?? ""}
                            placeholder="e.g. 25000"
                            onChange={(e) => setPrices({ ...prices, [n.mint]: e.target.value })}
                            className={`${field} mt-1`}
                          />
                        </div>
                        <button type="button" className={btn.primary} disabled={!!busy || raw <= 0n || p.paused} onClick={() => void onList(n.mint, label)}>
                          {busy === `list:${n.mint}` ? "Confirm in your wallet…" : "List"}
                        </button>
                      </div>
                      {raw > 0n && (
                        <p className="mt-2 text-[11px] text-gc-mute">
                          You receive {formatGc(rawToUi(sellerNetAfterFee(raw), GC_DECIMALS))} $GC after the 1% fee.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
