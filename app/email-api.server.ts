import { authenticate } from "./shopify.server";

type AdminContext = Awaited<ReturnType<typeof authenticate.admin>>;

export const SHOPIFY_ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

// Verifies the Shopify ID token sent by the App Home and adds the CORS
// headers its fetch needs. OPTIONS preflights and invalid tokens are answered
// inside authenticate.admin.
export async function withEmailApiAuth(
  request: Request,
  handler: (ctx: AdminContext) => Promise<Response>,
): Promise<Response> {
  const ctx = await authenticate.admin(request);
  return ctx.cors(await handler(ctx));
}

export function methodNotAllowed(): Response {
  return Response.json({ ok: false, error: "Method not allowed." }, { status: 405 });
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}
