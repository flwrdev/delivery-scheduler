-- Storefront chat widget merchant settings (2026-08-23): lets the merchant
-- edit greeting/bubble color/support phone/starter-chip copy from the app's
-- Messenger admin page instead of the Theme Editor. Null column = built-in
-- default (see WIDGET_CONFIG_DEFAULTS in widget-config.server.ts) -- same
-- "null = default" convention as ReminderConfig's email templates.
CREATE TABLE "WidgetConfig" (
    "shop" TEXT NOT NULL,
    "greeting" TEXT,
    "bubbleColor" TEXT,
    "supportPhone" TEXT,
    "trackLabel" TEXT,
    "chip2Label" TEXT,
    "chip2Message" TEXT,
    "chip3Label" TEXT,
    "chip3Message" TEXT,
    "chip4Label" TEXT,
    "chip4Message" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WidgetConfig_pkey" PRIMARY KEY ("shop")
);
