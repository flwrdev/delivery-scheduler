import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/index.js' {
  interface GetDeliveryBookedCountsInput {
    /**
     * A single delivery date in YYYY-MM-DD format. Omit for all upcoming capacity-tracked dates.
     */
    date?: string;
    /**
     * First delivery date of a range, YYYY-MM-DD. Defaults to today in the shop's delivery timezone.
     */
    start_date?: string;
    /**
     * Last delivery date of a range, YYYY-MM-DD. Omit for no upper bound.
     */
    end_date?: string;
    [k: string]: unknown;
  }

  interface GetDeliveryBookedCountsOutput {
    /**
     * False when the request failed; read `error` for the reason.
     */
    ok: boolean;
    /**
     * Merchant-readable failure reason, present only when ok is false.
     */
    error?: string;
    /**
     * IANA timezone the delivery dates are expressed in.
     */
    timezone?: string;
    /**
     * Today's date in the shop's delivery timezone, YYYY-MM-DD.
     */
    today?: string;
    /**
     * Trust level of the booked numbers: ok, partial, untracked, skipped, or error.
     */
    countsStatus?: 'ok' | 'partial' | 'untracked' | 'skipped' | 'error';
    /**
     * One sentence explaining how far the booked counts can be trusted. Relay this when countsStatus is not ok.
     */
    countsNote?: string;
    /**
     * When the booked counts were derived, ISO 8601.
     */
    countsFetchedAt?: string;
    /**
     * Whether the counts came from the 60-second in-process cache.
     */
    countsFromCache?: boolean;
    /**
     * One entry per capacity-tracked delivery date in the requested window.
     */
    dates?: {
      /**
       * Delivery date, YYYY-MM-DD.
       */
      date: string;
      /**
       * True when the whole date is blocked for delivery.
       */
      dateDisabled?: boolean;
      /**
       * Per time-slot capacity for this date.
       */
      slots: {
        /**
         * Time slot label, for example 9AM-12PM.
         */
        slot: string;
        /**
         * Configured maximum deliveries for this date and slot.
         */
        capacity: number;
        /**
         * Orders currently booked into this date and slot. NULL when countsStatus is "error" or "skipped" - the live scan produced no numbers, so do not state a booked figure.
         */
        booked?: number;
        /**
         * capacity minus booked, floored at zero. NULL when countsStatus is "error" or "skipped".
         */
        remaining?: number;
        /**
         * True when booked has reached capacity. NULL when countsStatus is "error" or "skipped".
         */
        full?: boolean;
        /**
         * True when this slot is blocked on this date.
         */
        blocked?: boolean;
        [k: string]: unknown;
      }[];
      /**
       * Slots on this date left out of the response for size.
       */
      slotsOmitted?: number;
      [k: string]: unknown;
    }[];
    /**
     * Number of dates included in `dates`.
     */
    datesReturned?: number;
    /**
     * Number of dates that matched the request before the size cap.
     */
    datesMatched?: number;
    /**
     * Matched dates left out for size. Tell the merchant to narrow the range when this is above zero.
     */
    datesOmitted?: number;
    /**
     * Total number of dates that have any capacity configured.
     */
    capacityTrackedDates?: number;
    /**
     * Dates whose booked counts are a lower bound because an order-scan cap clipped them.
     */
    truncatedDates?: string[];
    /**
     * Dates that were explicitly requested but have no capacity configured. These days have no per-slot cap at all - only the global rules apply.
     */
    untrackedRequestedDates?: string[];
    [k: string]: unknown;
  }

  interface GetOrderDeliveryInput {
    /**
     * The order number as the merchant says it, with or without the leading hash: "#4111" or "4111".
     */
    order_name: string;
    [k: string]: unknown;
  }

  interface GetOrderDeliveryOutput {
    /**
     * False when the order was not found or the lookup failed; read `error`.
     */
    ok: boolean;
    /**
     * Merchant-readable failure reason, present only when ok is false.
     */
    error?: string;
    /**
     * The single matched order.
     */
    order?: {
      /**
       * Shopify order GID.
       */
      id: string;
      /**
       * Numeric Shopify order id.
       */
      legacyId?: string;
      /**
       * Order number, for example #4111.
       */
      name: string;
      /**
       * Scheduled delivery date, YYYY-MM-DD. Null when the order has no delivery schedule.
       */
      deliveryDate?: string;
      /**
       * Scheduled delivery time slot, for example 9AM-12PM.
       */
      deliveryTimeSlot?: string;
      /**
       * Which field the schedule was read from: metafield, legacy_metafield or custom_attribute.
       */
      deliverySource?: string;
      /**
       * Checkout-time delivery validation outcome: "ok" or "attention:<code>".
       */
      deliverySyncStatus?: string;
      /**
       * Reschedule state for the customer self-service lock, when set.
       */
      rescheduleStatus?: string;
      /**
       * When the last reschedule was requested, ISO 8601.
       */
      rescheduleRequestedAt?: string;
      /**
       * Number of recorded reschedules for this order.
       */
      rescheduleCount?: number;
      /**
       * Shopify fulfillment status, for example UNFULFILLED or FULFILLED.
       */
      displayFulfillmentStatus?: string;
      /**
       * Shopify payment status, for example PAID or PENDING.
       */
      displayFinancialStatus?: string;
      /**
       * When the order was cancelled, ISO 8601, or null.
       */
      cancelledAt?: string;
      /**
       * When the order was placed, ISO 8601.
       */
      createdAt?: string;
      /**
       * Relative link that opens this order's delivery panel in the Delivery Scheduler app.
       */
      appUrl?: string;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  }

  interface GetScheduleConfigSummaryInput {
    [k: string]: unknown;
  }

  interface GetScheduleConfigSummaryOutput {
    /**
     * False when the request failed; read `error` for the reason.
     */
    ok: boolean;
    /**
     * Merchant-readable failure reason, present only when ok is false.
     */
    error?: string;
    /**
     * IANA timezone all delivery dates and the cutoff are evaluated in.
     */
    timezone?: string;
    /**
     * Hour of day (0-23) after which same-day delivery is no longer offered.
     */
    cutoffHour?: number;
    /**
     * Preparation lead time in hours required before a delivery slot.
     */
    prepHours?: number;
    /**
     * How many days ahead a customer can book a delivery.
     */
    maxDays?: number;
    /**
     * Configured delivery time slots.
     */
    slots?: {
      /**
       * Label shown to customers.
       */
      display: string;
      /**
       * Stored slot value, for example 9AM-12PM.
       */
      value: string;
      [k: string]: unknown;
    }[];
    /**
     * Total number of configured slots.
     */
    slotCount?: number;
    /**
     * Slots left out of `slots` for size.
     */
    slotsOmitted?: number;
    /**
     * How many dates are fully closed for delivery.
     */
    disabledDatesCount?: number;
    /**
     * Up to ten of the closed delivery dates, earliest first.
     */
    disabledDatesSample?: string[];
    /**
     * How many dates have at least one blocked time slot.
     */
    blockedSlotDatesCount?: number;
    /**
     * Up to ten dates with their blocked time slots.
     */
    blockedSlotsSample?: {
      /**
       * Delivery date, YYYY-MM-DD.
       */
      date: string;
      /**
       * Blocked slots on that date.
       */
      slots: string[];
      [k: string]: unknown;
    }[];
    /**
     * How many dates have a capacity cap configured.
     */
    capacityTrackedDatesCount?: number;
    /**
     * Up to ten capacity-tracked dates, earliest first.
     */
    capacityTrackedDatesSample?: string[];
    /**
     * Number of problems detected in the stored configuration.
     */
    configHealthIssueCount?: number;
    /**
     * Up to ten configuration problems, as "field: message".
     */
    configHealthSample?: string[];
    /**
     * Optimistic-concurrency version of the stored configuration.
     */
    version?: number;
    [k: string]: unknown;
  }

  interface ShopifyTools {
    /**
     * Get how many delivery orders are already booked against the capacity cap for each upcoming delivery date and time slot (for example 9AM-12PM). Use for questions about how full a delivery day is, whether a date or slot is fully booked, how many slots are left, or which upcoming days still have delivery capacity. Optionally narrow to one date or a date range. Counts are live from Shopify orders and may be reported as partial.
     */
    register(
      name: 'get_delivery_booked_counts',
      handler: (
        input: GetDeliveryBookedCountsInput,
      ) =>
        | GetDeliveryBookedCountsOutput
        | Promise<GetDeliveryBookedCountsOutput>,
    ): () => void;
    /**
     * Look up one order's scheduled delivery date, delivery time slot, reschedule status and fulfillment status by its order number, for example "#4111". Use whenever the merchant asks when a specific order is being delivered, which time slot it is in, whether it has been rescheduled or how many times, or whether it is still unfulfilled. Returns a single order plus a deep link to open it in the Delivery Scheduler app.
     */
    register(
      name: 'get_order_delivery',
      handler: (
        input: GetOrderDeliveryInput,
      ) => GetOrderDeliveryOutput | Promise<GetOrderDeliveryOutput>,
    ): () => void;
    /**
     * Get the store's delivery scheduling setup: delivery timezone, same-day order cutoff hour, preparation hours, how many days ahead customers can book, the list of delivery time slots, plus a summary of blocked delivery dates, blocked slots and which dates have capacity caps. Use for questions about the cutoff, lead time, booking window, what time slots exist, or which dates are closed for delivery. Does not include booked counts.
     */
    register(
      name: 'get_schedule_config_summary',
      handler: (
        input: GetScheduleConfigSummaryInput,
      ) =>
        | GetScheduleConfigSummaryOutput
        | Promise<GetScheduleConfigSummaryOutput>,
    ): () => void;
  }

  const shopify: import('@shopify/ui-extensions/admin').WithGeneratedTools<
    import('@shopify/ui-extensions/admin.app.tools.data').Api,
    ShopifyTools
  >;
  const globalThis: { shopify: typeof shopify };
}
