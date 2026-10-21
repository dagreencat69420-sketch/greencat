# Owned-NFT stats (profile)

Added Oct 12, 2026. On `/profile` each revealed cat is a button: hover or keyboard focus shows a tooltip on
devices with a real pointer (`@media (hover: hover)`); click / tap / Enter opens an accessible dialog
(`role="dialog"`, `aria-modal`, focus moves to Close, Tab is trapped, Esc / backdrop closes, focus returns to the tile).
Both use `NftStatsCard`, which the mint reveal now uses too: name, image, rarity tier with share of all cats,
statistical rarity rank (1 = rarest, product of trait frequencies over the 10,000-cat catalog), every trait with its
share, and the catchphrase. Data comes from the token's metadata JSON (on-chain collection base URI, ipfs:// rewritten
to the 4EVERLAND subdomain gateway), cached in memory + sessionStorage; if it fails or takes more than 8 s, the stats
come from the bundled art catalog and the card says so.

Screenshots (local build, read-only mock wallet BVtgz… on Devnet):
- `desktop-hover-tooltip.png`, `desktop-dialog-keyboard.png`, `desktop-profile-grid.png`
- `mobile-profile-grid.png`, `mobile-tap-dialog.png` (390×844)
- `desktop-metadata-fallback.png` (4EVERLAND blocked → catalog fallback note)

### Mobile fit fix (Oct 12, 2026)
The dialog is portalled to `<body>` (an ancestor transform had been offsetting it): it's a full-width bottom sheet on phones
and a centred modal from `sm`, max-height 90dvh, with a fixed header (Close is always visible) and a scrolling body that has
safe-area padding. The image shrinks on small or short screens and long names/trait values wrap. The desktop tooltip is
also portalled with `position: fixed`; it's placed below the tile, flips above when there's no room, and is clamped 8px
inside the viewport (`src/lib/tooltipPlacement.ts`, unit tested).
Checked at 360×640, 390×844, 430×932 and landscape 640×360 / 844×390, each with normal and long (14-trait, long-value) metadata:
`mobile-tap-dialog-fixed-*.png`; desktop edge tooltip: `desktop-tooltip-fixed-bottom-edge.png`.
