import type { LoaderFunctionArgs } from "react-router";

import { getBulkActionJobStatus } from "../services/bulk-action-jobs.server";
import { authenticate } from "../shopify.server";

// Bulk-action job status poll (ADR-22 Phase B) — the client polls this every
// ~2s while a job runs. Same auth as the ops page itself; the service scopes
// by shop, and a job belonging to another shop answers exactly like a missing
// one (anti-enumeration). ADR-11 posture: always 200, `found:false` instead of
// a 404 the embedded fetcher might see mangled.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const jobId = params.jobId ?? "";
  if (!jobId) {
    return Response.json({ found: false }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const status = await getBulkActionJobStatus(session.shop, jobId);
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn(
      `[bulk-job-status] read failed for ${jobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Transient read trouble must not kill the poll loop — report not-found-
    // yet and let the next tick retry.
    return Response.json({ found: false }, { headers: { "Cache-Control": "no-store" } });
  }
};
