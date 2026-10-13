# Security

This app handles real customer orders, names, addresses and email. Please report security problems privately.

## How to report

Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

Please do not open a public issue, pull request or discussion for a security problem, and do not test against the live store or the production app. Use your own dev store (see [docs/development.md](docs/development.md)).

## In scope

- Request verification: session tokens, webhook HMAC, app proxy signatures, customer account tokens (`app/routes`, `app/lib/verify-app-proxy.server.ts`)
- Access to another customer's order through the reschedule or order-delivery routes
- Secrets or personal data committed to this repository
- Injection through order fields, email content or schedule rules

## Out of scope

- Shopify's own platform and APIs (report those to Shopify)
- Denial of service and volume testing
- Findings that need access to the merchant's Shopify admin or Google Cloud account
