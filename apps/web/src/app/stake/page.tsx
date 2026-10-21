import { StakePanel } from "@/components/StakePanel";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Stake", description: "Stake $GC for daily accrual or 365-day tranches." };

export default function StakePage() {
  return (
    <>
      <PageHeader title="Stake" subtitle="Daily accrual with a 24 h minimum lock, or 365-day tranches." />
      <StakePanel />
    </>
  );
}
