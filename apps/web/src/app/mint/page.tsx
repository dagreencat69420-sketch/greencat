import { MintPanel } from "@/components/MintPanel";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Mint", description: "Mint a GreenCat with $GC. Your cat's art and rarity are revealed seconds after you mint." };

export default function MintPage() {
  return (
    <>
      <PageHeader title="Mint + reveal" subtitle="Mint a GreenCat with $GC. Your cat's art and rarity are revealed seconds after you mint." />
      <MintPanel />
    </>
  );
}
