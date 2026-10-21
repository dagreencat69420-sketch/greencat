"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  buildSetVrfExpiryIxChecked,
  formatVrfExpiry,
  parseVrfExpiryInput,
  VRF_EXPIRY_MAX_SECS,
  VRF_EXPIRY_MIN_SECS,
  type VrfExpiryUnit,
} from "@greencat/sdk";
import { useSendTx } from "@/lib/useSendTx";
import { friendlyError, UserFacingError } from "@/lib/errors";
import { useToast } from "@/components/Toaster";
import { useProgram } from "@/context/ProgramContext";
import { btn, ErrorNotice, field, labelCls, Notice, Panel, Stat, SuccessNotice } from "@/components/ui";

const PRESETS: { label: string; secs: number }[] = [
  { label: "1 h", secs: 3_600 },
  { label: "24 h", secs: 86_400 },
];

/**
 * Admin: change `Config.vrf_expiry_secs` (`set_vrf_expiry`, authority only, 1 h … 7 days in every real build).
 * Signed with the connected admin wallet through the same `useSendTx` → wallet-adapter `sendTransaction`
 * path as the other /admin actions (one prompt; works with MetaMask's Solana support, Phantom, Solflare).
 */
export function VrfExpiryPanel() {
  const { publicKey, connected } = useWallet();
  const p = useProgram();
  const send = useSendTx();
  const { toast } = useToast();
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<VrfExpiryUnit>("minutes");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState<{ title: string; sig: string } | null>(null);
  const { config } = p;
  if (!config) return null;

  const current = Number(config.vrfExpirySecs);
  const parsed = value.trim() ? parseVrfExpiryInput(value, unit) : null;
  const unchanged = parsed?.ok === true && parsed.secs === current;
  const can = p.isAdmin && !busy && parsed?.ok === true && !unchanged;

  const switchUnit = (u: VrfExpiryUnit) => {
    // keep the same duration when flipping units, if it converts to a whole number
    if (parsed?.ok && u !== unit) setValue(u === "minutes" ? (parsed.secs % 60 === 0 ? String(parsed.secs / 60) : value) : String(parsed.secs));
    setUnit(u);
  };

  const onSubmit = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    let sent = false; // once the tx reaches useSendTx, it shows the success / error toast itself
    try {
      if (!publicKey) throw new UserFacingError("not_connected", "Connect the admin wallet first.");
      const r = parseVrfExpiryInput(value, unit);
      if (!r.ok) throw new UserFacingError("unknown", r.error);
      const title = `VRF expiry set to ${formatVrfExpiry(r.secs)} (${r.secs.toLocaleString("en-US")} s)`;
      const ix = buildSetVrfExpiryIxChecked({ authority: publicKey, expirySecs: r.secs });
      sent = true;
      const sig = await send([ix], { preflight: true, toast: title });
      setOk({ title, sig });
      setValue("");
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
    <Panel
      title="VRF expiry"
      subtitle="How long an ORAO randomness request may stay unanswered before a mint reveal can be re-requested."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Current" value={formatVrfExpiry(current)} tone="neon" />
          <Stat label="In seconds" value={current.toLocaleString("en-US")} tone="white" />
          <Stat label="Allowed" value={`${formatVrfExpiry(VRF_EXPIRY_MIN_SECS)} – ${formatVrfExpiry(VRF_EXPIRY_MAX_SECS)}`} tone="white" />
        </div>

        {connected && !p.isAdmin && <Notice>Read-only: this wallet isn&apos;t the program authority.</Notice>}

        <div className="space-y-2">
          <label htmlFor="vrf-expiry" className={labelCls}>
            New VRF expiry
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="vrf-expiry"
              inputMode="numeric"
              placeholder={unit === "minutes" ? "e.g. 60" : "e.g. 3600"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={parsed?.ok === false}
              aria-describedby="vrf-expiry-help"
              className={`${field} max-w-[12rem]`}
            />
            <div role="radiogroup" aria-label="Unit" className="flex gap-1">
              {(["minutes", "seconds"] as const).map((u) => (
                <button key={u} type="button" role="radio" aria-checked={unit === u} className={unit === u ? btn.primary : btn.small} onClick={() => switchUnit(u)}>
                  {u}
                </button>
              ))}
            </div>
            {PRESETS.map((pr) => (
              <button
                key={pr.secs}
                type="button"
                className={btn.small}
                onClick={() => {
                  setUnit("seconds");
                  setValue(String(pr.secs));
                }}
              >
                {pr.label}
              </button>
            ))}
          </div>
          <p id="vrf-expiry-help" className={`text-xs ${parsed?.ok === false ? "text-red-200" : "text-gc-mute"}`} aria-live="polite">
            {parsed?.ok === false
              ? parsed.error
              : parsed?.ok
                ? unchanged
                  ? `That's already the current value (${formatVrfExpiry(current)}).`
                  : `Will set ${formatVrfExpiry(parsed.secs)} = ${parsed.secs.toLocaleString("en-US")} seconds.`
                : `Enter ${unit === "minutes" ? "60–10080 minutes" : "3,600–604,800 seconds"}.`}
          </p>
          <button type="button" className={btn.primary} disabled={!can} onClick={() => void onSubmit()}>
            {busy ? "Confirm in your wallet…" : "Set VRF expiry"}
          </button>
        </div>

        {ok && <SuccessNotice title={ok.title} sig={ok.sig} />}
        {err ? <ErrorNotice error={err} onDismiss={() => setErr(null)} /> : null}
      </div>
    </Panel>
  );
}
