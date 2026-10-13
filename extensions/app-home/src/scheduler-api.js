import { getScheduleRulesDetailed } from "../../../app/services/schedule-rules.server";
import {
  getTodayInTimezone,
  runSchedulerOp,
} from "../../../app/services/scheduler-ops.server";
import { createMetafieldScheduleRulesStore } from "../../../app/services/schedule-rules-metafield-store";
import { adminClient, getShopDomain } from "./admin-client";

export const scheduleRulesStore = createMetafieldScheduleRulesStore(adminClient);
const store = scheduleRulesStore;

function toPageState(detailed) {
  return {
    rules: detailed.rules,
    version: detailed.version,
    configHealth: detailed.configHealth,
    countsMeta: detailed.countsMeta,
    today: getTodayInTimezone(detailed.rules.timezone),
  };
}

async function loadDetailed(options = {}) {
  const shop = await getShopDomain();
  return getScheduleRulesDetailed(shop, adminClient, { ...options, store });
}

export async function loadSchedulerState() {
  return toPageState(await loadDetailed());
}

/** Same envelope the /app/scheduler action returned: always {ok, op, …}. */
export async function submitSchedulerOp(op, body) {
  try {
    const shop = await getShopDomain();
    if (!shop) {
      return { ok: false, op, code: "error", message: "No shop session. Reload the page." };
    }

    if (op === "refreshCounts") {
      const detailed = await loadDetailed({ bypassCountsCache: true });
      return { ok: true, op, ...toPageState(detailed) };
    }

    const version = body.version;
    if (typeof version !== "number" || !Number.isInteger(version)) {
      return {
        ok: false,
        op,
        code: "error",
        message: "Missing config version. Reload the page.",
      };
    }

    const result = await runSchedulerOp(shop, store, op, body, version);

    if (result.ok) {
      return { ok: true, op, ...toPageState(await loadDetailed()) };
    }

    if (result.code === "stale_config") {
      return {
        ok: false,
        op,
        code: "stale_config",
        ...toPageState(await loadDetailed()),
      };
    }

    if (result.code === "unknown_op") {
      return { ok: false, op, code: "unknown_op", message: `Unknown action "${op}".` };
    }

    return { ok: false, op, code: "validation", fieldErrors: result.fieldErrors };
  } catch (error) {
    console.error(`Scheduler op "${op}" failed:`, error);
    return { ok: false, op, code: "error", message: "Saving failed upstream. Try again." };
  }
}
