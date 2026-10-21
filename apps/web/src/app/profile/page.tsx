"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { rarityFromU8 } from "@greencat/sdk";
import { usePoints } from "@/context/PointsContext";
import { useProgram } from "@/context/ProgramContext";
import { useMyNfts, nftLabel } from "@/lib/nfts";
import { WalletPanel } from "@/components/WalletPanel";
import { WalletNotice } from "@/components/WalletNotice";
import { OwnedNftTile } from "@/components/NftStats";
import { btn, EmptyState, ErrorNotice, PageHeader, Panel, PanelSkeleton, Skeleton, Stat } from "@/components/ui";

export default function ProfilePage() {
  const { connected, publicKey } = useWallet();

  if (!connected || !publicKey) {
    return (
      <>
        <PageHeader title="Profile" subtitle="Your balances, points, streak and cats in one place." />
        <div className="space-y-5">
          <WalletNotice action="see your profile" />
          <EmptyState icon="👤" title="No wallet connected">
            Your profile is built from your wallet, so there&apos;s nothing to sign up for. Connect to see your stats.
          </EmptyState>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Profile" subtitle="Your balances, points, streak and cats in one place." />
      <div className="space-y-5">
        <div className="grid gap-5 md:grid-cols-2">
          <WalletPanel />
          <PointsCard />
        </div>
        <MyCats />
      </div>
    </>
  );
}

function PointsCard() {
  const { ready, myPoints, myStreak, myRankRow, totalRanked, claimedPointsToday, mode } = usePoints();
  return (
    <Panel
      title="Points"
      subtitle={mode === "api" ? "Global monthly board" : "This browser only"}
      actions={
        <Link href="/points" className={btn.small}>
          Open board →
        </Link>
      }
    >
      {!ready ? (
        <div role="status" className="grid grid-cols-2 gap-2">
          <span className="sr-only">Loading points…</span>
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="This month" value={`${myPoints.toLocaleString()} pts`} />
            <Stat label="Streak" value={myStreak > 0 ? `🔥 ${myStreak}d` : "—"} tone="lime" />
          </div>
          <p className="text-sm text-gc-mute">
            {myRankRow ? (
              <>
                Rank <strong className="text-gc-lime">#{myRankRow.rank}</strong> of {totalRanked}
              </>
            ) : (
              "Not ranked yet this month."
            )}{" "}
            {claimedPointsToday ? "Daily bonus claimed." : (
              <Link href="/points" className="text-gc-neon underline underline-offset-2">
                Your daily bonus is ready.
              </Link>
            )}
          </p>
        </div>
      )}
    </Panel>
  );
}

function MyCats() {
  const { status, collection } = useProgram();
  const { nfts, loading, error, refresh } = useMyNfts();
  const notLive = status === "not_deployed" || status === "not_initialized";

  return (
    <Panel
      title="Your cats"
      actions={
        !notLive && (
          <button type="button" className={btn.small} onClick={() => void refresh()} disabled={loading} aria-label="Refresh your cats">
            Refresh
          </button>
        )
      }
    >
      {notLive ? (
        <EmptyState icon="🚀" title="Your GreenCats will show up here after launch">
          Minting opens when the GreenCat program goes live. Follow the official channels for the launch call.
        </EmptyState>
      ) : status === "loading" || (loading && nfts === null) ? (
        <PanelSkeleton rows={1} label="Loading your cats" />
      ) : error ? (
        <ErrorNotice error={error} onRetry={() => void refresh()} />
      ) : !nfts || nfts.length === 0 ? (
        <EmptyState
          icon="🐾"
          title="No GreenCats in this wallet yet"
          action={
            <Link href="/mint" className={btn.primary}>
              Mint a GreenCat
            </Link>
          }
        >
          Mint one, or pick one up on the marketplace.
        </EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {nfts.map((n) => (
            <li key={n.mint}>
              <OwnedNftTile
                tokenId={n.record.revealed ? n.record.tokenId : 0}
                rarity={n.record.revealed ? rarityFromU8(n.record.rarity) : undefined}
                label={nftLabel(n)}
                metadataBase={collection?.metadataBaseUri}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
