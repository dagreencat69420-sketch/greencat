import { AdminPanel } from "@/components/AdminPanel";
import { TreasuriesPanel } from "@/components/TreasuriesPanel";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Admin", description: "GreenCat program status and authority-only controls.", robots: { index: false } };

export default function AdminPage() {
  return (
    <>
      <PageHeader title="Admin" subtitle="Program status, treasuries, and authority-only controls." />
      <div className="space-y-5">
        <AdminPanel />
        <TreasuriesPanel />
      </div>
    </>
  );
}
