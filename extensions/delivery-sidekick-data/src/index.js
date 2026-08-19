// Sidekick app-data tools for the Delivery Scheduler app.
//
// Each tool is a thin proxy onto one READ-ONLY backend route
// (app/routes/sidekick.tools.*.ts). Nothing here writes: the routes issue no
// Shopify mutations and touch no delivery state — see docs/api.md
// "Sidekick tool routes" and docs/decisions.md ADR-18.
//
// The fetches are RELATIVE on purpose. The Sidekick sandbox resolves relative
// URLs against the app's configured auth domain and automatically attaches the
// `Authorization` session-token header, which `authenticate.admin()` exchanges
// server-side. Do not hard-code the app origin here.
//
// Every route answers `200 + {ok:true|false}` (ADR-11), so a failure arrives as
// a normal JSON body rather than an exception. The wrapper below still guards
// against transport-level failures so a tool call never rejects — Sidekick
// reads `error` and tells the merchant what went wrong.

/**
 * @param {string} path
 * @param {Record<string, unknown>} input
 */
async function callTool(path, input) {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    });

    const body = await response.json();
    if (body && typeof body === "object") return body;

    return { ok: false, error: "The Delivery Scheduler app returned an unreadable response." };
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the Delivery Scheduler app: ${
        error instanceof Error ? error.message : "unknown network error"
      }`,
    };
  }
}

export default async function extension() {
  shopify.tools.register("get_delivery_booked_counts", (input) => {
    const { date, start_date: startDate, end_date: endDate } = input ?? {};
    return callTool("/sidekick/tools/booked-counts", {
      ...(date ? { date } : {}),
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
    });
  });

  shopify.tools.register("get_order_delivery", (input) => {
    return callTool("/sidekick/tools/order-delivery", {
      order_name: input?.order_name ?? "",
    });
  });

  shopify.tools.register("get_schedule_config_summary", () => {
    return callTool("/sidekick/tools/schedule-config", {});
  });
}
