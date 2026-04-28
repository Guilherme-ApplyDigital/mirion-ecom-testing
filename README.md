# mirion-ecom-testing

## Setup

1. Install dependencies:
   - `npm install`
2. Create local env file:
   - `cp .env.example .env`
3. Fill in MailSlurp values in `.env`:
   - `MAILSLURP_API_KEY`
   - `MAILSLURP_INBOX_ID`
   - `MIRION_LOGIN_EMAIL`
   - optional webmail fallback:
     - `MAILSLURP_WEB_EMAIL`
     - `MAILSLURP_WEB_PASSWORD`
     - `MAILSLURP_FORCE_WEBMAIL=true` (forces webmail login before falling back to the API)
   - optional fallback: `MIRION_MAGIC_LINK` (fresh magic link from email)

## Run tests

- Pre-save cookie consent state (recommended once per machine/session):
  - `npm run prepare:consent`
- Basic auth smoke test:
  - `npm run test:login`
- Full login via MailSlurp magic link (already accepts cookies first):
  - `npm run test:login:mailslurp`

## Troubleshooting

- If the test returns to `/login`, check if the account is allowlisted.
- If the page shows `has not been granted access to the Mirion Storefront`, the login email is valid for email delivery but not authorized in the storefront.
- To unblock quickly, request storefront access for the login email or run with `MIRION_MAGIC_LINK` from an authorized mailbox.
- If API mode is unavailable, configure webmail mode (`MAILSLURP_WEB_EMAIL` + `MAILSLURP_WEB_PASSWORD`) so the test can fetch the magic link by UI.