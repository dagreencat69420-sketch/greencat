"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { buildSetStakingEnabledIx } from "@greencat/sdk";
import { useSendTx } from "@/lib/useSendTx";
import { friendlyError, UserFacingError } from "@/lib/errors";
import { useToast } from "@/components/Toaster";
import { useProgram } from "@/context/ProgramContext";
import { btn, ErrorNotice, Notice, Panel, Stat, SuccessNotice } from "@/components/ui";

/**
 * Admin: the on-chain staking switch (`set_staking_enabled`, authority only).
 * Locked = new stakes (daily + 365-day) are refused by the program; unstake and claim always keep working.
 * Mainnet starts Locked and is opened after the launch airdrop round is reclaimed (docs/MAINNET-LAUNCH-CHECKLIST.md).
 * Two steps: press "Open staking" / "Lock staking", read the confirm box, then "Confirm" (one wallet prompt).
 */
export function StakingSwitchPanel() {
  const { publicKey, connected } = useWallet();
  const p = useProgram();
  const send = useSendTx();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState<{ title: string; sig: string } | null>(null);
  const { config } = p;
  if (!config) return null;

  const open = config.stakingEnabled;
  const target = !open; // what the button does
  const can = p.isAdmin && !busy;

  const onConfirm = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    let sent = false;
    try {
      if (!publicKey) throw new UserFacingError("not_connected", "Connect the admin wallet first.");
      const title = target ? "Staking: Open. Holders can stake (daily + 365-day)." : "Staking: Locked. New stakes are refused; unstake and claim still work.";
      const ix = buildSetStakingEnabledIx({ authority: publicKey, enabled: target });
      sent = true;
      const sig = await send([ix], { preflight: true, toast: title });
      setOk({ title, sig });
      setConfirming(false);
    } catch (e) {
      const fe = friendlyError(e);
      if (!sent) toast({ tone: "error", title: fe.message, body: fe.hint ?? fe.detail });
      if (fe.kind !== "rejected") setErr(e);
    } finally {
      setBusy(false);
      await p.refresh();
    }
  };

  return (
    <Panel title={`Staking: ${open ? "Open" : "Locked"}`} subtitle="On-chain switch for NEW stakes (daily and 365-day). Unstake and claim of existing positions always work.">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Staking" value={open ? "Open" : "Locked"} tone={open ? "neon" : "white"} />
          <Stat label="Unstake / claim" value="Always on" tone="white" />
        </div>
        {!config.stakingFlagSet && (
          <p className="text-xs text-gc-mute">This Config predates the switch, so staking reads as Open until the switch is first set.</p>
        )}
        {connected && !p.isAdmin && <Notice>Read-only: this wallet isn&apos;t the program authority.</Notice>}

        {!confirming ? (
          <button type="button" className={target ? btn.primary : btn.warn} disabled={!can} onClick={() => setConfirming(true)}>
            {target ? "Open staking" : "Lock staking"}
          </button>
        ) : (
          <Notice tone="warn" title={target ? "Open staking for everyone?" : "Lock staking?"}>
            <span className="block">
              {target
                ? "Holders will be able to stake $GC (daily and 365-day) right away. On mainnet, only do this after the launch airdrop round is reclaimed."
                : "New stakes (daily, add-to-daily and 365-day) will be refused until you open it again. Existing positions can still unstake and claim."}
            </span>
            <span className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={target ? btn.primary : btn.warn} disabled={!can} onClick={() => void onConfirm()}>
                {busy ? "Confirm in your wallet…" : target ? "Confirm: open staking" : "Confirm: lock staking"}
              </button>
              <button type="button" className={btn.small} disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          </Notice>
        )}

        {ok && <SuccessNotice title={ok.title} sig={ok.sig} />}
        {err ? <ErrorNotice error={err} onDismiss={() => setErr(null)} /> : null}
      </div>
    </Panel>
  );
}
