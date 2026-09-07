# API — Routes, Extensions, Auth & Write-Path Contract

> Part of the docs set. Source of truth: [architecture.md](./architecture.md).

API version sa `shopify.app.toml` ay `2026-04`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/app` | Session-cookie (`authenticate.admin`) | Shell + navigation ng embedded app; loader lang. |
| GET | `/app/_index` | Session-cookie | Nagre-redirect papuntang `/app/orders`, ang default na landing page ng app. |
| GET, POST | `/app/orders` | Session-cookie | Pangunahing Orders Operations page — listahan ng orders na may filter/search/tabs. Ang action ay sumusuporta sa maraming ops: `orderClose`/`orderOpen` (archive/unarchive), `orderCancel`, `tagsAdd`/`tagsRemove`, `fulfillmentCreate` (mark fulfilled + optional Lalamove tracking id), `reschedule` (nagsusulat ng `custom.date`/`custom.time_slot` metafields + legacy mirror metafields + delivery schedule tags + `delivery.reschedule_history` + customAttributes), `sendEmail` (SMTP send sa customer,), `editDetails` (nag-a-update ng shipping address fields via `orderUpdate`), at `markRescheduleSeen` (nagsusulat ng `$app.reschedule_seen_at` metafield). Malaking bulk selection (>10 orders) ay tumatakbo bilang async `BulkActionJob` sa halip na inline. |
| GET | `/app/orders/reschedule-rules` | Session-cookie | Nagbabalik ng delivery schedule rules + live booked counts, ginagamit ng reschedule modal. |
| GET, POST | `/app/scheduler` | Session-cookie | Delivery schedule configuration page (settings, time slots, date overrides, capacity). Ang action ay nagsusulat sa `DeliveryScheduleConfig` (Postgres); . |
| GET | `/app/schedule-rules` | Session-cookie | Redirect stub papuntang `/app/scheduler`. |
| GET, POST | `/app/cod-settings` | Session-cookie | Configuration page para sa COD (Cash on Delivery) fee amount at toggle. Ang action ay nag-a-update ng `function-configuration` metafield ng COD payment customization, tino-toggle ang customization, at ina-update ang presyo ng COD Fee variant; nagsusulat din ng display-copy metafields para sa Thank You extensions at Liquid. Walang hinahawakang delivery-schedule state. |
| GET | `/` | Wala (public) | Root index — nagre-redirect papuntang `/app` kung may `?shop=` param, kung wala nagpapakita ng landing/login form. |
| GET, POST | `/auth/*` | Shopify OAuth | Auth boundary ng Shopify app install/login flow. |
| GET | `/auth/login` | Wala | Non-embedded login form. |
| GET | `/apps/schedule-rules` | App proxy signature | Kinukuha ang aktibong scheduling rules na ipapakita sa storefront |
| POST | `/apps/schedule-rules/validate` | App proxy signature | Vine-verify kung valid ang napiling delivery date/time bago i-submit ang order |
| POST | `/apps/schedule-rules/reschedule` | App proxy signature | Nagpo-process ng reschedule request mula sa customer-facing widget |
| GET | `/apps/schedule-rules/products` | App proxy signature | Nag-rereturn ng listahan ng mga products na may kani-kanilang delivery rules |
| POST | `/apps/schedule-rules/support-chat` | App proxy signature | Nagsisimula ng support chat session mula sa storefront |
| GET | `/apps/schedule-rules/support-chat/:jobId` | App proxy signature | Kinukuha ang status o resulta ng isang naka-queue na chat job |
| GET | `/apps/schedule-rules/widget-config` | App proxy signature | Nag-serve ng configuration para sa delivery widget na ipinapakita sa customer |
| GET | `/apps/schedule-rules/coverage` | App proxy signature | Ini-expose ang mga covered na lugar o zip codes para sa delivery |
| POST | `/public/customer-account/schedule-rules` | Customer-account JWT | Nagbabalik ng schedule rules + booked counts para sa customer-account block at reschedule modal. |
| POST | `/public/customer-account/order-delivery` | Customer-account JWT | Nagbabalik ng kasalukuyang delivery snapshot (date, slot, status) ng isang order. |
| POST | `/public/customer-account/reschedule` | Customer-account JWT | Pinoproseso ang self-service reschedule ng customer — sinusuri ang ownership at eligibility bago isulat ang `custom.date`/`custom.time_slot` metafields, `delivery.reschedule_history`, tags, at customAttributes. |
| POST (webhook) | `orders/create` | Shopify HMAC | Kinukuha ang bagong order, kinukuha ang delivery attributes mula sa cart, isinusulat ang isang `DeliverySyncTask` row (Postgres), at nag-e-enqueue ng sync worker. Ang aktwal na metafield/tag sync ay nangyayari sa worker (row 25 sa ibaba). Kapag COD ang bayad, dinadagdag din ang COD Fee line item sa order. |
| POST (webhook) | `app/uninstalled` | Shopify HMAC | Tumatakbo kapag na-uninstall ang app. |
| POST (webhook) | `app/scopes_update` | Shopify HMAC | Tumatakbo kapag nagbago ang mga granted access scope. |
| POST | `/webhooks/delivery-sync/worker` | HMAC (`OPS_WORKER_SECRET`, fallback `MESSENGER_WORKER_SECRET`) | Cloud Tasks worker na tumatakbo ng aktwal na delivery sync: nagsusulat ng `custom.date`, `custom.time_slot`, legacy mirror metafields, `delivery.sync_status`, at ng schedule tags; per-step checkpoint na may retry. |
| POST | `/webhooks/bulk-action/worker` | Same HMAC scheme | Cloud Tasks worker na nagpoproseso ng bulk order action chunks (≤15 items kada tawag), nag-che-checkpoint per item, at nire-re-enqueue ang sarili hanggang matapos ang job. |
| GET | `/app/orders/bulk-job/:jobId` | Session-cookie | Pinopoll ng client ang progress/resulta ng isang bulk action job. |
| POST | `/internal/delivery-sync-sweep` | Shared-secret header | Hourly sweep na nag-re-rescue ng stranded `DeliverySyncTask` rows at `BulkActionJob`s (backstop, hindi primary mechanism). |
| POST | `/internal/lalamove-poll` | Shared-secret header (`LALAMOVE_POLL_SECRET`) | Pina-poll ang Lalamove Open API status ng mga naka-track na order (via merchant-pasted Order ID) at nagma-mark ng fulfillment bilang Delivered. |
| POST (webhook) | `/webhooks/lalamove-tracking` | Lalamove HMAC | Tumatanggap ng Lalamove status push events (best-effort lang — ang poller sa itaas ang aktwal na pangunahing mekanismo). |
| POST | `/internal/chat-retention` | Shared-secret header | Nightly purge ng lumang `SupportChat*`/`AgentRateLimit`/`LookupAttempt` rows sa Postgres. Walang Shopify API call. |
| GET | `/webhooks/messenger` | `hub.verify_token` | Webhook verification handshake ni Meta. |
| POST (webhook) | `/webhooks/messenger` | Meta HMAC | Tumatanggap ng Messenger events (bagong mensahe, echo); nire-record sa Postgres at nag-e-enqueue ng reply task. |
| POST | `/webhooks/messenger/worker` | HMAC (`MESSENGER_WORKER_SECRET`) | Cloud Tasks worker na nagpapadala ng aktwal na Messenger reply sa customer. |
| GET, POST | `/app/messenger-orders` | Session-cookie | Admin page: listahan ng Messenger-tagged orders, per-thread Pause/Resume ng bot, at `setupProfile` op (Messenger Profile API — Get Started, ice breakers, persistent menu). |
| POST | `/sidekick/tools/booked-counts` | Session-token (`authenticate.admin`, cross-origin) | Nagbabalik ng booked slot counts para sa Sidekick tool. Read-only. |
| POST | `/sidekick/tools/order-delivery` | Session-token | Nagbabalik ng delivery info ng isang partikular na order. Read-only. |
| POST | `/sidekick/tools/schedule-config` | Session-token | Nagbabalik ng buod ng schedule configuration. Read-only. |
| POST | `/api/support-chat` | Customer-account JWT | Nagsisimula ng bagong support chat turn mula sa customer-account extension; nire-record at nine-enqueue, hindi naghihintay sa LLM. |
| GET | `/api/support-chat/:jobId` | Customer-account JWT | Pinopoll ang status/resulta (pending/done/failed) ng isang naka-queue na chat job. |
| POST | `/webhooks/support-chat/worker` | HMAC (`MESSENGER_WORKER_SECRET`) | Cloud Tasks worker na tumatakbo ng LLM turn — ginagamit ng parehong customer-account at storefront chat channels. |
| Extension | `order-delivery-block` (`admin.order-details.block.render`) | Admin session (host-provided) | Read-only block sa Shopify Order page; nagbabasa ng delivery metafields/attrs. |
| Extension | `delivery-reschedule-action` (`admin.order-details.action.render`) | Admin session | isang `GetReschedule` query. |
| Extension | `delivery-date-editor` (`customer-account.order-status.block.render`) | Customer-account session | Read-only block; tumatawag sa backend para sa snapshot/refresh. |
| Extension | `delivery-reschedule-customer` (`customer-account.order.action`) | Customer-account session | UI na nagpapadala sa `/public/customer-account/reschedule`. |
| Extension | `delivery-thank-you` (`purchase.thank-you.block.render`) | Wala (checkout, read-only) | Nagpapakita ng delivery schedule + isang COD sentence sa Thank You page. |
| Extension | `cod-fee-notice` (`purchase.thank-you.block.render`) | Wala | Nagpapakita ng `COD FEE` at `Total with fee` rows sa Thank You page kapag COD ang paraan ng bayad. |
| Extension | `cod-eligibility` (Shopify Function, `payment_customization`) | Shopify infra | Nagtatago ng manual COD payment method sa labas ng NCR ZIP/city + subtotal window. |
| Extension | `delivery-sidekick-data` (`admin.app.tools.data`) | (tumatawag sa `/sidekick/tools/*` rows sa itaas) | Nagre-register ng tatlong Sidekick tools. |
| Extension | `delivery-sidekick-actions` (`admin.app.intent.link` ×2) | N/A | Deep-link lang papuntang `/app/orders` at `/app/scheduler`;  |
| Extension | `delivery-sidekick-scheduler` (`admin.app.intent.link`) | N/A | Deep-link papuntang `/app/scheduler?date=`. |
| Extension | `support-chat` (`customer-account.page.render`) | (tumatawag sa `/api/support-chat`) | Full-page chat UI sa customer account, gamit ang agent brain. |
| Extension | `storefront-chat-widget` (theme app embed) | (tumatawag sa `/apps/schedule-rules/support-chat`) | Floating chat bubble sa storefront. |
