import type { BadgeProps } from "@shopify/polaris";
import type { BadgeTone } from "../../../lib/order-utils";

// Maps the route-local BadgeTone vocabulary (shared with the s-* table cells)
// onto Polaris React Badge tones. "neutral" renders the default gray badge.
export function polarisBadgeTone(tone: BadgeTone): BadgeProps["tone"] {
  switch (tone) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "critical":
      return "critical";
    case "info":
      return "info";
    case "caution":
      return "attention";
    default:
      return undefined;
  }
}
