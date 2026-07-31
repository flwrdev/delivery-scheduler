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

## Shipment out for delivery / Shipping update

Same FlowerCart brand treatment, applied to the two fulfilment notifications
(both were close to the Shopify default before — minimal custom styling):

- **`shipment_out_for_delivery.{original,branded}.liquid`** — eyebrow "Out for
  delivery".
- **`shipping_update.{original,branded}.liquid`** — eyebrow "Shipping update".

The `.branded` versions share one generic port: brand `<style>` block (ivory page
+ white card, serif eyebrow/H2/H3, brand button + links, rounded thumbnails, sand
footer band), the card wrapper, an eyebrow before the hero H2, and the footer
band — all via the shared notification classes (no COD logic involved). Roll back
or re-apply the same way: paste the `.original` or `.branded` file into
Settings → Notifications → *(template)* → Edit code → Save.

> Note: Shopify's code editor doesn't mark itself "unsaved" from a programmatic
> paste alone — after pasting, type one character and delete it to enable Save.
