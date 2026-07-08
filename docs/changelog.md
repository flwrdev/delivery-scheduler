# Changelog

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).

Human-readable, newest-first narrative of the architecture history. Each line is a plain-English summary; the authoritative detail (with verifier notes) lives in the matching row of [verification-log.md](./verification-log.md).

- **2026-07-04 (restructure)** — Split the monolithic `docs/architecture.md` + `CLAUDE.md` into a focused 7-file docs set (`architecture`, `api`, `verification-log`, `decisions`, `changelog`, `known-issues`, `development`) plus a slimmed `CLAUDE.md`; merged the old `decision-log.md` into `decisions.md`. → [full entry](./verification-log.md)

- **2026-07-04** — Removed the custom Lalamove courier integration entirely; courier dispatch is now handled by the official Shopify Lalamove app. Reminder: rotate/revoke the leaked Lalamove + Google Maps keys at their providers (see [known-issues.md](./known-issues.md)). → [full entry](./verification-log.md)

- **2026-07-02** — Fixed a double cold-start bug on the product-pagination proxy route by switching to manual App Proxy signature verification + the Storefront API (dropping the Prisma/Neon session lookup). → [full entry](./verification-log.md) · [ADR-2](./decisions.md) · [ADR-3](./decisions.md)

- **2026-06-16** — Added read-only collection product pagination via App Proxy + a theme "Load More" button. → [full entry](./verification-log.md)

- **2026-06-07** (two entries) — Lalamove dispatch hardening (constant centralization, coordinate sanitization, error-message tidy-up, dispatch-modal a11y — dispatch code later removed); order drawer UI redesign into a Lalamove-style panel (later partly removed). → [full entry](./verification-log.md) · [ADR-4](./decisions.md)

- **2026-06-06** — Full re-verification sweep: removed two stale files (`app.dashboard.jsx`, `delivery-orders.server.ts`), added an `orders/cancelled` webhook and a Lalamove callback endpoint (both later removed 2026-07-04). → [full entry](./verification-log.md)

- **2026-05-23** (two entries) — Confirmed the Admin order-page extensions are read-only; diagram cleanup + dead-code removal, and added the enforcement skill. → [full entry](./verification-log.md)

- **2026-05-22** — Initial full architecture sweep across extensions, routes, services, Prisma schema, and order metafields/tags. → [full entry](./verification-log.md)
