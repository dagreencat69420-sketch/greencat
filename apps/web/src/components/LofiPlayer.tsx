"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { POINTS_BONUS } from "@greencat/sdk";
import { usePoints } from "@/context/PointsContext";

const TRACK_SRC = "/music/greencat-lofi-mix.m4a";

/** Sticky lo-fi mini player — awards +1 pt / ~60s (cap 10/day Vancouver). */
export function LofiPlayer() {
  const { wallet, tickLofiSecond, lofiToday, mode, signedIn } = usePoints();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.35);

  const ensure = useCallback(() => {
    if (!audioRef.current) {
      const a = new Audio(TRACK_SRC);
      a.loop = true;
      a.preload = "auto";
      a.volume = volume;
      audioRef.current = a;
    }
    return audioRef.current;
  }, [volume]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!playing || !wallet) return;
    const id = window.setInterval(() => tickLofiSecond(), 1000);
    return () => window.clearInterval(id);
  }, [playing, wallet, tickLofiSecond]);

  const toggle = async () => {
    const a = ensure();
    a.volume = volume;
    if (playing) {
      a.pause();
      setPlaying(false);
      return;
    }
    try {
      await a.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  };

  const earned = lofiToday;

  return (
    <div role="region" aria-label="Lo-fi music player" className="fixed inset-x-0 bottom-0 z-50 border-t border-gc-border bg-gc-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2">
        <button
          type="button"
          onClick={() => void toggle()}
          className="min-h-[40px] shrink-0 rounded-full bg-gc-lime px-3 text-xs font-bold text-black shadow-neonSm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gc-neon focus-visible:ring-offset-2 focus-visible:ring-offset-gc-bg disabled:opacity-40"
          aria-pressed={playing}
          aria-label={playing ? "Pause lo-fi music" : "Play lo-fi music"}
          disabled={!wallet}
          title={!wallet ? "Connect wallet to earn lo-fi points" : undefined}
        >
          {playing ? "⏸ Pause" : "▶ Lo-fi"}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-gc-neon">
            GreenCat Lo-fi Mix
          </p>
          <p className="text-[10px] text-gc-mute">
            +{POINTS_BONUS.lofiPerInterval}/~{POINTS_BONUS.lofiIntervalSec}s ·{" "}
            {earned}/{POINTS_BONUS.lofiDailyCap} today
            {!wallet ? " · connect wallet" : ""}
            {wallet && mode === "api" && !signedIn ? " · sign in on Points to earn" : ""}
          </p>
        </div>
        <label className="hidden items-center gap-1 text-[10px] text-gc-mute min-[400px]:flex">
          Vol
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            aria-label="Volume"
            className="w-16 accent-[#b8ff3c]"
          />
        </label>
      </div>
    </div>
  );
}
