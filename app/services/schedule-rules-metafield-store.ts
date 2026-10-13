// Shop metafield `$app.delivery_schedule_rules` (json) holding the same row
// shape the DeliveryScheduleConfig table held. Writes are compare-and-swap on
// the metafield's compareDigest.

import type { AdminGraphQLClient } from "./delivery-bookings.server";
import type {
  ScheduleRulesStore,
  StoredConfigRow,
} from "./schedule-rules.server";

export const SCHEDULE_RULES_METAFIELD_NAMESPACE = "$app";
export const SCHEDULE_RULES_METAFIELD_KEY = "delivery_schedule_rules";

const READ_QUERY = `#graphql
  query ScheduleRulesMetafield {
    shop {
      id
      metafield(namespace: "$app", key: "delivery_schedule_rules") {
        value
        compareDigest
      }
    }
  }
`;

const WRITE_MUTATION = `#graphql
  mutation ScheduleRulesMetafieldSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        compareDigest
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface ReadResponse {
  data?: {
    shop?: {
      id: string;
      metafield: { value: string; compareDigest: string } | null;
    };
  };
  errors?: Array<{ message: string }>;
}

interface WriteResponse {
  data?: {
    metafieldsSet?: {
      userErrors: Array<{ field?: string[]; message: string; code?: string }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface Snapshot {
  ownerId: string;
  row: StoredConfigRow | null;
  compareDigest: string | null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Unreadable values become invalid columns so the schema reports them as config health issues. */
export function parseStoredConfigRow(value: string): StoredConfigRow {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate: unknown = JSON.parse(value);
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  return {
    timezone: asString(parsed.timezone),
    cutoffHour: asNumber(parsed.cutoffHour),
    prepHours: asNumber(parsed.prepHours),
    maxDays: asNumber(parsed.maxDays),
    slotsJson: asString(parsed.slotsJson),
    disabledDatesJson: asString(parsed.disabledDatesJson),
    disabledSlotsJson: asString(parsed.disabledSlotsJson),
    slotCapacityJson: asString(parsed.slotCapacityJson),
    version: Number.isInteger(parsed.version) ? (parsed.version as number) : 0,
  };
}

function isStaleError(code: string | undefined): boolean {
  return typeof code === "string" && code.toUpperCase().includes("STALE");
}

export function createMetafieldScheduleRulesStore(
  admin: AdminGraphQLClient,
): ScheduleRulesStore {
  async function readSnapshot(): Promise<Snapshot> {
    const response = await admin.graphql(READ_QUERY);
    const json = (await response.json()) as ReadResponse;
    if (!response.ok || json.errors?.length || !json.data?.shop) {
      throw new Error(
        `Schedule rules metafield read failed: ${
          json.errors?.map((error) => error.message).join("; ") ?? response.status
        }`,
      );
    }

    const { id, metafield } = json.data.shop;
    return {
      ownerId: id,
      row: metafield ? parseStoredConfigRow(metafield.value) : null,
      compareDigest: metafield?.compareDigest ?? null,
    };
  }

  /** Resolves false when the compareDigest no longer matches. */
  async function write(
    ownerId: string,
    row: StoredConfigRow,
    compareDigest: string | null,
  ): Promise<boolean> {
    const response = await admin.graphql(WRITE_MUTATION, {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: SCHEDULE_RULES_METAFIELD_NAMESPACE,
            key: SCHEDULE_RULES_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(row),
            compareDigest,
          },
        ],
      },
    });
    const json = (await response.json()) as WriteResponse;
    const userErrors = json.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.some((error) => isStaleError(error.code))) {
      return false;
    }
    if (!response.ok || json.errors?.length || userErrors.length) {
      throw new Error(
        `Schedule rules metafield write failed: ${[
          ...(json.errors ?? []),
          ...userErrors,
        ]
          .map((error) => error.message)
          .join("; ") || response.status}`,
      );
    }
    return true;
  }

  return {
    async read() {
      return (await readSnapshot()).row;
    },

    async create(row) {
      const snapshot = await readSnapshot();
      if (snapshot.row) {
        return null;
      }
      return (await write(snapshot.ownerId, row, null)) ? row : null;
    },

    async update(row, expectedVersion) {
      const snapshot = await readSnapshot();
      if (!snapshot.row || snapshot.row.version !== expectedVersion) {
        return false;
      }
      return write(snapshot.ownerId, row, snapshot.compareDigest);
    },
  };
}
