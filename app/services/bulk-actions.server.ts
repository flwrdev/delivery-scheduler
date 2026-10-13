// Server binding of the bulk-action executor: timezone from the schedule
// rules and the customer notice over SMTP.

import {
  executeBulkAction as executeBulkActionWith,
  type AdminGraphQLClient,
  type BulkActionItemResult,
  type BulkOpParams,
} from "./bulk-actions";
import { sendRescheduleNotice } from "./reschedule-notice.server";
import { getScheduleRules } from "./schedule-rules.server";

export * from "./bulk-actions";

export async function executeBulkAction(
  admin: AdminGraphQLClient,
  shop: string,
  params: BulkOpParams,
  orderIds: string[],
): Promise<BulkActionItemResult[]> {
  return executeBulkActionWith(admin, shop, params, orderIds, {
    getShopTimezone: async (forShop) => (await getScheduleRules(forShop)).timezone,
    sendRescheduleNotice,
  });
}
