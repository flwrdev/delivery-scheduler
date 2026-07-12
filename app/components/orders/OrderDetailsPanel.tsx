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
import { polarisBadgeTone } from "./panel/badge-tone";
import { DeliverySection } from "./panel/DeliverySection";
import { DeliveryTimeline } from "./panel/DeliveryTimeline";
import { ItemsSection } from "./panel/ItemsSection";

export interface OrderDetailsPanelProps {
  order: Order;
  onClose: () => void;
  // §6: the order dropped out of the loaded result set after a background
  // revalidate — the panel is showing its last-known snapshot.
  notInView?: boolean;
  // Phase 4: opens the merchant "Update delivery slot" modal for this order.
  onReschedule?: () => void;
}

/**
 * Read-only, right-docked order details panel (Polaris React). Replaces
 * OrderDrawer. The open order is URL-driven (?order=) — this component only
 * renders; open/close state lives in the route. Its single write is the
 * existing freeform tagsAdd op on the route action (same as the old drawer).
 */
export function OrderDetailsPanel({
  order,
  onClose,
  notInView = false,
  onReschedule,
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
      if (e.key === "Escape") onClose();
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
  }, [onClose]);

  useEffect(() => {
    if (tagFetcher.state === "idle" && tagFetcher.data?.ok) {
      setTagInput("");
    }
  }, [tagFetcher.state, tagFetcher.data]);

  const adminUrl = `shopify://admin/orders/${orderId}`;
  const statusPageUrl = order.statusPageUrl ?? null;
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
      content: "Send email",
      disabled: !customerEmail,
      // S8/S9: mailto can't be a plain link here. Targetless = same-frame
      // iframe navigation (App Bridge forbids it — "This content is
      // blocked"); external/_blank = Chrome parks a blank "Untitled" tab and
      // the mail handler may never launch. Polaris ActionList also ignores
      // the item `target` prop, so the _top navigation App Bridge sanctions
      // for external URLs has to be triggered manually inside the click
      // gesture. mailto never commits a navigation, so the admin stays put.
      onAction: () => {
        setActionsOpen(false);
        if (!customerEmail) return;
        const link = document.createElement("a");
        link.href = `mailto:${customerEmail}`;
        link.target = "_top";
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
      },
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
              This order is no longer in the current view — showing its last
              loaded details.
            </Text>
          )}
          <DeliverySection order={order} />

          <Divider />
          <DeliveryTimeline order={order} />
          {/* DeliveryTimeline renders null (and the divider above still
              separates Delivery from Items) when there is no reschedule
              signal — no duplicate divider needed. */}

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
                    maxLength={255}
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
        </div>
      </div>
    </>
  );
}
