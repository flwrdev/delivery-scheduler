// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock react-router's useFetcher ──────────────────────────────────────────
// OrderDrawer only consumes `useFetcher` from react-router. Every fetcher shares
// one `submit` spy; only the quote effect calls `.submit(...)` programmatically
// (the dispatch/tag forms submit natively), so the spy captures quote requests.
const submitSpy = vi.fn();
vi.mock("react-router", () => ({
  useFetcher: () => ({
    state: "idle",
    data: undefined,
    submit: submitSpy,
    Form: ({ children, ...props }: { children: React.ReactNode }) => (
      <form {...props}>{children}</form>
    ),
  }),
}));

import { OrderDrawer } from "../app/components/OrderDrawer";
import type { Order } from "../app/lib/order-utils";

function makeOrder(): Order {
  return {
    id: "gid://shopify/Order/123",
    name: "#1001",
    createdAt: "2026-06-01T00:00:00Z",
    cancelledAt: null,
    displayFulfillmentStatus: "UNFULFILLED",
    displayFinancialStatus: "PENDING",
    tags: [],
    customer: {
      id: "gid://shopify/Customer/1",
      firstName: "Juan",
      lastName: "Cruz",
      defaultEmailAddress: { emailAddress: "juan@example.com" },
      defaultPhoneNumber: { phoneNumber: "+639171234567" },
      numberOfOrders: 2,
    },
    deliveryDate: null,
    deliveryTimeSlot: null,
    customDate: { value: "2026-06-20" },
    customTimeSlot: { value: "9AM-12PM" },
    rescheduleHistory: null,
    shippingAddress: {
      address1: "255 Kawit St",
      address2: "Tondo",
      city: "Manila",
      province: "Metro Manila",
      zip: "1000",
      country: "PH",
      phone: "+639171234567",
    },
    billingAddress: null,
    note: null,
    currentTotalPriceSet: { shopMoney: { amount: "1500.00", currencyCode: "PHP" } },
    totalShippingPriceSet: { shopMoney: { amount: "0.00", currencyCode: "PHP" } },
    customAttributes: [],
    lineItems: {
      edges: [{ node: { name: "Bouquet", quantity: 1, sku: "BQ1", image: null, product: null } }],
    },
    paymentGatewayNames: ["Cash on Delivery (COD)"],
    lalamoveOrderId: null,
  };
}

function openDispatchModal() {
  render(<OrderDrawer order={makeOrder()} onClose={() => {}} />);
  // State 1 (no Lalamove order yet) shows a single "Book" button that opens the modal.
  fireEvent.click(screen.getByRole("button", { name: "Book" }));
}

function lastQuoteCall() {
  return submitSpy.mock.calls[submitSpy.mock.calls.length - 1]?.[0] as
    | Record<string, string>
    | undefined;
}

describe("OrderDrawer — quote refresh + dispatch flow", () => {
  beforeEach(() => {
    submitSpy.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    cleanup();
  });

  it("fetches an initial quote (debounced) when the dispatch modal opens", () => {
    openDispatchModal();
    // No submit before the debounce window elapses.
    expect(submitSpy).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(300));

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const payload = lastQuoteCall();
    expect(payload?._action).toBe("lalamoveGetQuote");
    expect(payload?.deliveryDate).toBe("2026-06-20");
    expect(payload?.timeSlot).toBe("9AM-12PM");
    expect(payload?.deliveryAddress).toBe("255 Kawit St, Tondo");
    expect(payload?.specialRequests).toBe("");
  });

  it("re-fetches the quote with the new special requests when a checkbox toggles", () => {
    openDispatchModal();
    act(() => vi.advanceTimersByTime(300)); // initial quote
    submitSpy.mockClear();

    fireEvent.click(screen.getByRole("checkbox", { name: /thermal bag/i }));
    act(() => vi.advanceTimersByTime(300));

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(lastQuoteCall()?.specialRequests).toBe("THERMAL_BAG_1");
  });

  it("debounces rapid toggles into a single quote request (the last state wins)", () => {
    openDispatchModal();
    act(() => vi.advanceTimersByTime(300)); // initial quote
    submitSpy.mockClear();

    const thermal = screen.getByRole("checkbox", { name: /thermal bag/i });
    fireEvent.click(thermal); // on
    act(() => vi.advanceTimersByTime(100)); // still inside the debounce window
    fireEvent.click(thermal); // off again
    act(() => vi.advanceTimersByTime(300));

    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(lastQuoteCall()?.specialRequests).toBe("");
  });

  it("dispatch form carries the SAME special requests last quoted (quote/dispatch consistency)", () => {
    const { container } = render(
      <OrderDrawer order={makeOrder()} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Book" }));
    act(() => vi.advanceTimersByTime(300));

    fireEvent.click(screen.getByRole("checkbox", { name: /thermal bag/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /buy for me/i }));
    act(() => vi.advanceTimersByTime(300));

    // What the quote was last fetched with…
    const quoted = lastQuoteCall()?.specialRequests?.split(",").sort();
    // …must equal what the dispatch form will POST.
    const dispatchValue = container
      .querySelector<HTMLInputElement>('input[name="specialRequests"]')
      ?.value.split(",")
      .sort();

    expect(dispatchValue).toEqual(quoted);
    expect(dispatchValue).toEqual(["PURCHASE_SERVICE_1", "THERMAL_BAG_1"]);

    // The dispatch payload also carries the order identity + schedule.
    expect(
      container.querySelector<HTMLInputElement>('input[name="orderId"]')?.value,
    ).toBe("gid://shopify/Order/123");
    expect(
      container.querySelector<HTMLInputElement>('input[name="deliveryDate"]')?.value,
    ).toBe("2026-06-20");
    expect(
      container.querySelector<HTMLInputElement>('input[name="timeSlot"]')?.value,
    ).toBe("9AM-12PM");
  });
});
