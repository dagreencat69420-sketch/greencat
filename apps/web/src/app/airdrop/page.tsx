"use client";

import { AirdropPanel } from "@/components/AirdropPanel";
import { PageHeader } from "@/components/ui";
import { useAirdropProofs } from "@/lib/airdrop";

export default function AirdropPage() {
  const proofs = useAirdropProofs();
  return (
    <>
      <PageHeader title="Airdrop" subtitle="Claim your share of a holder snapshot." />
      <AirdropPanel proofs={proofs} />
    </>
  );
}
