# Notification email templates (reference backups)

These are **backups** of the merchant's Shopify **notification** email templates
(Settings → Notifications → Customer notifications). They are NOT loaded by the
app or theme at runtime — Shopify hosts the live copy. They live here only so a
production email change is version-controlled and reversible.

## Order confirmation

- **`order_confirmation.original.liquid`** — the template as it was before the
  2026-07-31 brand redesign (already contained the Releasit COD-fee Liquid block
  + an earlier hand-styling pass).
- **`order_confirmation.branded.liquid`** — the current **live** template:
  redesigned to FlowerCart's design system (`live-theme-clean/assets/design-system.css`),
  mobile-first. Ivory page + white card, Ivy-Presto/Georgia serif headings, deep-cocoa
  text, brand `#9a6a60` button + links, cream/sand accents, plain-text delivery
  details, and a sand footer band. The redundant COD custom-message box is
  suppressed (the COD fee + adjusted total already appear in the order summary);
  all Releasit COD fee line-item + subtotal/total math is left intact.

### To roll back
Paste `order_confirmation.original.liquid` into
Settings → Notifications → Order confirmation → **Edit code**, then Save.

### To re-apply / re-edit the branded version
Edit `order_confirmation.branded.liquid`, then paste it into the same editor and
Save. Keep the `_cod_fee` Liquid block untouched unless you also intend to change
the COD fee behavior.
