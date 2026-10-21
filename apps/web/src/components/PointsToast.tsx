"use client";

import { useEffect } from "react";
import { usePoints } from "@/context/PointsContext";
import { useToast } from "@/components/Toaster";

/** Bridges engagement point awards into the shared toast stack. */
export function PointsToast() {
  const { pointsToast, clearPointsToast, ready } = usePoints();
  const { toast } = useToast();

  useEffect(() => {
    if (!ready || !pointsToast) return;
    toast({ tone: "points", title: pointsToast });
    clearPointsToast();
  }, [ready, pointsToast, clearPointsToast, toast]);

  return null;
}
