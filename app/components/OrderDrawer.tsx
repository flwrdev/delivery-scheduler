import { Fragment, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import {
  type Order,
  type CustomAttribute,
  type BadgeTone,
  type RescheduleTimelineEvent,
  toLocalISODate,
  normalizeDateToISO,
  formatDeliveryDate,
  formatMoney,
  financialStatusTone,
  fulfillmentStatusTone,
  isOpenFulfillmentStatus,
  formatStatusLabel,
  tagDisplayLabel,
  getMeaningfulTags,
  getDeliveryRelativeLabel,
  isDeliveryOverdue,
  getDeliveryDateValue,
  getDeliveryTimeValue,
  getCustomerName,
  getOrderPhone,
  getCity,
  getInstructionValue,
  getAttr,
  getFullShippingAddress,
  buildDeliveryInfoText,
  getRescheduleTimelineEvents,
  hasRescheduleTag,
  formatTimelineDelivery,
  formatTimelineTimestamp,
  formatTimelineStatus,
  getLalamoveOrderId,
  getLalamoveStatus,
  getLalamoveShareLink,
  getLalamoveDriverName,
  getLalamoveDriverPhone,
  isLalamoveCOD,
} from "../lib/order-utils";

export type { Order, CustomAttribute };

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  const polarisTone =
    tone === "neutral" ? undefined :
    tone === "caution" ? "warning" :
    tone;
  if (polarisTone) {
    return <s-badge tone={polarisTone}>{label}</s-badge>;
  }
  return <s-badge>{label}</s-badge>;
}

// ─── LalamoveStatusLabel ──────────────────────────────────────────────────────

type LalamoveStatusValue =
  | "ASSIGNING_DRIVER"
  | "ON_GOING"
  | "PICKED_UP"
  | "COMPLETED"
  | "CANCELED"
  | "REJECTED"
  | "EXPIRED";

function LalamoveStatusLabel({ status }: { status: LalamoveStatusValue | null }) {
  if (!status) return null;
  const map: Record<LalamoveStatusValue, { label: string; tone: "warning" | "info" | "success" | "critical"; spinner?: boolean }> = {
    ASSIGNING_DRIVER: { label: "Finding driver…", tone: "warning", spinner: true },
    ON_GOING:         { label: "● On the way",    tone: "info" },
    PICKED_UP:        { label: "● Picked up",     tone: "info" },
    COMPLETED:        { label: "✓ Delivered",     tone: "success" },
    CANCELED:         { label: "✗ Cancelled",     tone: "critical" },
    REJECTED:         { label: "✗ Rejected",      tone: "critical" },
    EXPIRED:          { label: "✗ Expired",       tone: "critical" },
  };
  const { label, tone, spinner } = map[status] ?? { label: status, tone: "info" as const };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {spinner && <span className="ods-spinner--amber" />}
      <span className={`ods-badge ods-badge--${tone}`}>{label}</span>
    </span>
  );
}

// ─── OrderDrawer ──────────────────────────────────────────────────────────────

export interface OrderDrawerProps {
  order: Order;
  onClose: () => void;
  onMarkFulfilled?: () => void;
}

export function OrderDrawer({ order, onClose, onMarkFulfilled }: OrderDrawerProps) {
  const { copied, fieldCopied, copyText, copyField } = useCopyToClipboard();
  const tagFetcher = useFetcher<{ ok: boolean; message?: string; summary?: { ok: number; failed: number } }>();
  const [tagInput, setTagInput] = useState("");

  const orderId = order.id.split("/").pop() || order.id;
  const customerName = getCustomerName(order);
  const phone = getOrderPhone(order);
  const rawDate = getDeliveryDateValue(order);
  const deliveryDate = rawDate !== "—" ? formatDeliveryDate(rawDate) : "—";
  const todayISO = toLocalISODate(new Date());
  const isOpenOrder = isOpenFulfillmentStatus(order.displayFulfillmentStatus);
  const deliveryRelative =
    rawDate !== "—" && isOpenOrder
      ? getDeliveryRelativeLabel(rawDate, todayISO)
      : "";
  const deliveryOverdue =
    rawDate !== "—" && isOpenOrder && isDeliveryOverdue(rawDate, todayISO);
  const timeWindow = getDeliveryTimeValue(order);
  const addr = order.shippingAddress;
  const fullAddress = getFullShippingAddress(order);
  const city = getCity(order);
  const attrs = order.customAttributes || [];
  const originalDeliveryDate = getAttr(attrs, "Delivery Date");
  const originalDeliveryTime = getAttr(attrs, "Delivery Time");
  const rescheduleEvents = getRescheduleTimelineEvents(order);
  const showDeliveryTimeline =
    rescheduleEvents.length > 0 || hasRescheduleTag(order);
  const cardMessage = getAttr(attrs, "Card Message", "card_message");
  const instruction = getInstructionValue(order);
  const items = order.lineItems?.edges || [];
  const total = order.currentTotalPriceSet
    ? formatMoney(
        order.currentTotalPriceSet.shopMoney.amount,
        order.currentTotalPriceSet.shopMoney.currencyCode,
      )
    : "—";
  const email = order.customer?.defaultEmailAddress?.emailAddress || "—";
  const customerId = order.customer?.id?.split("/").pop();
  const billingAddress = order.billingAddress ?? null;
  const showSenderInfo =
    billingAddress != null &&
    billingAddress.address1 != null &&
    billingAddress.address1 !== (order.shippingAddress?.address1 ?? "");
  const shippingAmount = order.totalShippingPriceSet
    ? parseFloat(order.totalShippingPriceSet.shopMoney.amount)
    : 0;
  const totalAmount = order.currentTotalPriceSet
    ? parseFloat(order.currentTotalPriceSet.shopMoney.amount)
    : 0;
  const currencyCode =
    order.currentTotalPriceSet?.shopMoney.currencyCode ||
    order.totalShippingPriceSet?.shopMoney.currencyCode ||
    "USD";
  const subtotalFormatted =
    order.currentTotalPriceSet
      ? formatMoney((totalAmount - shippingAmount).toFixed(2), currencyCode)
      : "—";
  const shippingFormatted =
    order.totalShippingPriceSet
      ? formatMoney(order.totalShippingPriceSet.shopMoney.amount, currencyCode)
      : "—";
  const meaningfulTags = getMeaningfulTags(order.tags || []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    // Lock body scroll while drawer is open
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

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

  // ── Lalamove state ──────────────────────────────────────────────────────
  const lalamoveFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    lalamoveOrderId?: string;
    lalamoveStatus?: string;
    lalamoveShareLink?: string;
    price?: string;
    quotationId?: string;
    expiresAt?: string;
  }>();
  const cancelFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const priorityFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const quoteFetcher = useFetcher<{
    ok: boolean;
    error?: string;
    price?: string;
    quotationId?: string;
    expiresAt?: string;
  }>();

  const [showDispatchModal, setShowDispatchModal] = useState(false);
  const [buyForMe, setBuyForMe] = useState(false);
  const [thermalBag, setThermalBag] = useState(false);
  const [driverNotes, setDriverNotes] = useState("");
  const [priorityFeeInput, setPriorityFeeInput] = useState("");
  const dispatchModalRef = useRef<HTMLDivElement>(null);

  const isCOD = isLalamoveCOD(order);
  const lalamoveOrderId = getLalamoveOrderId(order);
  const lalamoveStatus = getLalamoveStatus(order) as LalamoveStatusValue | null;
  const shareLink = getLalamoveShareLink(order);
  const driverName = getLalamoveDriverName(order);
  const driverPhone = getLalamoveDriverPhone(order);
  const rawDeliveryDate = getDeliveryDateValue(order);
  const rawTimeSlot = getDeliveryTimeValue(order);
  const fullDeliveryAddress = getFullShippingAddress(order);
  const orderTotal = order.currentTotalPriceSet?.shopMoney?.amount ?? "";
  const orderCurrency = order.currentTotalPriceSet?.shopMoney?.currencyCode ?? "PHP";
  const orderNumber = order.name ?? `#${orderId}`;

  useEffect(() => {
    if (buyForMe) {
      setDriverNotes(
        `COD order. Please prepare ${orderCurrency} ${orderTotal} for payment at pickup. Thank you!`,
      );
    } else {
      setDriverNotes("");
    }
  }, [buyForMe, orderCurrency, orderTotal]);

  useEffect(() => {
    if (
      !showDispatchModal ||
      !rawDeliveryDate ||
      rawDeliveryDate === "—" ||
      !rawTimeSlot ||
      rawTimeSlot === "—" ||
      !fullDeliveryAddress
    ) {
      return;
    }
    const specialRequests = [
      buyForMe ? "PURCHASE_SERVICE_1" : null,
      thermalBag ? "THERMAL_BAG_1" : null,
    ]
      .filter(Boolean)
      .join(",");
    // Debounce so rapid checkbox toggles fire only one quote request (the last).
    const timer = setTimeout(() => {
      quoteFetcher.submit(
        {
          _action: "lalamoveGetQuote",
          deliveryAddress: fullDeliveryAddress,
          deliveryDate: rawDeliveryDate,
          timeSlot: rawTimeSlot,
          specialRequests,
        },
        { method: "post" },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [showDispatchModal, thermalBag, buyForMe]);

  // Focus trap for the dispatch modal: keep Tab within the modal, focus the
  // first control on open, restore focus on close, and let Escape close only
  // the modal (not the whole drawer).
  useEffect(() => {
    if (!showDispatchModal) return;
    const modal = dispatchModalRef.current;
    if (!modal) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));

    (getFocusable()[0] ?? modal).focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShowDispatchModal(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = getFocusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    modal.addEventListener("keydown", handleKeyDown);
    return () => {
      modal.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [showDispatchModal]);

  return (
    <>
      {/* Backdrop */}
      <div className="ods-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div
        className="ods-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Order ${order.name} details`}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="ods-drawer-head">
          <div className="ods-drawer-head-row">
            <div>
              <p className="ods-drawer-order-num">{order.name}</p>
              <div className="ods-drawer-badges">
                <StatusBadge
                  tone={financialStatusTone(order.displayFinancialStatus)}
                  label={formatStatusLabel(order.displayFinancialStatus)}
                />
                <StatusBadge
                  tone={fulfillmentStatusTone(order.displayFulfillmentStatus)}
                  label={formatStatusLabel(order.displayFulfillmentStatus)}
                />
              </div>
            </div>
            <button
              className="ods-drawer-close"
              onClick={onClose}
              aria-label="Close order details"
            >
              ×
            </button>
          </div>
          <p className="ods-drawer-customer">
            <span>{customerName}</span>
            {order.customer?.numberOfOrders != null && order.customer.numberOfOrders > 0 && (
              <span className="ods-loyalty-count">{order.customer.numberOfOrders} orders</span>
            )}
          </p>
          <p className="ods-drawer-total">{total}</p>
        </div>

        {/* ── Body ────────────────────────────────────────────────────── */}
        <div className="ods-drawer-body">
          {/* Delivery section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Delivery</p>
            <dl className="ods-dl">
              <dt className="ods-dt">Date</dt>
              <dd className="ods-dd">
                <span className="ods-drawer-delivery-date">
                  <span>{deliveryDate}</span>
                  {deliveryRelative && (
                    <span
                      className={`ods-delivery-relative${deliveryOverdue ? " ods-delivery-relative--overdue" : ""}`}
                    >
                      {deliveryRelative}
                    </span>
                  )}
                </span>
              </dd>
              <dt className="ods-dt">Time window</dt>
              <dd className="ods-dd">{timeWindow}</dd>
              <dt className="ods-dt">Address</dt>
              <dd className="ods-dd ods-dd--long">{fullAddress || "—"}</dd>
              <dt className="ods-dt">City</dt>
              <dd className="ods-dd">{city || "—"}</dd>
              {addr?.province && (
                <>
                  <dt className="ods-dt">Province</dt>
                  <dd className="ods-dd">
                    <span
                      className={`ods-copyable${fieldCopied === "province" ? " ods-copyable--copied" : ""}`}
                      onClick={() => copyField("province", addr.province!)}
                      title="Click to copy"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && copyField("province", addr.province!)}
                    >
                      {addr.province}
                      <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                    </span>
                  </dd>
                </>
              )}
              <dt className="ods-dt">Card message</dt>
              <dd className={`ods-dd${cardMessage === "—" ? " ods-dd--muted" : " ods-dd--scrollable"}`}>
                {cardMessage !== "—" ? (
                  <span
                    className={`ods-copyable${fieldCopied === "cardMessage" ? " ods-copyable--copied" : ""}`}
                    onClick={() => copyField("cardMessage", cardMessage)}
                    title="Click to copy"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && copyField("cardMessage", cardMessage)}
                  >
                    {cardMessage}
                    <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  </span>
                ) : cardMessage}
              </dd>
              <dt className="ods-dt">Instructions</dt>
              <dd className={`ods-dd${instruction === "—" ? " ods-dd--muted" : " ods-dd--scrollable"}`}>
                {instruction !== "—" ? (
                  <span
                    className={`ods-copyable${fieldCopied === "instruction" ? " ods-copyable--copied" : ""}`}
                    onClick={() => copyField("instruction", instruction)}
                    title="Click to copy"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && copyField("instruction", instruction)}
                  >
                    {instruction}
                    <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  </span>
                ) : instruction}
              </dd>
            </dl>
            <div className="ods-drawer-actions">
              <button
                className="ods-action-icon"
                onClick={() => copyText(buildDeliveryInfoText(order))}
                data-tooltip={copied ? "Copied!" : "Copy delivery info"}
                aria-label="Copy all delivery info"
              >
                {copied ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                    <path d="M4 10l5 5 7-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
                    <rect x="7" y="2" width="6" height="3" rx="1" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M6 3H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <path d="M8 10h4M8 13h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                )}
              </button>
            </div>
          </div>

          {showDeliveryTimeline && (
            <div className="ods-drawer-section">
              <p className="ods-section-title">DELIVERY TIMELINE</p>
              <dl className="ods-dl">
                <dt className="ods-dt">Original delivery</dt>
                <dd className="ods-dd">
                  {formatTimelineDelivery(
                    originalDeliveryDate,
                    originalDeliveryTime,
                  )}
                </dd>
                {rescheduleEvents.length > 0 ? (
                  <>
                    <dt className="ods-dt">Count</dt>
                    <dd className="ods-dd">
                      Rescheduled {rescheduleEvents.length}x
                    </dd>
                    {rescheduleEvents.map((event, index) => (
                      <Fragment
                        key={`${event.requestedAt}-${event.date}-${event.timeSlot}-${index}`}
                      >
                        <dt className="ods-dt">
                          {index === 0 ? "Latest" : `Change ${index + 1}`}
                        </dt>
                        <dd className="ods-dd">
                          <span className="ods-drawer-delivery-date">
                            <span>
                              {formatTimelineDelivery(
                                event.date,
                                event.timeSlot,
                              )}
                            </span>
                            <span className="ods-delivery-relative">
                              {formatTimelineTimestamp(event.requestedAt)} •{" "}
                              {formatTimelineStatus(event.status)}
                            </span>
                          </span>
                        </dd>
                      </Fragment>
                    ))}
                  </>
                ) : (
                  <>
                    <dt className="ods-dt">Status</dt>
                    <dd className="ods-dd">
                      Rescheduled — history not yet recorded
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}

          {/* Customer section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Customer</p>
            <dl className="ods-dl">
              <dt className="ods-dt">Name</dt>
              <dd className="ods-dd">
                <span
                  className={`ods-copyable${fieldCopied === "customerName" ? " ods-copyable--copied" : ""}`}
                  onClick={() => copyField("customerName", customerName)}
                  title="Click to copy"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && copyField("customerName", customerName)}
                >
                  {customerName || "—"}
                  <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                </span>
              </dd>
              <dt className="ods-dt">Email</dt>
              <dd className="ods-dd ods-dd--long">
                {email !== "—" ? (
                  <a href={`mailto:${email}`} className="ods-kpi-value--link">{email}</a>
                ) : "—"}
              </dd>
              <dt className="ods-dt">Phone</dt>
              <dd className="ods-dd">
                {phone !== "—" ? (
                  <span
                    className={`ods-copyable${fieldCopied === "phone" ? " ods-copyable--copied" : ""}`}
                    onClick={() => copyField("phone", phone)}
                    title="Click to copy"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === "Enter" && copyField("phone", phone)}
                  >
                    {phone}
                    <svg className="ods-copy-hint-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  </span>
                ) : "—"}
              </dd>
            </dl>
          </div>

          {/* Sender Info section — only when billing ≠ shipping (gift orders) */}
          {showSenderInfo && (
            <div className="ods-drawer-section">
              <p className="ods-section-title">Sender Info</p>
              <dl className="ods-dl">
                {billingAddress!.name && (
                  <>
                    <dt className="ods-dt">Sender Name</dt>
                    <dd className="ods-dd">{billingAddress!.name}</dd>
                  </>
                )}
                {billingAddress!.address1 && (
                  <>
                    <dt className="ods-dt">Address</dt>
                    <dd className="ods-dd ods-dd--long">{billingAddress!.address1}</dd>
                  </>
                )}
                {billingAddress!.phone && (
                  <>
                    <dt className="ods-dt">Sender Phone</dt>
                    <dd className="ods-dd">{billingAddress!.phone}</dd>
                  </>
                )}
              </dl>
            </div>
          )}

          {/* Items section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Items ({items.length})</p>
            {items.length === 0 ? (
              <p style={{ fontSize: 13, color: "#6d7175", margin: 0 }}>
                No items.
              </p>
            ) : (
              <div>
                {items.map((edge, idx) => {
                  const item = edge.node;
                  const imgUrl =
                    item.image?.url || item.product?.featuredImage?.url;
                  const imgAlt =
                    item.image?.altText ||
                    item.product?.featuredImage?.altText ||
                    item.name;
                  return (
                    <div key={idx} className="ods-item-row">
                      {imgUrl ? (
                        <img
                          className="ods-item-thumb"
                          src={imgUrl}
                          alt={imgAlt}
                        />
                      ) : (
                        <div className="ods-item-thumb-placeholder" />
                      )}
                      <div className="ods-item-info">
                        <div className="ods-item-name">{item.name}</div>
                        {item.sku && (
                          <div className="ods-item-sku">SKU: {item.sku}</div>
                        )}
                      </div>
                      <div className="ods-item-qty">× {item.quantity}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Totals */}
            <div className="ods-totals">
              <div className="ods-totals-row">
                <span className="ods-totals-label">Subtotal</span>
                <span className="ods-totals-value">{subtotalFormatted}</span>
              </div>
              <div className="ods-totals-row">
                <span className="ods-totals-label">Shipping</span>
                <span className="ods-totals-value">{shippingFormatted}</span>
              </div>
              <div className="ods-totals-row ods-totals-row--total">
                <span className="ods-totals-label">Total</span>
                <span className="ods-totals-value">{total}</span>
              </div>
            </div>
          </div>

          {/* ── Lalamove Delivery ─────────────────────────────────────── */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Lalamove Delivery</p>

            {/* State 1 — Not dispatched */}
            {!lalamoveOrderId && (
              <button
                type="button"
                className="ods-btn ods-btn--orange"
                onClick={() => setShowDispatchModal(true)}
              >
                Book
              </button>
            )}

            {/* State 2 — ASSIGNING_DRIVER */}
            {lalamoveOrderId && lalamoveStatus === "ASSIGNING_DRIVER" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <LalamoveStatusLabel status="ASSIGNING_DRIVER" />
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="number"
                    placeholder="₱ Priority fee"
                    value={priorityFeeInput}
                    onChange={(e) => setPriorityFeeInput(e.target.value)}
                    className="ods-input-sm"
                  />
                  <priorityFetcher.Form method="post">
                    <input type="hidden" name="_action" value="lalamovePriorityFee" />
                    <input type="hidden" name="lalamoveOrderId" value={lalamoveOrderId} />
                    <input type="hidden" name="priorityFee" value={priorityFeeInput} />
                    <button
                      type="submit"
                      disabled={!priorityFeeInput || priorityFetcher.state !== "idle"}
                      className="ods-icon-btn"
                      title="Add priority fee"
                      aria-label="Add priority fee"
                    >
                      {priorityFetcher.state !== "idle" ? (
                        <span className="ods-spinner" />
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                        </svg>
                      )}
                    </button>
                  </priorityFetcher.Form>
                </div>
                {priorityFetcher.data?.error && (
                  <p style={{ color: "#dc2626", fontSize: 12, margin: 0 }}>
                    {priorityFetcher.data.error}
                  </p>
                )}
                <cancelFetcher.Form method="post">
                  <input type="hidden" name="_action" value="lalamoveCancel" />
                  <input type="hidden" name="orderId" value={order.id} />
                  <input type="hidden" name="lalamoveOrderId" value={lalamoveOrderId} />
                  <button
                    type="submit"
                    disabled={cancelFetcher.state !== "idle"}
                    className="ods-btn ods-btn--critical-plain"
                  >
                    {cancelFetcher.state !== "idle" ? "Cancelling…" : "Cancel delivery"}
                  </button>
                </cancelFetcher.Form>
                {cancelFetcher.data?.error && (
                  <p style={{ color: "#dc2626", fontSize: 12, margin: 0 }}>
                    {cancelFetcher.data.error}
                  </p>
                )}
              </div>
            )}

            {/* State 3 — ON_GOING / PICKED_UP */}
            {lalamoveOrderId &&
              (lalamoveStatus === "ON_GOING" || lalamoveStatus === "PICKED_UP") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <LalamoveStatusLabel status={lalamoveStatus} />
                  {driverName && (
                    <div className="ods-driver-card">
                      <div className="ods-driver-card__name">{driverName}</div>
                      {driverPhone && (
                        <div className="ods-driver-card__phone">{driverPhone}</div>
                      )}
                    </div>
                  )}
                  {shareLink && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        type="button"
                        className="ods-btn ods-btn--default"
                        onClick={() => navigator.clipboard.writeText(shareLink)}
                      >
                        Copy link
                      </button>
                      <a
                        href={shareLink}
                        target="_blank"
                        rel="noreferrer"
                        className="ods-btn ods-btn--default"
                      >
                        Open ↗
                      </a>
                    </div>
                  )}
                  <cancelFetcher.Form method="post">
                    <input type="hidden" name="_action" value="lalamoveCancel" />
                    <input type="hidden" name="orderId" value={order.id} />
                    <input type="hidden" name="lalamoveOrderId" value={lalamoveOrderId} />
                    <button
                      type="submit"
                      disabled={cancelFetcher.state !== "idle"}
                      className="ods-btn ods-btn--critical-plain"
                    >
                      {cancelFetcher.state !== "idle" ? "Cancelling…" : "Cancel delivery"}
                    </button>
                  </cancelFetcher.Form>
                </div>
              )}

            {/* State 4 — COMPLETED */}
            {lalamoveOrderId && lalamoveStatus === "COMPLETED" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <LalamoveStatusLabel status="COMPLETED" />
                {driverName && (
                  <div className="ods-driver-card">
                    <div className="ods-driver-card__name">{driverName}</div>
                  </div>
                )}
                {shareLink && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="ods-btn ods-btn--default"
                      onClick={() => navigator.clipboard.writeText(shareLink)}
                    >
                      Copy link
                    </button>
                    <a
                      href={shareLink}
                      target="_blank"
                      rel="noreferrer"
                      className="ods-btn ods-btn--default"
                    >
                      Open ↗
                    </a>
                  </div>
                )}
              </div>
            )}

            {/* State 5 — CANCELED / REJECTED / EXPIRED */}
            {lalamoveOrderId &&
              (lalamoveStatus === "CANCELED" ||
                lalamoveStatus === "REJECTED" ||
                lalamoveStatus === "EXPIRED") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <LalamoveStatusLabel status={lalamoveStatus} />
                  <button
                    type="button"
                    className="ods-btn ods-btn--orange"
                    onClick={() => setShowDispatchModal(true)}
                  >
                    Book
                  </button>
                </div>
              )}
          </div>

          {/* ── Dispatch Modal ──────────────────────────────────────────── */}
          {showDispatchModal && (
            <div className="ods-dispatch-modal-overlay">
              <div
                className="ods-dispatch-modal"
                ref={dispatchModalRef}
                role="dialog"
                aria-modal="true"
                aria-label={`Dispatch via Lalamove for order ${orderNumber}`}
                tabIndex={-1}
              >
                <p style={{ fontWeight: 700, fontSize: 15, margin: "0 0 14px" }}>
                  Dispatch via Lalamove — {orderNumber}
                </p>

                <p className="ods-section-title">Special Requests</p>

                {isCOD && (
                  <label className="ods-check-row" style={{ cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={buyForMe}
                      onChange={(e) => setBuyForMe(e.target.checked)}
                    />
                    <span className="ods-check-label">
                      <span className="ods-check-text">Buy for me (Up to ₱2,000)</span>
                      <span className="ods-check-helper">Driver pays COD amount at pickup</span>
                    </span>
                  </label>
                )}

                <label className="ods-check-row" style={{ cursor: "pointer", marginBottom: 14 }}>
                  <input
                    type="checkbox"
                    checked={thermalBag}
                    onChange={(e) => setThermalBag(e.target.checked)}
                  />
                  <span className="ods-check-label">
                    <span className="ods-check-text">Thermal bag</span>
                    <span className="ods-check-helper">Keeps items cool during transit</span>
                  </span>
                </label>

                <p className="ods-section-title">Notes to driver</p>
                <textarea
                  value={driverNotes}
                  onChange={(e) => setDriverNotes(e.target.value)}
                  rows={3}
                  maxLength={500}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "1px solid #c9cccf",
                    fontSize: 13,
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                  placeholder="Instructions for the driver…"
                />
                <p style={{ fontSize: 11, color: "#6b7280", margin: "2px 0 16px" }}>
                  {500 - driverNotes.length} characters left
                </p>

                <div className="ods-price-card">
                  <span className="ods-price-card__label">Estimated price</span>
                  {quoteFetcher.state !== "idle" ? (
                    <span className="ods-price-card__loading">
                      <span className="ods-spinner" />
                      Fetching…
                    </span>
                  ) : quoteFetcher.data?.price ? (
                    <span className="ods-price-card__value">
                      {quoteFetcher.data.price}
                      {quoteFetcher.data.expiresAt && (
                        <span style={{ display: "block", fontSize: 11, fontWeight: 400, color: "#6b7280" }}>
                          Valid until{" "}
                          {new Date(quoteFetcher.data.expiresAt).toLocaleTimeString("en-US", {
                            hour: "numeric",
                            minute: "2-digit",
                          })}
                        </span>
                      )}
                    </span>
                  ) : quoteFetcher.data?.error ? (
                    <span className="ods-price-card__error">{quoteFetcher.data.error}</span>
                  ) : (
                    <span className="ods-price-card__loading">—</span>
                  )}
                </div>

                {lalamoveFetcher.data?.error && (
                  <p style={{ color: "#dc2626", fontSize: 12, margin: "0 0 10px" }}>
                    {lalamoveFetcher.data.error}
                  </p>
                )}

                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => setShowDispatchModal(false)}
                    className="ods-btn ods-btn--default"
                  >
                    Cancel
                  </button>
                  <lalamoveFetcher.Form
                    method="post"
                    onSubmit={() => setShowDispatchModal(false)}
                    style={{ margin: 0 }}
                  >
                    <input type="hidden" name="_action" value="lalamoveDispatch" />
                    <input type="hidden" name="orderId" value={order.id} />
                    <input type="hidden" name="deliveryDate" value={rawDeliveryDate} />
                    <input type="hidden" name="timeSlot" value={rawTimeSlot} />
                    <input type="hidden" name="customerName" value={customerName} />
                    <input type="hidden" name="customerPhone" value={phone} />
                    <input type="hidden" name="deliveryAddress" value={fullDeliveryAddress} />
                    <input type="hidden" name="notesToDriver" value={driverNotes} />
                    <input
                      type="hidden"
                      name="specialRequests"
                      value={[
                        buyForMe ? "PURCHASE_SERVICE_1" : null,
                        thermalBag ? "THERMAL_BAG_1" : null,
                      ]
                        .filter(Boolean)
                        .join(",")}
                    />
                    <button
                      type="submit"
                      disabled={lalamoveFetcher.state !== "idle"}
                      className="ods-btn ods-btn--orange"
                    >
                      {lalamoveFetcher.state !== "idle" ? (
                        <><span className="ods-spinner--btn" /> Booking…</>
                      ) : "Book"}
                    </button>
                  </lalamoveFetcher.Form>
                </div>
              </div>
            </div>
          )}

          {/* Admin link + fulfillment CTA */}
          <div className="ods-drawer-section">
            <div className="ods-drawer-actions">
              {isOpenOrder && onMarkFulfilled && (
                <button className="ods-action-link" onClick={onMarkFulfilled}>
                  Mark as Fulfilled
                </button>
              )}
              <a
                href={`shopify://admin/orders/${orderId}`}
                className="ods-action-link"
              >
                Open in Shopify Admin
              </a>
            </div>
          </div>

          {/* Tags section */}
          <div className="ods-drawer-section">
            <p className="ods-section-title">Tags</p>
            {meaningfulTags.length === 0 ? (
              <p className="ods-tag-empty">No tags</p>
            ) : (
              <ul className="ods-tag-list">
                {meaningfulTags.map((tag) => (
                  <li key={tag} className="ods-tag-pill">
                    {tagDisplayLabel(tag)}
                  </li>
                ))}
              </ul>
            )}
            <tagFetcher.Form
              method="post"
              className="ods-tag-input-row"
              onSubmit={(e) => {
                if (!tagInput.trim()) { e.preventDefault(); return; }
              }}
            >
              <input type="hidden" name="_action" value="tagsAdd" />
              <input type="hidden" name="orderId" value={order.id} />
              <input
                className="ods-tag-input"
                type="text"
                name="tags"
                placeholder="Add a tag…"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                disabled={tagFetcher.state !== "idle"}
                maxLength={255}
                autoComplete="off"
              />
              <button
                type="submit"
                className="ods-tag-add-btn"
                disabled={!tagInput.trim() || tagFetcher.state !== "idle"}
              >
                {tagFetcher.state !== "idle" ? "Adding…" : "Add"}
              </button>
            </tagFetcher.Form>
            {tagFetcher.state === "idle" && tagFetcher.data && !tagFetcher.data.ok && (
              <p className="ods-tag-error">{tagFetcher.data.message ?? "Failed to add tag."}</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
