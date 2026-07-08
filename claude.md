# CLAUDE.md

Read in this order before touching `app/`, `extensions/`, `prisma/`,
or `shopify.app.toml`:

1. `docs/architecture.md` — system topology + data model (source of truth)
2. `docs/api.md` — routes, auth mechanisms, order write-path contract
3. `docs/known-issues.md` — don't collide with in-flight fixes
4. `docs/development.md` — commands, dev/testing/deployment notes

Rules:

- Never assume a write path — verify it in `docs/api.md` first.
- After any architectural change: update the relevant doc(s) +
  `docs/verification-log.md`, and add an entry to `docs/changelog.md`
  and/or `docs/decisions.md` if applicable.
- Courier dispatch is out of scope — handled by the official Shopify
  Lalamove app. Do not reintroduce custom Lalamove code
  (see `docs/decisions.md` ADR-1).
