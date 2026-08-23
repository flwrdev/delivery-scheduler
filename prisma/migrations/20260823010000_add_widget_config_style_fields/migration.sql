-- Storefront chat widget colors/layout/behavior (2026-08-23 addendum):
-- merchant asked for deeper customization than greeting/bubble-color/chips
-- alone -- panel background, text/muted/border colors, size preset, corner
-- radius, position, disclaimer text+toggle, and whether the bubble
-- auto-hides while the panel is open. Null column = built-in default, same
-- convention as the rest of WidgetConfig.
ALTER TABLE "WidgetConfig"
  ADD COLUMN "panelBg" TEXT,
  ADD COLUMN "textColor" TEXT,
  ADD COLUMN "mutedColor" TEXT,
  ADD COLUMN "borderColor" TEXT,
  ADD COLUMN "panelSize" TEXT,
  ADD COLUMN "cornerRadius" INTEGER,
  ADD COLUMN "position" TEXT,
  ADD COLUMN "disclaimerText" TEXT,
  ADD COLUMN "showDisclaimer" BOOLEAN,
  ADD COLUMN "autoHideBubble" BOOLEAN;
