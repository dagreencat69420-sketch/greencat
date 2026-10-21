/** Below the tile if it fits, else above (flip); horizontally centred then clamped 8px inside the viewport. */
export function placeTooltip(
  a: { left: number; top: number; bottom: number; width: number },
  w: number,
  h: number,
  vw: number,
  vh: number,
  gap = 8,
  margin = 8
): { left: number; top: number; visibility: "visible" } {
  const left = Math.max(margin, Math.min(a.left + a.width / 2 - w / 2, vw - w - margin));
  let top = a.bottom + gap;
  if (top + h > vh - margin) {
    const above = a.top - gap - h;
    top = above >= margin ? above : Math.max(margin, vh - h - margin);
  }
  return { left, top, visibility: "visible" };
}
