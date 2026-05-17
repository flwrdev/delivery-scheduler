export function getSessionShop(session) {
  if (typeof session?.shop === "string" && session.shop) return session.shop;
  throw new Response("Missing authenticated shop session.", { status: 401 });
}
