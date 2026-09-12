import { describe, expect, it } from "vitest";
import {
  parseDeliveryDateTime,
  parseOrderSummary,
  parseTotalBreakdown,
  splitAddress,
} from "../app/lib/parse-order-summary";

const VARIANTS = [
  { id: "gid://shopify/ProductVariant/1", label: "Autumn Morning" },
  { id: "gid://shopify/ProductVariant/2", label: "Autumn Morning / Large" },
  { id: "gid://shopify/ProductVariant/3", label: "Sunset Bliss" },
];

const SUMMARY = `Noted po, Jeffrey! Eto po ang summary ng inyong order:
Product: **Autumn Morning**
Recipient: **Maria Santos**
Contact: **0912 345 6789**
Email: **jeffrey.dc@gmail.com**
Address: **27 PNP Compound Hilltop, Brgy. Dolores, Taytay, Rizal**
Delivery Date & Time: **Sept 10, 2026, 3:00 PM - 4:00 PM**
Card Message: **None**
Payment: **GCash**
Delivery Fee: **₱150.00**
Total: **₱1,031.00**
Tama po ba ang lahat ng details?`;

describe("parseOrderSummary", () => {
  it("fills every form field from the Messenger summary template", () => {
    const parsed = parseOrderSummary(SUMMARY, VARIANTS);
    expect(parsed.values).toEqual({
      customerName: "Jeffrey",
      variantId: "gid://shopify/ProductVariant/1",
      recipientName: "Maria Santos",
      phone: "0912 345 6789",
      email: "jeffrey.dc@gmail.com",
      address1: "27 PNP Compound Hilltop",
      address2: "Brgy. Dolores",
      city: "Taytay",
      province: "Rizal",
      deliveryDate: "2026-09-10",
      deliveryTime: "3:00 PM - 4:00 PM",
      payment: "gcash_pending",
      cardMessage: "",
      deliveryFee: "150",
      note: "Payment: GCash",
    });
    expect(parsed.pastedTotal).toBe(1031);
    expect(parsed.productName).toBe("Autumn Morning");
    expect(parsed.warnings).toEqual([]);
  });

  it("fills only the fields present when a single line is pasted", () => {
    const parsed = parseOrderSummary("Recipient: **Juan Dela Cruz**", VARIANTS);
    expect(parsed.values).toEqual({ recipientName: "Juan Dela Cruz" });
  });

  it("warns when the product has no matching variant", () => {
    const parsed = parseOrderSummary("Product: **Nonexistent Bouquet**", VARIANTS);
    expect(parsed.values.variantId).toBeUndefined();
    expect(parsed.warnings[0]).toContain("Nonexistent Bouquet");
  });

  it("keeps a real card message and works without bold markers", () => {
    const parsed = parseOrderSummary("Card Message: Happy birthday, Ma!", VARIANTS);
    expect(parsed.values.cardMessage).toBe("Happy birthday, Ma!");
  });
});

describe("parseDeliveryDateTime", () => {
  it("parses month-name dates with a trailing time", () => {
    expect(parseDeliveryDateTime("Sept 10, 2026, 3:00 PM - 4:00 PM")).toEqual({ date: "2026-09-10", time: "3:00 PM - 4:00 PM" });
    expect(parseDeliveryDateTime("September 5, 2026 at 9AM-12PM")).toEqual({ date: "2026-09-05", time: "9AM-12PM" });
  });

  it("defaults to the current year when the year is missing", () => {
    expect(parseDeliveryDateTime("Dec 25 exact 9am", new Date("2026-09-12"))).toEqual({ date: "2026-12-25", time: "exact 9am" });
  });

  it("parses ISO and slash dates", () => {
    expect(parseDeliveryDateTime("2026-09-10 12PM-3PM")).toEqual({ date: "2026-09-10", time: "12PM-3PM" });
    expect(parseDeliveryDateTime("9/10/2026, 6PM-11PM")).toEqual({ date: "2026-09-10", time: "6PM-11PM" });
  });

  it("returns null when no date is present", () => {
    expect(parseDeliveryDateTime("3PM-6PM")).toBeNull();
  });
});

describe("splitAddress", () => {
  it("splits street, barangay, city, province", () => {
    expect(splitAddress("27 PNP Compound Hilltop, Brgy. Dolores, Taytay, Rizal")).toEqual({
      address1: "27 PNP Compound Hilltop",
      address2: "Brgy. Dolores",
      city: "Taytay",
      province: "Rizal",
    });
  });

  it("handles short addresses", () => {
    expect(splitAddress("Unit 5 Tower A, Makati")).toEqual({ address1: "Unit 5 Tower A", city: "Makati" });
    expect(splitAddress("Makati")).toEqual({ address1: "Makati" });
  });
});

const COD_SUMMARY = `Sige po, updated na to **8:00 PM** yung delivery time bukas, Sept 8.
Eto po yung final summary para sa order niyo, Sir Shayne:
- **Majestic Bouquet** (2-dozen red and pink roses)
- **Email:** shayne.ochoco@nice.com
- **Phone:** 09491347551
- **Address:** SMDC Light Residences (Ground floor pick up)
- **Delivery Date:** Sept 8, 2026
- **Delivery Time:** 8:00 PM
- **Total:** **₱1,628** (₱1,399 bouquet + ₱159 delivery + ₱70 COD fee)`;

describe("parseTotalBreakdown", () => {
  it("splits total, delivery fee, and COD fee out of the parenthetical", () => {
    expect(parseTotalBreakdown("₱1,628 (₱1,399 bouquet + ₱159 delivery + ₱70 COD fee)")).toEqual({
      total: 1628,
      productTotal: 1399,
      deliveryFee: 159,
      codFee: 70,
    });
  });

  it("returns only the total when there is no breakdown", () => {
    expect(parseTotalBreakdown("₱1,031.00")).toEqual({
      total: 1031,
      productTotal: null,
      deliveryFee: null,
      codFee: null,
    });
  });
});

describe("parseOrderSummary — COD summary with a custom time", () => {
  it("reads the breakdown into delivery fee + COD payment and keeps the typed time", () => {
    const parsed = parseOrderSummary(COD_SUMMARY, VARIANTS, new Date("2026-09-07T00:00:00+08:00"));
    expect(parsed.pastedTotal).toBe(1628);
    expect(parsed.values.deliveryFee).toBe("159");
    expect(parsed.values.payment).toBe("cod");
    expect(parsed.values.deliveryDate).toBe("2026-09-08");
    expect(parsed.values.deliveryTime).toBe("8:00 PM");
    expect(parsed.values.email).toBe("shayne.ochoco@nice.com");
    expect(parsed.values.phone).toBe("09491347551");
  });

  it("maps a GCash payment line to the pending-GCash mode", () => {
    expect(parseOrderSummary(SUMMARY, VARIANTS).values.payment).toBe("gcash_pending");
  });
});
