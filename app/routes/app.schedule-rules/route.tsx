import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import type {
  DeliveryScheduleCapacity,
  DeliveryScheduleRules,
  DeliveryScheduleSlot,
} from "../../services/schedule-rules.server";
import {
  getScheduleRulesWithBookedCounts,
  upsertScheduleRules,
} from "../../services/schedule-rules.server";
import { authenticate } from "../../shopify.server";
import styles from "./styles.module.css";

type ScheduleRulesActionData = DeliveryScheduleRules | { error: string };
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface SlotRow {
  id: string;
  display: string;
  value: string;
}

interface DisabledDateRow {
  id: string;
  date: string;
}

interface DisabledSlotRow {
  id: string;
  date: string;
  slotValue: string;
}

interface SlotCapacityRow {
  id: string;
  date: string;
  slotValue: string;
  capacity: string;
  booked: string;
}

interface ScheduleRulesFormState {
  timezone: string;
  cutoffHour: string;
  prepHours: string;
  maxDays: string;
  slots: SlotRow[];
  disabledDates: DisabledDateRow[];
  disabledSlots: DisabledSlotRow[];
  slotCapacity: SlotCapacityRow[];
}

let dynamicRowId = 0;

function jsonError(message: string, status = 400) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

function getSessionShop(session: { shop?: string } | undefined) {
  if (typeof session?.shop === "string" && session.shop) {
    return session.shop;
  }

  throw new Response("Missing authenticated shop session.", { status: 401 });
}

async function parseRulesPayload(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return jsonError("Expected an application/json request body.");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON.");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonError("Request body must be a JSON object.");
  }

  return payload as Partial<DeliveryScheduleRules>;
}

function createLoadedRowId(prefix: string, index: number) {
  return `${prefix}-${index}`;
}

function createDynamicRowId(prefix: string) {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  dynamicRowId += 1;
  return `${prefix}-${dynamicRowId}`;
}

function createEmptySlotRow(): SlotRow {
  return {
    id: createDynamicRowId("slot"),
    display: "",
    value: "",
  };
}

function createEmptyDisabledDateRow(): DisabledDateRow {
  return {
    id: createDynamicRowId("disabled-date"),
    date: "",
  };
}

function createEmptyDisabledSlotRow(slotValue = ""): DisabledSlotRow {
  return {
    id: createDynamicRowId("disabled-slot"),
    date: "",
    slotValue,
  };
}

function createEmptySlotCapacityRow(slotValue = ""): SlotCapacityRow {
  return {
    id: createDynamicRowId("slot-capacity"),
    date: "",
    slotValue,
    capacity: "",
    booked: "0",
  };
}

function toFormState(rules: DeliveryScheduleRules): ScheduleRulesFormState {
  return {
    timezone: rules.timezone,
    cutoffHour: String(rules.cutoffHour),
    prepHours: String(rules.prepHours),
    maxDays: String(rules.maxDays),
    slots: rules.slots.map((slot, index) => ({
      id: createLoadedRowId("slot", index),
      display: slot.display,
      value: slot.value,
    })),
    disabledDates: rules.disabledDates.map((date, index) => ({
      id: createLoadedRowId("disabled-date", index),
      date,
    })),
    disabledSlots: Object.entries(rules.disabledSlots).flatMap(
      ([date, slots], dateIndex) =>
        slots.map((slotValue, slotIndex) => ({
          id: createLoadedRowId(`disabled-slot-${dateIndex}`, slotIndex),
          date,
          slotValue,
        })),
    ),
    slotCapacity: Object.entries(rules.slotCapacity).flatMap(
      ([date, capacities], dateIndex) =>
        Object.entries(capacities).map(([slotValue, values], slotIndex) => ({
          id: createLoadedRowId(`slot-capacity-${dateIndex}`, slotIndex),
          date,
          slotValue,
          capacity: String(values.capacity),
          booked: String(values.booked),
        })),
    ),
  };
}

function parseIntegerField(
  value: string,
  fieldName: string,
  options: { min?: number; max?: number } = {},
) {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`${fieldName} must be a whole number.`);
  }

  if (options.min !== undefined && parsedValue < options.min) {
    throw new Error(`${fieldName} must be at least ${options.min}.`);
  }

  if (options.max !== undefined && parsedValue > options.max) {
    throw new Error(`${fieldName} must be at most ${options.max}.`);
  }

  return parsedValue;
}

function buildSlots(rows: SlotRow[]): DeliveryScheduleSlot[] {
  const slots: DeliveryScheduleSlot[] = [];
  const seenValues = new Set<string>();

  for (const row of rows) {
    const display = row.display.trim();
    const value = row.value.trim();

    if (!display && !value) {
      continue;
    }

    if (!display || !value) {
      throw new Error(
        "Each slot needs both a display label and a stored value.",
      );
    }

    if (seenValues.has(value)) {
      throw new Error(`Slot value "${value}" is duplicated.`);
    }

    seenValues.add(value);
    slots.push({ display, value });
  }

  if (!slots.length) {
    throw new Error("Add at least one delivery slot.");
  }

  return slots;
}

function buildDisabledDates(rows: DisabledDateRow[]) {
  const disabledDates: string[] = [];
  const seenDates = new Set<string>();

  for (const row of rows) {
    const date = row.date.trim();
    if (!date || seenDates.has(date)) {
      continue;
    }

    seenDates.add(date);
    disabledDates.push(date);
  }

  return disabledDates;
}

function buildDisabledSlots(
  rows: DisabledSlotRow[],
  validSlotValues: Set<string>,
) {
  const disabledSlots: Record<string, string[]> = {};

  for (const row of rows) {
    const date = row.date.trim();
    const slotValue = row.slotValue.trim();

    if (!date && !slotValue) {
      continue;
    }

    if (!date || !slotValue) {
      throw new Error("Each blocked slot entry needs both a date and a slot.");
    }

    if (!validSlotValues.has(slotValue)) {
      throw new Error(
        `Blocked slot "${slotValue}" must match an existing delivery slot value.`,
      );
    }

    disabledSlots[date] ??= [];
    if (!disabledSlots[date].includes(slotValue)) {
      disabledSlots[date].push(slotValue);
    }
  }

  return disabledSlots;
}

function buildSlotCapacity(
  rows: SlotCapacityRow[],
  validSlotValues: Set<string>,
): Record<string, Record<string, DeliveryScheduleCapacity>> {
  const slotCapacity: Record<
    string,
    Record<string, DeliveryScheduleCapacity>
  > = {};

  for (const row of rows) {
    const date = row.date.trim();
    const slotValue = row.slotValue.trim();
    const capacityValue = row.capacity.trim();

    if (!date && !slotValue && !capacityValue) {
      continue;
    }

    if (!date || !slotValue || !capacityValue) {
      throw new Error(
        "Each slot capacity entry needs a date, slot, and capacity.",
      );
    }

    if (!validSlotValues.has(slotValue)) {
      throw new Error(
        `Capacity slot "${slotValue}" must match an existing delivery slot value.`,
      );
    }

    const capacity = parseIntegerField(
      capacityValue,
      `Capacity for ${slotValue} on ${date}`,
      { min: 0 },
    );
    slotCapacity[date] ??= {};
    if (slotCapacity[date][slotValue]) {
      throw new Error(
        `Capacity for ${slotValue} on ${date} is defined more than once.`,
      );
    }

    // Booked counts are overlaid from live orders on read; do not persist a stale snapshot.
    slotCapacity[date][slotValue] = { capacity, booked: 0 };
  }

  return slotCapacity;
}

function buildPayload(
  formState: ScheduleRulesFormState,
): DeliveryScheduleRules {
  const timezone = formState.timezone.trim();
  if (!timezone) {
    throw new Error("Timezone is required.");
  }

  const slots = buildSlots(formState.slots);
  const validSlotValues = new Set(slots.map((slot) => slot.value));

  return {
    timezone,
    cutoffHour: parseIntegerField(formState.cutoffHour, "Cutoff hour", {
      min: 0,
      max: 23,
    }),
    prepHours: parseIntegerField(formState.prepHours, "Prep hours", { min: 0 }),
    maxDays: parseIntegerField(formState.maxDays, "Max days", { min: 1 }),
    slots,
    disabledDates: buildDisabledDates(formState.disabledDates),
    disabledSlots: buildDisabledSlots(formState.disabledSlots, validSlotValues),
    slotCapacity: buildSlotCapacity(formState.slotCapacity, validSlotValues),
  };
}

function isActionError(data: unknown): data is { error: string } {
  return !!data && typeof data === "object" && "error" in data;
}

function formatCutoffTimeSummary(value: string) {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue < 0 || parsedValue > 23) {
    return value ? `${value}:00` : "Not set";
  }

  const suffix = parsedValue >= 12 ? "PM" : "AM";
  const hour = parsedValue % 12 || 12;

  return `${hour}:00 ${suffix}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = getSessionShop(session);
  const scheduleRules = await getScheduleRulesWithBookedCounts(shop, admin);

  return Response.json(
    { rules: scheduleRules },
    { headers: { "Cache-Control": "no-store" } },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!["POST", "PUT"].includes(request.method.toUpperCase())) {
    return jsonError("Method not allowed.", 405);
  }

  const { admin, session } = await authenticate.admin(request);
  const shop = getSessionShop(session);

  const payload = await parseRulesPayload(request);

  if (payload instanceof Response) {
    return payload;
  }

  await upsertScheduleRules(shop, payload);
  const scheduleRules = await getScheduleRulesWithBookedCounts(shop, admin);

  return Response.json(scheduleRules, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
};

export default function ScheduleRulesPage() {
  const loaderData = useLoaderData() as {
    rules: DeliveryScheduleRules;
  };
  const scheduleRules = loaderData.rules;
  const fetcher = useFetcher<ScheduleRulesActionData>();
  const shopify = useAppBridge();
  const [formState, setFormState] = useState<ScheduleRulesFormState>(() =>
    toFormState(scheduleRules),
  );
  const [clientError, setClientError] = useState<string | null>(null);

  const isSaving =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const slotOptions = Array.from(
    new Set(formState.slots.map((slot) => slot.value.trim()).filter(Boolean)),
  );
  const slotLabelsByValue = new Map(
    formState.slots
      .map((slot) => [slot.value.trim(), slot.display.trim()] as const)
      .filter(([value]) => Boolean(value)),
  );
  const activeSlotCount = formState.slots.filter(
    (slot) => slot.display.trim() || slot.value.trim(),
  ).length;
  const blockedDateCount = formState.disabledDates.filter(
    (row) => row.date.trim(),
  ).length;
  const blockedSlotCount = formState.disabledSlots.filter(
    (row) => row.date.trim() && row.slotValue.trim(),
  ).length;
  const capacityRuleCount = formState.slotCapacity.filter(
    (row) => row.date.trim() && row.slotValue.trim() && row.capacity.trim(),
  ).length;

  useEffect(() => {
    setFormState(toFormState(loaderData.rules));
  }, [loaderData]);

  useEffect(() => {
    if (!fetcher.data) {
      return;
    }

    if (isActionError(fetcher.data)) {
      setClientError(fetcher.data.error);
      shopify.toast.show(fetcher.data.error, { isError: true });
      return;
    }

    setClientError(null);
    setFormState(toFormState(fetcher.data));
    shopify.toast.show("Schedule rules saved");
  }, [fetcher.data, shopify]);

  useEffect(() => {
    const { hash } = window.location;
    if (hash) {
      const target = document.querySelector(hash);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  function updateField(field: keyof ScheduleRulesFormState, value: string) {
    setFormState((currentState) => ({
      ...currentState,
      [field]: value,
    }));
  }

  function updateSlotRow(
    id: string,
    field: keyof Omit<SlotRow, "id">,
    value: string,
  ) {
    setFormState((currentState) => ({
      ...currentState,
      slots: currentState.slots.map((row) =>
        row.id === id ? { ...row, [field]: value } : row,
      ),
    }));
  }

  function updateDisabledDateRow(id: string, value: string) {
    setFormState((currentState) => ({
      ...currentState,
      disabledDates: currentState.disabledDates.map((row) =>
        row.id === id ? { ...row, date: value } : row,
      ),
    }));
  }

  function updateDisabledSlotRow(
    id: string,
    field: keyof Omit<DisabledSlotRow, "id">,
    value: string,
  ) {
    setFormState((currentState) => ({
      ...currentState,
      disabledSlots: currentState.disabledSlots.map((row) =>
        row.id === id ? { ...row, [field]: value } : row,
      ),
    }));
  }

  function updateSlotCapacityRow(
    id: string,
    field: keyof Omit<SlotCapacityRow, "id">,
    value: string,
  ) {
    setFormState((currentState) => ({
      ...currentState,
      slotCapacity: currentState.slotCapacity.map((row) =>
        row.id === id ? { ...row, [field]: value } : row,
      ),
    }));
  }

  function addSlotRow() {
    setFormState((currentState) => ({
      ...currentState,
      slots: [...currentState.slots, createEmptySlotRow()],
    }));
  }

  function addDisabledDateRow() {
    setFormState((currentState) => ({
      ...currentState,
      disabledDates: [
        ...currentState.disabledDates,
        createEmptyDisabledDateRow(),
      ],
    }));
  }

  function addDisabledSlotRow() {
    setFormState((currentState) => ({
      ...currentState,
      disabledSlots: [
        ...currentState.disabledSlots,
        createEmptyDisabledSlotRow(slotOptions[0] ?? ""),
      ],
    }));
  }

  function addSlotCapacityRow() {
    setFormState((currentState) => ({
      ...currentState,
      slotCapacity: [
        ...currentState.slotCapacity,
        createEmptySlotCapacityRow(slotOptions[0] ?? ""),
      ],
    }));
  }

  function removeSlotRow(id: string) {
    setFormState((currentState) => ({
      ...currentState,
      slots: currentState.slots.filter((row) => row.id !== id),
    }));
  }

  function removeDisabledDateRow(id: string) {
    setFormState((currentState) => ({
      ...currentState,
      disabledDates: currentState.disabledDates.filter((row) => row.id !== id),
    }));
  }

  function removeDisabledSlotRow(id: string) {
    setFormState((currentState) => ({
      ...currentState,
      disabledSlots: currentState.disabledSlots.filter((row) => row.id !== id),
    }));
  }

  function removeSlotCapacityRow(id: string) {
    setFormState((currentState) => ({
      ...currentState,
      slotCapacity: currentState.slotCapacity.filter((row) => row.id !== id),
    }));
  }

  function getSlotSelectOptions(currentValue: string) {
    if (currentValue && !slotOptions.includes(currentValue)) {
      return [currentValue, ...slotOptions];
    }

    return slotOptions;
  }

  function getSlotOptionLabel(slotValue: string) {
    const display = slotLabelsByValue.get(slotValue);
    if (!display || display === slotValue) {
      return slotValue;
    }

    return `${display} (${slotValue})`;
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      const payload = buildPayload(formState);

      setClientError(null);
      fetcher.submit(payload as unknown as JsonObject, {
        method: "POST",
        encType: "application/json",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to save rules.";
      setClientError(message);
    }
  }

  return (
    <s-page heading="Delivery Schedule Settings">
      <div className={styles.pageFrame}>
        <s-section heading="Available dates and time slots">
          <s-paragraph>
            Control which delivery dates and time slots customers can choose at
            checkout.
          </s-paragraph>
        </s-section>

        <div className={styles.pageLayout}>
          <div className={styles.sideColumn}>
            <div className={styles.stickySidebar}>
              <div className={styles.sidebarStack}>
                <s-section heading="Current settings summary">
                  <div className={styles.summaryGrid}>
                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>Timezone</span>
                      <strong className={styles.metricValue}>
                        {formState.timezone || "Not set"}
                      </strong>
                    </div>

                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>
                        Same-day cutoff
                      </span>
                      <strong className={styles.metricValue}>
                        {formatCutoffTimeSummary(formState.cutoffHour)}
                      </strong>
                    </div>

                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>
                        Preparation time
                      </span>
                      <strong className={styles.metricValue}>
                        {formState.prepHours || "0"} hr
                      </strong>
                    </div>

                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>Booking window</span>
                      <strong className={styles.metricValue}>
                        {formState.maxDays || "0"} days
                      </strong>
                    </div>

                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>Delivery slots</span>
                      <strong className={styles.metricValue}>
                        {activeSlotCount}
                      </strong>
                    </div>

                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>Blocked dates</span>
                      <strong className={styles.metricValue}>
                        {blockedDateCount}
                      </strong>
                    </div>

                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>Blocked slots</span>
                      <strong className={styles.metricValue}>
                        {blockedSlotCount}
                      </strong>
                    </div>

                    <div className={styles.metricCard}>
                      <span className={styles.metricLabel}>
                        Capacity limits
                      </span>
                      <strong className={styles.metricValue}>
                        {capacityRuleCount}
                      </strong>
                    </div>
                  </div>
                </s-section>

                <s-section heading="Editing tips">
                  <s-paragraph>
                    Use Internal value as the stable name for each time slot.
                    Update blocked slots and capacity rules before changing it.
                  </s-paragraph>
                  <s-paragraph>
                    Leave unused rows blank. Duplicate slots or duplicate
                    capacity rows cannot be saved.
                  </s-paragraph>
                </s-section>
              </div>
            </div>
          </div>

          <div className={styles.mainColumn}>
            <s-section heading="Delivery settings">
              <form onSubmit={handleSubmit}>
                <s-stack direction="block" gap="base">
                  <div className={styles.editorSection}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <h3 className={styles.sectionHeading}>
                          Basic delivery rules
                        </h3>
                        <p className={styles.sectionDescription}>
                          Set the store timezone, same-day cutoff, preparation
                          time, and booking window.
                        </p>
                      </div>
                    </div>

                    <s-text-field
                      id="section-defaults"
                      label="Timezone"
                      value={formState.timezone}
                      onChange={(event) =>
                        updateField("timezone", event.currentTarget.value)
                      }
                      details="This time zone is used to decide which delivery dates and times are available."
                    ></s-text-field>

                    <s-stack direction="inline" gap="base">
                      <s-text-field
                        label="Same-day cutoff time"
                        value={formState.cutoffHour}
                        onChange={(event) =>
                          updateField("cutoffHour", event.currentTarget.value)
                        }
                        details="Whole number from 0 to 23"
                      ></s-text-field>

                      <s-text-field
                        label="Preparation time"
                        value={formState.prepHours}
                        onChange={(event) =>
                          updateField("prepHours", event.currentTarget.value)
                        }
                        details="Whole number"
                      ></s-text-field>

                      <s-text-field
                        label="How many days ahead customers can choose"
                        value={formState.maxDays}
                        onChange={(event) =>
                          updateField("maxDays", event.currentTarget.value)
                        }
                        details="Whole number"
                      ></s-text-field>
                    </s-stack>
                  </div>

                  <div id="section-slots" className={styles.editorSection}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <h3 className={styles.sectionHeading}>
                          Delivery time slots
                        </h3>
                        <p className={styles.sectionDescription}>
                          Add the delivery windows customers can choose at
                          checkout.
                        </p>
                      </div>
                      <s-button
                        type="button"
                        variant="secondary"
                        onClick={addSlotRow}
                      >
                        Add slot
                      </s-button>
                    </div>

                    <div className={styles.rowList}>
                      {formState.slots.map((row) => (
                        <div key={row.id} className={styles.rowCard}>
                          <div className={styles.rowFields}>
                            <label className={styles.fieldLabel}>
                              <span className={styles.fieldLabelText}>
                                Display label
                              </span>
                              <input
                                className={styles.fieldInput}
                                type="text"
                                value={row.display}
                                onChange={(event) =>
                                  updateSlotRow(
                                    row.id,
                                    "display",
                                    event.currentTarget.value,
                                  )
                                }
                              />
                            </label>

                            <label className={styles.fieldLabel}>
                              <span className={styles.fieldLabelText}>
                                Internal value
                              </span>
                              <input
                                className={styles.fieldInput}
                                type="text"
                                value={row.value}
                                onChange={(event) =>
                                  updateSlotRow(
                                    row.id,
                                    "value",
                                    event.currentTarget.value,
                                  )
                                }
                              />
                              <span className={styles.metricMeta}>
                                Keep this stable. Changing it may affect blocked
                                slots and capacity rules.
                              </span>
                            </label>
                          </div>

                          <div className={styles.rowActions}>
                            <s-button
                              type="button"
                              variant="tertiary"
                              onClick={() => removeSlotRow(row.id)}
                            >
                              Remove slot
                            </s-button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div
                    id="section-blocked-dates"
                    className={styles.editorSection}
                  >
                    <div className={styles.sectionHeader}>
                      <div>
                        <h3 className={styles.sectionHeading}>
                          Blocked delivery dates
                        </h3>
                        <p className={styles.sectionDescription}>
                          Close delivery for full days, such as holidays or
                          unavailable dates.
                        </p>
                      </div>
                      <s-button
                        type="button"
                        variant="secondary"
                        onClick={addDisabledDateRow}
                      >
                        Add blocked date
                      </s-button>
                    </div>

                    {formState.disabledDates.length ? (
                      <div className={styles.rowList}>
                        {formState.disabledDates.map((row) => (
                          <div key={row.id} className={styles.rowCard}>
                            <div className={styles.rowFields}>
                              <label className={styles.fieldLabel}>
                                <span className={styles.fieldLabelText}>
                                  Date
                                </span>
                                <input
                                  className={styles.fieldInput}
                                  type="date"
                                  value={row.date}
                                  onChange={(event) =>
                                    updateDisabledDateRow(
                                      row.id,
                                      event.currentTarget.value,
                                    )
                                  }
                                />
                              </label>
                            </div>

                            <div className={styles.rowActions}>
                              <s-button
                                type="button"
                                variant="tertiary"
                                onClick={() => removeDisabledDateRow(row.id)}
                              >
                                Remove date
                              </s-button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.emptyState}>No blocked dates yet.</p>
                    )}
                  </div>

                  <div
                    id="section-blocked-slots"
                    className={styles.editorSection}
                  >
                    <div className={styles.sectionHeader}>
                      <div>
                        <h3 className={styles.sectionHeading}>
                          Blocked time slots
                        </h3>
                        <p className={styles.sectionDescription}>
                          Close one delivery window on a specific date while
                          keeping other times open.
                        </p>
                      </div>
                      <s-button
                        type="button"
                        variant="secondary"
                        onClick={addDisabledSlotRow}
                        {...(slotOptions.length === 0
                          ? { disabled: true }
                          : {})}
                      >
                        Add blocked slot
                      </s-button>
                    </div>

                    {!slotOptions.length && (
                      <p className={styles.emptyState}>
                        Add at least one delivery slot before creating
                        blocked-slot rules.
                      </p>
                    )}

                    {formState.disabledSlots.length ? (
                      <div className={styles.rowList}>
                        {formState.disabledSlots.map((row) => (
                          <div key={row.id} className={styles.rowCard}>
                            <div className={styles.rowFields}>
                              <label className={styles.fieldLabel}>
                                <span className={styles.fieldLabelText}>
                                  Date
                                </span>
                                <input
                                  className={styles.fieldInput}
                                  type="date"
                                  value={row.date}
                                  onChange={(event) =>
                                    updateDisabledSlotRow(
                                      row.id,
                                      "date",
                                      event.currentTarget.value,
                                    )
                                  }
                                />
                              </label>

                              <label className={styles.fieldLabel}>
                                <span className={styles.fieldLabelText}>
                                  Time slot
                                </span>
                                <select
                                  className={styles.fieldInput}
                                  value={row.slotValue}
                                  onChange={(event) =>
                                    updateDisabledSlotRow(
                                      row.id,
                                      "slotValue",
                                      event.currentTarget.value,
                                    )
                                  }
                                >
                                  <option value="">Select a slot</option>
                                  {getSlotSelectOptions(row.slotValue).map(
                                    (slotValue) => (
                                      <option key={slotValue} value={slotValue}>
                                        {getSlotOptionLabel(slotValue)}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </label>
                            </div>

                            <div className={styles.rowActions}>
                              <s-button
                                type="button"
                                variant="tertiary"
                                onClick={() => removeDisabledSlotRow(row.id)}
                              >
                                Remove blocked slot
                              </s-button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.emptyState}>
                        No blocked time slots yet.
                      </p>
                    )}
                  </div>

                  <div
                    id="section-slot-capacities"
                    className={styles.editorSection}
                  >
                    <div className={styles.sectionHeader}>
                      <div>
                        <h3 className={styles.sectionHeading}>
                          Daily slot capacity
                        </h3>
                        <p className={styles.sectionDescription}>
                          Set how many orders can be accepted for a delivery
                          window on a date.
                        </p>
                      </div>
                      <s-button
                        type="button"
                        variant="secondary"
                        onClick={addSlotCapacityRow}
                        {...(slotOptions.length === 0
                          ? { disabled: true }
                          : {})}
                      >
                        Add capacity rule
                      </s-button>
                    </div>

                    {!slotOptions.length && (
                      <p className={styles.emptyState}>
                        Add at least one delivery slot before creating capacity
                        rules.
                      </p>
                    )}

                    {formState.slotCapacity.length ? (
                      <div className={styles.rowList}>
                        {formState.slotCapacity.map((row) => (
                          <div key={row.id} className={styles.rowCard}>
                            <div className={styles.rowFields}>
                              <label className={styles.fieldLabel}>
                                <span className={styles.fieldLabelText}>
                                  Date
                                </span>
                                <input
                                  className={styles.fieldInput}
                                  type="date"
                                  value={row.date}
                                  onChange={(event) =>
                                    updateSlotCapacityRow(
                                      row.id,
                                      "date",
                                      event.currentTarget.value,
                                    )
                                  }
                                />
                              </label>

                              <label className={styles.fieldLabel}>
                                <span className={styles.fieldLabelText}>
                                  Time slot
                                </span>
                                <select
                                  className={styles.fieldInput}
                                  value={row.slotValue}
                                  onChange={(event) =>
                                    updateSlotCapacityRow(
                                      row.id,
                                      "slotValue",
                                      event.currentTarget.value,
                                    )
                                  }
                                >
                                  <option value="">Select a slot</option>
                                  {getSlotSelectOptions(row.slotValue).map(
                                    (slotValue) => (
                                      <option key={slotValue} value={slotValue}>
                                        {getSlotOptionLabel(slotValue)}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </label>

                              <label className={styles.fieldLabel}>
                                <span className={styles.fieldLabelText}>
                                  Capacity
                                </span>
                                <input
                                  className={styles.fieldInput}
                                  type="number"
                                  min="0"
                                  step="1"
                                  value={row.capacity}
                                  onChange={(event) =>
                                    updateSlotCapacityRow(
                                      row.id,
                                      "capacity",
                                      event.currentTarget.value,
                                    )
                                  }
                                />
                              </label>

                              <div className={styles.metricCard}>
                                <span className={styles.metricLabel}>
                                  Live booked
                                </span>
                                <strong className={styles.metricValue}>
                                  {row.booked || "0"}
                                </strong>
                                <span className={styles.metricMeta}>
                                  Current order count
                                </span>
                              </div>
                            </div>

                            <div className={styles.rowActions}>
                              <s-button
                                type="button"
                                variant="tertiary"
                                onClick={() => removeSlotCapacityRow(row.id)}
                              >
                                Remove capacity rule
                              </s-button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className={styles.emptyState}>
                        No capacity rules yet.
                      </p>
                    )}
                  </div>

                  {(clientError ||
                    (fetcher.data && isActionError(fetcher.data))) && (
                    <p className={styles.errorText}>
                      {clientError ||
                        (isActionError(fetcher.data) ? fetcher.data.error : "")}
                    </p>
                  )}

                  <s-stack direction="inline" gap="base">
                    <s-button
                      type="submit"
                      {...(isSaving ? { loading: true } : {})}
                    >
                      Save rules
                    </s-button>
                    <s-button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setClientError(null);
                        setFormState(toFormState(loaderData.rules));
                      }}
                    >
                      Reset
                    </s-button>
                  </s-stack>
                </s-stack>
              </form>
            </s-section>
          </div>
        </div>
      </div>
    </s-page>
  );
}
