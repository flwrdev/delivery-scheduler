import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import {
  isCartEligibleForMothersDay,
  isMothersDayRushDate,
  MOTHERS_DAY_PRODUCT_ERROR_MESSAGE,
  validateDeliverySelection,
} from "../lib/delivery-availability";
import { hydrateSubmittedCartMothersDayItems } from "../services/mothers-day-validation.server";
import { getScheduleRulesWithBookedCounts } from "../services/schedule-rules.server";
import { authenticate } from "../shopify.server";

interface ValidateDeliveryRequestBody {
  date?: unknown;
  timeSlot?: unknown;
  items?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function parseRequestBody(
  request: Request,
): Promise<ValidateDeliveryRequestBody> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return (await request.json()) as ValidateDeliveryRequestBody;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const formBody = await request.text();
    const searchParams = new URLSearchParams(formBody);
    return {
      date: searchParams.get("date"),
      timeSlot: searchParams.get("timeSlot"),
    };
  }

  throw new Error("Unsupported content type");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: ValidateDeliveryRequestBody;
  try {
    body = await parseRequestBody(request);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid request body" }, 400);
  }

  const date = stringValue(body.date);
  const timeSlot = stringValue(body.timeSlot);
  if (!date || !timeSlot) {
    return jsonResponse(
      {
        ok: false,
        error: "Please select delivery date and time.",
        code: "missing_delivery_selection",
      },
      422,
    );
  }

  const scheduleRules = await getScheduleRulesWithBookedCounts(
    session?.shop,
    admin,
  );
  const validation = validateDeliverySelection(scheduleRules, date, timeSlot);
  if (!validation.ok) {
    return jsonResponse(
      {
        ok: false,
        error: validation.message,
        code: validation.code,
        minDate: validation.minDate,
        maxDate: validation.maxDate,
        availableSlots: validation.availableSlots,
      },
      422,
    );
  }

  if (isMothersDayRushDate(date)) {
    const validationItems = await hydrateSubmittedCartMothersDayItems(
      admin,
      body.items,
    );
    if (!isCartEligibleForMothersDay(validationItems)) {
      return jsonResponse(
        {
          ok: false,
          error: MOTHERS_DAY_PRODUCT_ERROR_MESSAGE,
          code: "mothers_day_product_ineligible",
        },
        422,
      );
    }
  }

  return jsonResponse({
    ok: true,
    availableSlots: validation.availableSlots,
  });
};
