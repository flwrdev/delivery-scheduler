import { describe, expect, it } from "vitest";

import { sanitizeLalamoveOrderId } from "../app/services/lalamove-tracking.server";

describe("sanitizeLalamoveOrderId", () => {
  it("strips the leading # the Lalamove app displays the order id with", () => {
    expect(sanitizeLalamoveOrderId("#3563144148557194173")).toBe("3563144148557194173");
  });

  it("leaves a bare numeric id unchanged", () => {
    expect(sanitizeLalamoveOrderId("3562752825958289729")).toBe("3562752825958289729");
  });

  it("trims surrounding whitespace, including around a leading #", () => {
    expect(sanitizeLalamoveOrderId("  #3563144148557194173  ")).toBe("3563144148557194173");
    expect(sanitizeLalamoveOrderId(" 3562752825958289729 ")).toBe("3562752825958289729");
  });

  it("only strips one leading #, never one embedded elsewhere", () => {
    expect(sanitizeLalamoveOrderId("#123#456")).toBe("123#456");
  });
});
