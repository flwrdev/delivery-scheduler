// Side panel with everything about one order: delivery details, items and a timeline, plus the
// actions menu (reschedule, send email, edit details, tags). Opened with the `?order=` URL
// parameter and loaded lazily.

import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import {
  ActionList,
  Badge,
  BlockStack,
  Button,
  Divider,
  InlineStack,
  Popover,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  type Order,
  formatMoney,
  financialStatusTone,
  fulfillmentBadge,
  formatStatusLabel,
  tagDisplayLabel,
  getMeaningfulTags,
  getCustomerName,
  getRescheduleTimelineEvents,
} from "../../lib/order-utils";
import { MAX_ORDER_TAG_LENGTH } from "../../lib/order-tags";
import type { MailboxMessage } from "../../lib/email-replies";
import type { QuickReply } from "../../lib/quick-replies";
import { buildMessengerInboxUrl, getMessengerPsid } from "../../lib/messenger-conversation";
import { polarisBadgeTone } from "./panel/badge-tone";
import { DeliverySection } from "./panel/DeliverySection";
import { DeliveryTimeline } from "./panel/DeliveryTimeline";
import { ItemsSection } from "./panel/ItemsSection";

export interface OrderDetailsPanelProps {
  order: Order;
  /** SHOP-local today (YYYY-MM-DD) from the loader — drives the Today/Overdue chips. */
  todayISO: string;
  onClose: () => void;
  // §6: the order dropped out of the loaded result set after a background
  // revalidate — the panel is showing its last-known snapshot.
  notInView?: boolean;
  // A modal is stacked over the panel — it owns Escape; the panel's own
  // Esc-to-close must stand down or one Esc closes both (and the ?order=
  // param with it, unmounting the modal mid-compose).
  escDisabled?: boolean;
  // Phase 4: opens the merchant "Update delivery slot" modal for this order.
  onReschedule?: () => void;
  // Customer Email: opens the in-app compose modal for this order.
  onSendEmail?: () => void;
  // Edit details: opens the shipping-address edit modal for this order.
  onEditDetails?: () => void;
  /** Opens a mailbox email from the timeline in the View email modal. */
  onViewEmail?: (message: MailboxMessage, quickReplies: QuickReply[]) => void;
  /** Meta Page ID for the "Open Messenger conversation" action; "" hides it. */
  metaPageId?: string;
}

/**
 * Read-only, right-docked order details panel (Polaris React). Replaces
 * OrderDrawer. The open order is URL-driven (?order=) — this component only
 * renders; open/close state lives in the route. Its single write is the
 * existing freeform tagsAdd op on the route action (same as the old drawer).
 */
export function OrderDetailsPanel({
  order,
  todayISO,
  onClose,
  notInView = false,
  escDisabled = false,
  onReschedule,
  onSendEmail,
  onEditDetails,
  onViewEmail,
  metaPageId = "",
}: OrderDetailsPanelProps) {
  const tagFetcher = useFetcher<{
    ok: boolean;
    message?: string;
    summary?: { ok: number; failed: number };
  }>();
  const [tagInput, setTagInput] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const orderId = order.id.split("/").pop() || order.id;
  const customerName = getCustomerName(order);
  const customerEmail =
    order.customer?.defaultEmailAddress?.emailAddress ?? null;
  const total = order.currentTotalPriceSet
    ? formatMoney(
        order.currentTotalPriceSet.shopMoney.amount,
        order.currentTotalPriceSet.shopMoney.currencyCode,
      )
    : "—";
  const meaningfulTags = getMeaningfulTags(order.tags || []);
  const rescheduleCount = getRescheduleTimelineEvents(order).length;
  const placedAt = new Date(order.createdAt);
  const placedLabel = Number.isNaN(placedAt.getTime())
    ? "—"
    : placedAt.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !escDisabled && !e.defaultPrevented) onClose();
    };

    // Lock body scroll while the panel is open; focus it for keyboard users
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [onClose, escDisabled]);

  useEffect(() => {
    if (tagFetcher.state === "idle" && tagFetcher.data?.ok) {
      setTagInput("");
    }
  }, [tagFetcher.state, tagFetcher.data]);

  const adminUrl = `shopify://admin/orders/${orderId}`;
  const statusPageUrl = order.statusPageUrl ?? null;
  const messengerPsid = getMessengerPsid(order);
  const messengerUrl =
    metaPageId && messengerPsid ? buildMessengerInboxUrl(metaPageId, messengerPsid) : null;
  const actionItems = [
    {
      content: "Update delivery slot",
      disabled: !onReschedule,
      onAction: () => {
        setActionsOpen(false);
        onReschedule?.();
      },
    },
    {
      content: "Edit details",
      // Shipping address + receiver phone only. The address is rewritten by
      // an overwrite mutation, so the server re-reads and carries forward the
      // fields this form does not expose — see update-order-contact.server.ts.
      disabled: !onEditDetails,
      onAction: () => {
        setActionsOpen(false);
        onEditDetails?.();
      },
    },
    {
      content: "Send email",
      disabled: !customerEmail || !onSendEmail,
      // In-app compose modal sent server-side through the business mailbox
      // (customer-email-design.md) — replaces the S9 Gmail-compose-tab link.
      // mailto stays off the table: the merchant machine's OS handler chain
      // silently drops it (audit §G).
      onAction: () => {
        setActionsOpen(false);
        onSendEmail?.();
      },
    },
    {
      content: "Lalabook",
      // Shortcut link only — courier dispatch stays in the official Lalamove
      // connector (ADR-1). Opens the Lalamove Place Order page (shop pickup
      // pre-filled); the SPA has no per-order deep-link, so the URL is the
      // same for every order.
      url: "https://web.lalamove.com/",
      external: true,
      onAction: () => setActionsOpen(false),
    },
    {
      content: "View order status page",
      disabled: !statusPageUrl,
      url: statusPageUrl ?? undefined,
      external: true,
      onAction: () => setActionsOpen(false),
    },
    {
      content: "Open in Shopify Admin",
      url: adminUrl,
      onAction: () => setActionsOpen(false),
    },
    {
      content: "Open Messenger conversation",
      // Business Suite inbox deep link; needs the Meta Page ID and the
      // customer's PSID stored on the order by the agent draft endpoint.
      disabled: !messengerUrl,
      url: messengerUrl ?? undefined,
      external: true,
      onAction: () => setActionsOpen(false),
    },
  ];

  return (
    <>
      <div className="odp-backdrop" onClick={onClose} aria-hidden="true" />

      <div
        className="odp-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${order.name} details`}
        ref={panelRef}
        tabIndex={-1}
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="odp-head">
          <BlockStack gap="150">
            <InlineStack align="space-between" blockAlign="start" wrap={false}>
              <InlineStack gap="200" blockAlign="center" wrap>
                <Text as="h2" variant="headingMd">
                  {order.name}
                </Text>
                <Badge
                  tone={polarisBadgeTone(
                    financialStatusTone(order.displayFinancialStatus),
                  )}
                  size="small"
                >
                  {formatStatusLabel(order.displayFinancialStatus)}
                </Badge>
                <Badge
                  tone={polarisBadgeTone(fulfillmentBadge(order).tone)}
                  size="small"
                >
                  {fulfillmentBadge(order).label}
                </Badge>
              </InlineStack>
              <InlineStack gap="150" blockAlign="center" wrap={false}>
                <Popover
                  active={actionsOpen}
                  activator={
                    <Button
                      disclosure
                      size="slim"
                      onClick={() => setActionsOpen((open) => !open)}
                    >
                      Actions
                    </Button>
                  }
                  onClose={() => setActionsOpen(false)}
                >
                  <ActionList actionRole="menuitem" items={actionItems} />
                </Popover>
                <button
                  type="button"
                  className="odp-close"
                  onClick={onClose}
                  aria-label="Close order details"
                >
                  ×
                </button>
              </InlineStack>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              {customerName}
              {order.customer?.numberOfOrders != null &&
                order.customer.numberOfOrders > 0 &&
                ` · ${order.customer.numberOfOrders} orders`}
            </Text>
            <Text as="p" variant="headingLg">
              {total}
            </Text>
          </BlockStack>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div className="odp-body">
          {notInView && (
            <Text as="p" variant="bodySm" tone="subdued">
              This order is no longer in this view. Showing the last loaded
              details.
            </Text>
          )}
          <DeliverySection order={order} todayISO={todayISO} />

          <Divider />
          <ItemsSection order={order} />

          <Divider />

          {/* Order history */}
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Order history
            </Text>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                Placed
              </Text>
              <Text as="p">{placedLabel}</Text>
              {rescheduleCount > 0 && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Rescheduled {rescheduleCount}×
                </Text>
              )}
            </BlockStack>
            <InlineStack gap="300">
              <Button
                variant="plain"
                url={statusPageUrl ?? undefined}
                disabled={!statusPageUrl}
                external
              >
                Order status page
              </Button>
              <Button variant="plain" url={adminUrl}>
                Open in Shopify Admin
              </Button>
            </InlineStack>
          </BlockStack>

          <Divider />

          {/* Tags */}
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">
              Tags
            </Text>
            {meaningfulTags.length === 0 ? (
              <Text as="p" tone="subdued">
                No tags
              </Text>
            ) : (
              <InlineStack gap="150" wrap>
                {meaningfulTags.map((tag) => (
                  <Tag key={tag}>{tagDisplayLabel(tag)}</Tag>
                ))}
              </InlineStack>
            )}
            <tagFetcher.Form
              method="post"
              onSubmit={(e) => {
                if (!tagInput.trim()) {
                  e.preventDefault();
                }
              }}
            >
              <input type="hidden" name="_action" value="tagsAdd" />
              <input type="hidden" name="orderId" value={order.id} />
              <InlineStack gap="150" blockAlign="end" wrap={false}>
                <div style={{ flex: "1 1 auto" }}>
                  <TextField
                    label="Add a tag"
                    labelHidden
                    placeholder="Add a tag…"
                    name="tags"
                    value={tagInput}
                    onChange={setTagInput}
                    disabled={tagFetcher.state !== "idle"}
                    // Shopify's real per-tag cap (live-verified 40; the old
                    // 255 let a long tag pass here and fail at the server).
                    maxLength={MAX_ORDER_TAG_LENGTH}
                    autoComplete="off"
                  />
                </div>
                <Button
                  submit
                  disabled={!tagInput.trim() || tagFetcher.state !== "idle"}
                  loading={tagFetcher.state !== "idle"}
                >
                  Add
                </Button>
              </InlineStack>
            </tagFetcher.Form>
            {tagFetcher.state === "idle" &&
              tagFetcher.data &&
              !tagFetcher.data.ok && (
                <Text as="p" variant="bodySm" tone="critical">
                  {tagFetcher.data.message ?? "Failed to add tag."}
                </Text>
              )}
          </BlockStack>

          {/* Rendered last: its own leading Divider + heading show up only
              when the order actually has reschedule/activity signal. */}
          <DeliveryTimeline order={order} onViewEmail={onViewEmail} />
        </div>
      </div>
    </>
  );
}
