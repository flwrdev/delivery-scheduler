import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { SchedulerSection } from "../modules/scheduler";
import { getSchedulerData } from "../modules/scheduler.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const data = await getSchedulerData({ admin, session });

  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
};

export default function Scheduler() {
  const data = useLoaderData();
  return <SchedulerSection data={data} />;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
