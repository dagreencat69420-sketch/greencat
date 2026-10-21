import { MarketplacePanel } from "@/components/MarketplacePanel";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Marketplace", description: "Buy and sell GreenCats for $GC with non-custodial escrow." };

export default function MarketPage() {
  return (
    <>
      <PageHeader title="Marketplace" subtitle="Buy and sell GreenCats for $GC. Non-custodial escrow, 1% fee." />
      <MarketplacePanel />
    </>
  );
}
