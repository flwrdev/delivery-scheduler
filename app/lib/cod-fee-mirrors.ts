// Namespace/key must match the [[extensions.metafields]] declaration in BOTH
// thank-you extensions — that is how the storefront reads it.
export const COD_FEE_METAFIELD_NAMESPACE = "$app:cod";
export const COD_FEE_METAFIELD_KEY = "fee";

// The SAME fee, mirrored a second time under a plain (non app-reserved)
// namespace so LIQUID can read it — `$app:cod` resolves to `app--<id>--cod`,
// which only this app can see, and Liquid is not this app.
//
// This copy exists for the Order confirmation NOTIFICATION, which today
// hardcodes "+ ₱70.00" and adds 70 into its own subtotal/total. It cannot read
// the fee off the order either: Shopify sends that email seconds BEFORE the
// orders/create webhook adds the COD Fee line (prod #4097 — email 20:48:59,
// line item 20:49:04), so at render time the order does not have the fee yet.
// A shop metafield is the only value that is correct at that instant.
export const COD_FEE_LIQUID_NAMESPACE = "custom";
export const COD_FEE_LIQUID_KEY = "cod_fee";

// Releasit's OWN copy of the fee, in centavos. Not ours, deliberately written.
//
// The order confirmation email's COD block is Releasit's — its Liquid draws the
// `COD Fee ₱70` row and resolves the `{order_total}` placeholder in the
// merchant's message from THIS metafield, not from the order. The arithmetic is
// right and the number is wrong: at send time the order is still pre-edit
// (₱1,226 on #4097), Releasit adds its own `commission`, and ₱70 gave ₱1,296
// when the customer owed ₱1,311. Feed it the real fee and both the row and the
// total come out correct with no template edit at all.
//
// Releasit's fee ENGINE stays off (`_cod_fee.other_settings.isFeeEnabled`
// false) — turning it on would charge the fee a second time. This writes only
// the display amount.
//
// Last writer wins: saving inside the Releasit app overwrites this. Re-saving
// /app/cod-settings puts it back.
export const RELEASIT_FEE_NAMESPACE = "_cod_fee";
export const RELEASIT_FEE_KEY = "commission";

/** Releasit stores the fee as an integer number of centavos ("7000" = ₱70). */
export function toReleasitCentavos(feeAmount: number): string {
  return String(Math.round(feeAmount * 100));
}
