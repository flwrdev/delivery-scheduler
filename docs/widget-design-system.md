# Storefront Chat Widget — Design System

> Part of the docs set. Source of truth for tone: [brand-voice.md](./brand-voice.md).
> This file exists so future widget work (copy, colors, new fields) has a
> saved reference instead of re-deciding the same questions each session —
> per merchant request 2026-08-23.

## Voice & copy (derives from brand-voice.md — do not contradict it)

- **Language:** English-first with **light, occasional** Taglish — brand-voice.md
  §4 explicitly says "natural, not performative." **Resolved 2026-08-23** —
  the merchant asked for the agent's tone to be flexible-Taglish (mirror the
  customer) and for the static widget copy to match brand-voice.md. Rewritten
  to English-first: greeting, disclaimer, starter chips, order-lookup form,
  composer placeholder, banners, and typing indicator (`storefront-chat-widget.js`,
  `widget-config.server.ts` `WIDGET_CONFIG_DEFAULTS`, `app-embed.liquid`'s
  `greeting_text` schema default — all three must stay in sync). Em dashes
  dropped from customer-facing strings per the recommendation below. The live
  LLM agent's own STYLE rule (`agent-prompt.server.ts`) was also strengthened:
  it now mirrors the customer's English/Tagalog ratio turn by turn (not just
  once at the start of the conversation) and defaults to English-first, light
  Taglish before the customer's tone is known (e.g. on a menu tap). A merchant-
  configured `WidgetConfig` row still overrides these defaults, unaffected by
  this pass.
- **Emoji:** brand-voice.md §5 is explicit — "**only 🌸/💐-style**, used
  sparingly — 0–1 per paragraph on-site." **The ❌ emoji on the "Cancel/
  reschedule order" starter chip was flagged as violating this — fixed
  2026-08-23, replaced with 🌸** in all 4 places it was duplicated
  (`storefront-chat-widget.js`'s `chipConfig`, `widget-config.server.ts`'s
  `WIDGET_CONFIG_DEFAULTS`, and `app.messenger-orders.tsx`'s
  `WIDGET_DEFAULTS_FOR_DISPLAY` — a 4th copy found during this pass, used
  only for the admin form's placeholder text). The other three chips
  (🔎🚚💳) are also technically outside the 🌸/💐 rule — narrower reading
  (whole chip label counts as "the paragraph," one emoji each) makes them
  borderline-compliant; widest reading (only floral emoji, period) does not.
  **Still an open call on those three** — not touched this pass, flag to the
  merchant rather than silently picking one reading.
- **Em dash (—):** not addressed by brand-voice.md. **Applied 2026-08-23** as
  part of the tone pass above: customer-facing widget copy avoids em dashes —
  short sentences joined by commas or periods read warmer and more human,
  matching the brand's "warm, human, not corporate" personality (§3); an em
  dash reads more editorial/clinical than the target voice. Em dashes stay
  fine in code comments and internal docs (like this one) — this is about
  customer-facing strings only.

## Color tokens

The widget's CSS custom properties, current default, and whether the
merchant can edit each from the app. **Resolved 2026-08-23** — the merchant
confirmed she wants maximum control from her own app (not the Theme
Editor), so all five went from "fixed" to "editable" in one pass, following
the `FlowerBot Studio` interactive mockup (Artifact) she reviewed first.

| Token | Default | Merchant-editable? |
| --- | --- | --- |
| `--fc-bubble-color` (accent — bubble, header, CTA buttons, chip outlines) | `#9a6a60` | **Yes** — `WidgetConfig.bubbleColor` |
| `--fc-panel-bg` (panel/card background) | `#ffffff` | **Yes** — `WidgetConfig.panelBg` |
| `--fc-text` (main message text) | `#3b3230` | **Yes** — `WidgetConfig.textColor` |
| `--fc-text-muted` (subtext/disclaimer/typing indicator) | `#6d6560` | **Yes** — `WidgetConfig.mutedColor` |
| `--fc-border` (chip/card/composer borders) | `#e9ded9` | **Yes** — `WidgetConfig.borderColor` |
| Thread background (behind message bubbles) | `#faf7f5` | No — fixed (subtle tint, kept off the merchant-facing surface since it rarely needs to change independently of panel background) |

**Independent of the storefront theme, on purpose.** The widget does NOT
read colors from the active Shopify theme's own settings — it has its own
palette (this table), all merchant-editable from the app. This was a
deliberate choice, not an oversight: theme colors can change independently
whenever the merchant redesigns the storefront (Theme Editor), and coupling
the widget to them would mean a theme change silently changes the widget's
look without the merchant asking for that. If full-theme-matching is wanted
later, it would need to be an explicit "match my theme" toggle, not a
default behavior.

## Sizing, layout & behavior tokens (merchant-editable — resolved 2026-08-23)

- Panel size preset (compact / standard / large) — `WidgetConfig.panelSize`
- Corner radius (4–28px) — `WidgetConfig.cornerRadius`
- Bubble position (right / left) — `WidgetConfig.position`. Merchant
  confirmed the DEFAULT should stay **right** — the `FlowerBot Studio` demo
  used "left" only to show the option exists.
- Disclaimer text + visibility toggle — `WidgetConfig.disclaimerText` /
  `showDisclaimer`
- Whether the bubble auto-hides while the panel is open —
  `WidgetConfig.autoHideBubble`, **default false** (both visible at once,
  matching current live behavior) — merchant reviewed both states in the
  mockup and confirmed off-by-default is correct.

**Not yet merchant-editable:** logo (still a static theme asset,
`extensions/storefront-chat-widget/assets/flowercart-logo.png`) — explicitly
deferred per the 2026-08-23 scope decision (file-upload/storage is a bigger,
separate piece of work; this codebase has prior history of removing a
similar upload feature for a different surface due to complexity, so it's
being treated with appropriate caution rather than folded into this pass).

## Structural note for the real admin page (partially applied)

The merchant shared a screenshot of Shopify's own native Inbox "Settings"
page as a reference: instead of one long scrolling form, related settings
are grouped into labeled sections (e.g. "Inbox settings," "Customer chat
settings"), each rendered as a short list of cards — icon, title, one-line
description, external-link affordance for the ones that route elsewhere.

**Partially done, as of 2026-08-23's audit pass:** the `WidgetConfigCard`
(`app/routes/app.messenger-orders.tsx:652`) is internally split into 4
labeled sub-groups — **Itsura** (Appearance, colors + panel size/position/
corner radius), **Nilalaman** (Content — greeting, phone, disclaimer),
**Starter chips** (the 4 chip label/message pairs), and **Kilos**
(Behavior — auto-hide) — each a `<Text as="h3" variant="headingSm">` label
inside a `BlockStack`, separated by `<Divider />`. This gives the scanning
structure the merchant asked for. **Not yet done:** these are still 4
sub-sections of ONE Polaris `<Card>`, not 4 separate cards each with its own
icon/description/external-link the way Shopify Inbox does it — full
card-per-section split still flagged for a future redesign pass, not acted
on in this doc.

## How to use this doc

Before adding a new widget-copy string or a new color/style knob: check the
tables above first. If the tone/emoji/em-dash question isn't answered here,
default to brand-voice.md's spirit (warm, human, not corporate) and flag the
new decision to the merchant rather than guessing silently — then add the
resolved answer back into this file so it doesn't have to be re-asked.
