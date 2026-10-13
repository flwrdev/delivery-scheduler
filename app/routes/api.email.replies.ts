import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { methodNotAllowed, withEmailApiAuth } from "../email-api.server";
import { listUnseenReplies } from "../services/customer-inbox.server";

// GET /api/email/replies: unseen customer replies matched to orders, for the
// App Home notifications bell.
export const loader = ({ request }: LoaderFunctionArgs) =>
  withEmailApiAuth(request, async ({ admin }) => {
    const result = await listUnseenReplies(admin);
    if (!result.ok) {
      console.warn(`[api/email/replies] ${result.error}`);
    }
    return Response.json(result);
  });

// Answers the CORS preflight; any other method is rejected.
export const action = ({ request }: ActionFunctionArgs) =>
  withEmailApiAuth(request, async () => methodNotAllowed());
