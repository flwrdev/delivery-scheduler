// COD fee notice — RETIRED block (2026-07-31).
//
// The COD fee display now lives inside the merged Delivery Schedule card
// (extensions/delivery-thank-you) so the Thank You page shows ONE aligned
// card instead of two blocks on different gutters. This extension renders
// nothing so the still-placed block can't double-display the fee; once the
// merchant removes the block in the checkout editor (Settings → Checkout →
// Customize → Thank you page), this extension can be deleted outright.

import '@shopify/ui-extensions/preact';

export default async () => {};
