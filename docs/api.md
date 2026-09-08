# API — Routes, Extensions, Auth & Write-Path Contract

> Part of the docs set. Source of truth: [architecture.md](./architecture.md). Verified against `app/routes`, `app/services`, `extensions/`, and both `shopify.app*.toml` on 2026-09-09.

API version sa `shopify.app.toml` at `shopify.app.production.toml` ay `2026-04`.

## 1. Routes at extensions

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/app` | Session-cookie (`authenticate.admin`) | Shell + navigation ng embedded app (Orders Operations, Delivery Scheduler, COD Settings, Manual order); loader lang. |
| GET | `/app/_index` | Session-cookie | Nagre-redirect papuntang `/app/orders` (o sa sanitized `returnTo`). |
| GET, POST | `/app/orders` | Session-cookie | Orders Operations page. Live Admin GraphQL read ng orders (walang local order table). Bulk ops: `archive`/`unarchive` (`orderClose`/`orderOpen`), `cancel`, `tagsAdd`/`tagsRemove`, `markFulfilled` (`fulfillmentCreate` + optional tracking URL, `notifyCustomer`, `trackingAdded` tag, `LalamoveTracking` row kapag may Lalamove Order ID), `reschedule` (shared `rescheduleOrderDelivery()`; optional plain-text email notice). Higit `BULK_INLINE_MAX` (10) orders → async `BulkActionJob`. Single-order ops: `sendEmail` (SMTP), `editDetails` (`orderUpdate` shipping address + receiver phone + tag), `markRescheduleSeen` (`$app.reschedule_seen_at`). |
| GET | `/app/orders/reschedule-rules` | Session-cookie | Schedule rules + live booked counts para sa reschedule modal. Read-only. |
| GET | `/app/orders/bulk-job/:jobId` | Session-cookie | Poll ng progress ng isang `BulkActionJob`; shop-scoped, laging 200 (`found:false` kung wala). |
| GET, POST | `/app/scheduler` | Session-cookie | Delivery schedule configuration (cutoff, prep hours, max days, slots, disabled dates/slots, capacity). Nagsusulat sa `DeliveryScheduleConfig` via granular ops sa `scheduler-ops.server.ts`, may optimistic `version` guard. |
| GET | `/app/schedule-rules` | Session-cookie | Redirect stub papuntang `/app/scheduler`. |
| GET, POST | `/app/cod-settings` | Session-cookie | COD settings. Nagsusulat ng `$app:cod-eligibility`/`function-configuration` metafield ng COD payment customization, tino-toggle ito (`paymentCustomizationUpdate`), nire-reprice ang `COD-FEE` variant (`productVariantsBulkUpdate`), at nag-mi-mirror ng fee sa `$app:cod`/`fee`, `custom`/`cod_fee`, at `_cod_fee`/`commission` shop metafields. Walang delivery-schedule state. |
| GET, POST | `/app/manual-order` | Session-cookie | Manual order form ng merchant: `draftOrderCreate` na may `Delivery Date`/`Delivery Time`/`Card Message` customAttributes, tags, at `LALAMOVE` shipping line; optional `draftOrderComplete` kapag na-verify na ang bayad. |
| GET | `/` | Wala (public) | Landing: redirect papuntang `/app` kung may `?shop=`, kung wala ay login form. |
| GET, POST | `/auth/*`, `/auth/login` | Shopify OAuth | Install/login flow. |
| GET | `/apps/schedule-rules` | App proxy (`authenticate.public.appProxy`) | Aktibong schedule rules + live booked counts + `availabilityWindow` para sa theme date/slot picker. |
| POST | `/apps/schedule-rules/validate` | App proxy (`authenticate.public.appProxy`) | Vine-validate ang isang date + slot (`validateDeliverySelection`). |
| POST | `/apps/schedule-rules/reschedule` | App proxy (`authenticate.public.appProxy`) | Vine-validate at isinusulat ang reschedule. **Walang extension o theme file sa repo na tumatawag dito**; ang customer extension ay gumagamit ng customer-account route. |
| GET | `/apps/schedule-rules/products` | Hand-verified proxy signature, walang DB | Storefront API pagination ng products ng isang collection ("Show more"); gumagamit ng `SHOPIFY_STOREFRONT_ACCESS_TOKEN`. |
| GET | `/apps/schedule-rules/coverage` | Hand-verified proxy signature + `shop` = `SHOP_DOMAIN`, walang DB | Coverage + delivery fee estimate para sa city/barangay/ZIP mula sa `delivery-coverage.server.ts`. Tinatawag ng `delivery-fee-checker` theme block. |
| GET | `/proxy/track` | App proxy (`authenticate.public.appProxy`), IP rate limit | Order status JSON (order number + email/phone match) mula sa `order-tracking.server.ts`. Naka-map lang sa DEV TOML (`/apps/track`); walang production proxy mapping. |
| POST | `/public/customer-account/schedule-rules` | Customer-account JWT (`jose`, `aud` = API key) | Rules + booked counts para sa customer-account block at reschedule modal. |
| POST | `/public/customer-account/order-delivery` | Customer-account JWT | Delivery snapshot (date, slot, status) ng isang order. |
| POST | `/public/customer-account/reschedule` | Customer-account JWT | Self-service reschedule. Chine-check ang ownership, ang `resched` lock tag, ang cutoff/lead time, at ang fulfillment status bago tawagin ang `rescheduleOrderDelivery()`. **Ang live customer write path.** |
| POST | `/api/agent/orders/draft` | Bearer `META_AGENT_API_TOKEN` (o `X-Api-Key`; `_PREV` sa rotation), 20/min | Meta Business Agent tool. Idempotent draft order (`agent-key-<key>` tag) na may delivery customAttributes, `_Messenger PSID`, `source:messenger` tag, `LALAMOVE` shipping line. `paymentMode: "cod"` → COD-FEE line + `draftOrderComplete(paymentPending: true)` pagkatapos ng NCR + amount window check. Kung hindi, ibinabalik ang `invoiceUrl`. |
| GET | `/api/agent/orders/status` | Bearer, 60/min | Order stage + delivery date/slot + tracking URL + status page / customer account links; `order` + `email` ay dapat tumugma. Lahat ng Shopify orders. |
| GET | `/api/agent/delivery/quote` | Bearer, 60/min | Coverage + fee range, COD availability at amount window, slots, at slot availability para sa optional `date`. |
| POST (webhook) | `orders/create` | Shopify HMAC (`authenticate.webhook`) | Thin receiver: kinukuha ang `Delivery Date`/`Delivery Time` mula sa order attributes at kung COD ang gateway, nagsusulat ng `DeliverySyncTask` row (frozen `checkoutTime`), nag-e-enqueue ng Cloud Tasks job, at nag-a-ack. Kapag walang queue o pumalya ang enqueue, isang inline attempt. Ang aktwal na sync at COD-fee add ay nasa worker. |
| POST (webhook) | `app/uninstalled`, `app/scopes_update` | Shopify HMAC | Lifecycle. |
| POST | `/webhooks/delivery-sync/worker` | HMAC sa raw body, header `X-Messenger-Worker-Signature`, secret `OPS_WORKER_SECRET` (fallback `MESSENGER_WORKER_SECRET`) | Cloud Tasks worker: nagke-claim ng row (lease), tapos tatlong checkpointed steps: delivery metafields (`custom.date`, `custom.time_slot`, mirrors, `delivery.sync_status`), schedule tags, COD-FEE line via order edit. Retry na may backoff hanggang 8 attempts. |
| POST | `/webhooks/bulk-action/worker` | Same HMAC scheme | Cloud Tasks worker ng `BulkActionJob`: chunk-by-chunk, checkpoint per item, nire-re-enqueue ang sarili hanggang matapos. |
| POST | `/internal/delivery-sync-sweep` | Header `x-ops-worker-secret` (same ops secret) | Nire-rescue ang stranded `DeliverySyncTask` rows at stale `BulkActionJob`s (enqueue o inline). Para tawagin ng external scheduler; ang schedule ay hindi nasa repo. |
| POST | `/internal/lalamove-poll` | Header `x-lalamove-poll-secret` (`LALAMOVE_POLL_SECRET`) | Pina-poll ang Lalamove status ng bawat hindi pa delivered na `LalamoveTracking` row; sa `COMPLETED` → `fulfillmentEventCreate` (DELIVERED) + `deliveredAt`. Para tawagin ng external scheduler. |
| POST (webhook) | `/webhooks/lalamove-tracking` | Lalamove HMAC | Best-effort push listener; ang poll ang mekanismong tumatakbo sa praktika. |
| POST | `/sidekick/tools/booked-counts` | Session-token (`authenticate.admin`) + `cors` | Booked slot counts para sa Sidekick tool. Read-only, laging 200. |
| POST | `/sidekick/tools/order-delivery` | Session-token + `cors` | Delivery info ng isang order. Read-only. |
| POST | `/sidekick/tools/schedule-config` | Session-token + `cors` | Buod ng schedule configuration. Read-only. |
| Extension | `order-delivery-block` (`admin.order-details.block.render`) | Admin session (host) | Read-only block sa Order page; isang Admin GraphQL query ng attributes at `custom.*`/`$app.*` metafields. |
| Extension | `delivery-reschedule-action` (`admin.order-details.action.render`) | Admin session | Read-only; isang `GetReschedule` query. |
| Extension | `delivery-date-editor` (`customer-account.order-status.block.render`) | Customer-account session | Read-only block; host metafields/attributes + `POST /public/customer-account/order-delivery`. |
| Extension | `delivery-reschedule-customer` (`customer-account.order.action.menu-item.render` + `…action.render`) | Customer-account session | UI na tumatawag sa `…/schedule-rules` at nagpapadala sa `/public/customer-account/reschedule`. Hardcoded production `APP_BASE_URL`. |
| Extension | `delivery-thank-you` (`purchase.thank-you.block.render`) | Wala (checkout, read-only) | Delivery schedule + COD fee explanation sa Thank You page; nagbabasa ng cart metafields at attributes. |
| Extension | `cod-fee-notice` (`purchase.thank-you.block.render`) | Wala | `COD FEE` at `Total with fee` rows kapag COD. |
| Extension | `cod-eligibility` (Shopify Function, `cart.payment-methods.transform.run`) | Shopify infra | Nagtatago/nagre-rename ng manual COD method sa labas ng NCR ZIP/city + subtotal window; config sa function-configuration metafield. |
| Extension | `delivery-sidekick-data` (`admin.app.tools.data`) | (tumatawag sa `/sidekick/tools/*`) | Tatlong read-only Sidekick tools. |
| Extension | `delivery-sidekick-actions`, `delivery-sidekick-scheduler` (`admin_link`, `admin.app.intent.link`) | N/A | Deep-link lang papuntang `/app/orders` at `/app/scheduler`. |
| Extension | `delivery-fee-checker` (theme app extension, section block) | (tumatawag sa `/apps/schedule-rules/coverage`) | Storefront delivery fee checker. Dating `storefront-chat-widget`; same uid, ang chat app-embed ay inalis. |

## 2. Order write paths

Apat na surface lang ang nagsusulat ng **delivery-schedule state** (metafields `custom.date`/`custom.time_slot` + mirrors, `$app.reschedule_*`, `delivery.reschedule_history`, delivery tags, at ang dalawang customAttributes):

1. `orders/create` sync (worker o inline) — metafields + mirrors, `delivery.sync_status`, schedule tags; COD-FEE line kapag COD.
2. `POST /public/customer-account/reschedule` — `rescheduleOrderDelivery()` na may `resched` lock tag (`source: "customer"`).
3. `/app/orders` `reschedule` op — `rescheduleOrderDelivery()` bilang merchant override (walang lock tag).
4. `POST /apps/schedule-rules/reschedule` — parehong service; walang caller sa repo.

Ibang order writers na **hindi** delivery state: `/app/orders` bulk ops (`orderClose`/`orderOpen`/`orderCancel`/`tagsAdd`/`tagsRemove`/`fulfillmentCreate`), `editDetails` (shipping address), `markRescheduleSeen` (`$app.reschedule_seen_at`), `/internal/lalamove-poll` (`fulfillmentEventCreate`), at ang dalawang order creators `/app/manual-order` at `POST /api/agent/orders/draft` (`draftOrderCreate` / `draftOrderComplete`; ang resulting order ay dumadaan sa `orders/create` sync). Lahat ng extensions, admin blocks, at Sidekick routes ay read-only.
