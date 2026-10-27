# M11.2B — Stripe Live: code safeguards, owner activation checklist and release sequence

**Status:** code is ready locally; nothing is configured. Production at `8c1c17b` has no Stripe variables, so
billing is **off**. Shipping this code changes nothing until the owner completes every step below.

**Never paste a secret key or signing secret into chat (Claude, ChatGPT), a ticket, a commit or a terminal
command.** Copy secrets only from the Stripe Dashboard straight into the Vercel variable field.

---

## 1. What the code enforces (summary)

Live billing is enabled **only** when every one of these holds; otherwise billing is disabled (fail closed):

| # | Condition | Where |
| --- | --- | --- |
| 1 | `VERCEL_ENV=production` (live keys are refused in Preview and Development) | `stripeModePermitted` (config.ts) |
| 2 | `BILLING_ENABLED=true` | `billingConfig` |
| 3 | `BILLING_ALLOW_LIVE_MODE=true` (exactly `true`) | `stripeModePermitted` |
| 4 | `STRIPE_SECRET_KEY` is a well-formed live key (`sk_live_…` or `rk_live_…`) | `isWellFormedLiveKey` |
| 5 | `STRIPE_WEBHOOK_SECRET` starts with `whsec_` | `billingConfig` |
| 6 | Two distinct Price ids are set | `billingConfig` |
| 7 | The billing, renewal, cancellation and refund terms are published (no `billing-launch` item in `OWNER_ITEMS`, `src/lib/legal.ts`) | `billingTermsPending` |
| 8 | Before any Checkout, both Prices are fetched from Stripe and must be live-mode, active, licensed, recurring, interval 1 month / 1 year, USD 999 / 9900 cents, on one Product (cached 10 minutes after success) | `verifyConfiguredPrices` (prices.ts) |

Mode isolation:
- **Test keys** are refused in Production, with or without the live flag.
- **Webhook events** must be signed with `STRIPE_WEBHOOK_SECRET` (raw body). An event of the other mode
  gets 400 and is not stored.
- **Subscriptions** are re-fetched from Stripe and must be in this mode, name the Organization in metadata and
  belong to its stored Customer; otherwise they become an operator exception. A stored test-mode subscription
  never grants Pro or ownership in Production.
- **Customers:** a stored Customer is confirmed with Stripe in this mode before Checkout. If Stripe says it
  doesn't exist in this mode, or is deleted, a new one is created. An outage never replaces it. The Portal
  refuses a Customer of the other mode.
- **Checkout Sessions:** the return page and reconciliation ignore sessions of the other mode (`cs_test_` vs
  `cs_live_`).
- **Reconciliation** handles only this mode's events and subscriptions. Its exception records carry the real
  mode. Before this release they were hard-coded to `livemode: false`.

Trial and plan rules are unchanged:
- 90-day trial with Pro limits;
- converting to paid ends the trial;
- when paid Pro ends the Organization is Free, with no new trial;
- LEGACY and COMP are never converted.

Daily reconciliation: `.github/workflows/billing-reconcile.yml`
- Schedule and target: 06:41 UTC, plus manual dispatch; Production URL only; `main` only.
- Concurrency group `tbp-billing-reconcile`, separate from match automation.
- One request per run.
- Uses the **existing** `TBP_CRON_SECRET`, passed to curl on stdin.
- Outcomes:
  - 503 "Billing is not enabled." → notice (green);
  - any other non-OK answer → failed run;
  - open exceptions → warning.
- The response holds counts only.
- Manually dispatching this workflow is safe: it doesn't post Telegram messages, send email or charge anyone.

---

## 2. Owner activation checklist (in order; Stripe Dashboard in **Live mode** unless stated)

### 2.1 Stripe account activation and payouts
- [ ] Settings → Business: account **activated**. Business details, the representative, and the statement
  descriptor (for example `TEAMBALANCE PRO`) set; support email `support@teambalancepro.com`; website
  `https://teambalancepro.com`.
- [ ] Settings → Payouts: bank account verified; payout schedule chosen.
- [ ] Settings → Branding: name, icon and colors (used by Checkout, the Portal and receipts).
- [ ] Settings → Emails: **successful payment receipts** and **refund receipts** on (they're Stripe's emails,
  not ours).
- [ ] Two-factor authentication on for every Dashboard user.

### 2.2 Product and two recurring Prices
- [ ] Product Catalog → **Add product** "TeamBalance Pro" (one product).
- [ ] Price 1: **Recurring**, **Monthly**, **USD 9.99**, standard pricing (licensed, per unit). Copy its id
  `price_…`; it isn't secret.
- [ ] Price 2 on the **same** product: **Recurring**, **Yearly**, **USD 99.00**. Copy its id.
- [ ] Tax behavior: per §2.7 (leave "unspecified" if no tax decision yet).
- [ ] No trial on the Prices. The app's trial is its own and needs no card.

The code refuses any other amount, currency, interval or mode.

### 2.3 Customer portal (Settings → Billing → Customer portal, Live)
- [ ] **On:** update payment method; view invoice history; **cancel subscription → at end of billing period**
  (no immediate cancellation, no proration refund unless you decide otherwise in §2.6).
- [ ] **Switch plans:** allowed between the two Prices above only, or turned off. **Quantity changes:** off.
  **Promotion codes:** off.
- [ ] Business information: Terms of service link `https://teambalancepro.com/terms` and Privacy policy link
  `https://teambalancepro.com/privacy`.
- [ ] Default return URL: leave empty. The app sends its own billing-page URL.
- [ ] If you create a non-default configuration, note its `bpc_…` id for `STRIPE_PORTAL_CONFIGURATION_ID`.
  Otherwise the default configuration is used.

### 2.4 Webhook endpoint (Developers → Webhooks → Add endpoint, Live)
- [ ] URL `https://teambalancepro.com/api/stripe/webhook`.
- [ ] API version: the account default is fine. The app re-fetches each object with its pinned version
  `2026-09-30.endive`.
- [ ] Events (exactly these 10):
  - `checkout.session.completed`
  - `checkout.session.expired`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `customer.subscription.paused`
  - `customer.subscription.resumed`
  - `invoice.paid`
  - `invoice.payment_failed`
  - `invoice.payment_action_required`
- [ ] Reveal the **signing secret** (`whsec_…`) only when entering it into Vercel (§2.8). Don't copy it
  anywhere else.

### 2.5 Restricted live key (Developers → API keys → Create restricted key)
Name it `teambalancepro-production`. Grant only these permissions; everything else is **None**:

| Resource | Permission | Used for |
| --- | --- | --- |
| Customers | **Write** | create the Organization's Customer; retrieve it to confirm its mode |
| Checkout Sessions | **Write** | create, retrieve, expire |
| Subscriptions | **Read** | retrieve, list (sync and reconciliation) |
| Prices | **Read** | verify both Prices before Checkout |
| Customer portal | **Write** | create Portal sessions |

- [ ] Webhook verification needs no API permission.
- [ ] Don't use the unrestricted `sk_live_` secret key.
- [ ] Reveal the `rk_live_…` key only when entering it into Vercel (§2.8). Stripe shows it once; if it's lost,
  roll it and enter the new one.

### 2.6 Billing terms, refund and cancellation policy [OWNER, legal review recommended]
- [ ] Review `docs/legal/billing-terms-m112b-draft.md`. It covers automatic renewal, cancellation at period
  end, refunds, price changes, failed payments and taxes.
- [ ] Decide the refund policy. The draft recommends: no refunds for partial periods; discretionary refunds
  for mistakes within 14 days of a charge.
- [ ] Decide on the annual plan's renewal reminder. The draft recommends a Stripe "upcoming renewal" email for
  annual plans (Settings → Billing → Subscriptions and emails). Some US states require one.
- [ ] **Publication is a separate, owner-approved code change.** It:
  1. replaces Terms §8 "Paid plans" and the Privacy "Stripe" line;
  2. removes the `billing-terms` item from `OWNER_ITEMS`. **Live billing stays disabled in code until this
     ships.**

### 2.7 Tax decision [OWNER, accountant recommended]
Pick one option:
- **A. No tax collection for now.** This fits while under economic-nexus thresholds. Set the Prices' tax
  behavior to "exclusive" or leave it unspecified. No code change.
- **B. Stripe Tax.** Register where required, set the origin address, and turn on Stripe Tax. This **needs a
  follow-up code change** (`automatic_tax` and address collection in Checkout) before launch. Don't enable
  Stripe Tax in the Dashboard alone and assume Checkout uses it.
- [ ] Record the decision. The Terms draft wording depends on it.

### 2.8 Vercel environment variables (Project → Settings → Environment Variables)
Scope is **Production only** for every variable: never Preview or Development, which keep their test
configuration. Use **Add New**; for an existing name, **Edit**.

| Name | Type | Value / entry | Scope | Sensitive | Redeploy |
| --- | --- | --- | --- | --- | --- |
| `BILLING_ENABLED` | Config | `true` | Production | No | Yes |
| `BILLING_ALLOW_LIVE_MODE` | Config | `true` | Production | No | Yes |
| `STRIPE_SECRET_KEY` | Secret | the restricted live key from §2.5 (`rk_live_…`): reveal it in Stripe and paste it **directly** into the Vercel value field. Nowhere else | Production | **Yes** | Yes |
| `STRIPE_WEBHOOK_SECRET` | Secret | the live endpoint's signing secret from §2.4 (`whsec_…`): reveal it in Stripe and paste it **directly** into Vercel | Production | **Yes** | Yes |
| `STRIPE_PRICE_PRO_MONTHLY` | Config | the monthly Price id from §2.2 (`price_…`) | Production | No | Yes |
| `STRIPE_PRICE_PRO_ANNUAL` | Config | the annual Price id from §2.2 (`price_…`) | Production | No | Yes |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Config | **optional**: the `bpc_…` id from §2.3, only if not using the default Portal configuration | Production | No | Yes |

Already set; verify only, no change:
- `APP_BASE_URL` = `https://teambalancepro.com` (used for the Checkout and Portal return URLs);
- `CRON_SECRET`, which must equal the GitHub repository secret `TBP_CRON_SECRET`.

**New GitHub Actions secrets needed: none.** The reconcile workflow reuses `TBP_CRON_SECRET`.

Enter all variables, then redeploy **once**. Vercel applies variables only to new deployments. Use the
deployment's "Redeploy" (build cache may stay on; migrations: "No pending migrations").

---

## 3. Production release sequence

Each step marked **[APPROVAL]** changes Preview or Production.

1. **Code review** of the M11.2B commit (local).
2. **[APPROVAL] Preview rehearsal:** push the branch. Preview keeps its test keys: Checkout with test card
   `4242 4242 4242 4242`, the webhook to PRO, the Portal, cancellation, and the reconcile endpoint. This
   confirms test mode is unchanged. The new Price check runs against the test Prices: they must be active,
   recurring and the right interval.
3. **[APPROVAL] Deploy the code to Production** (merge to `main`, fast-forward). With no Stripe variables,
   billing stays off.
   - Daily reconcile runs log a **notice** ("Billing is not enabled").
   - Optional: dispatch "Billing reconciliation (Production)" once by hand. Expect HTTP 503 → notice and a
     green run.
4. **Owner Stripe setup:** checklist §2.1–2.5 and §2.7. Dashboard only; no charge yet.
5. **[APPROVAL] Legal publication:** owner-reviewed billing terms (§2.6) in a separate commit that removes the
   `billing-terms` item. Deploy it. Billing is still off, because the variables aren't set.
6. **[APPROVAL] Vercel variables** (§2.8), then one Production redeploy.
7. **Verification, with no charge:**
   1. `curl -s -o /dev/null -w "%{http_code}\n" -X POST https://teambalancepro.com/api/stripe/webhook -d '{}'`
      → **400**. That means billing is enabled and unsigned requests are refused; 503 means still disabled.
   2. Dispatch the reconcile workflow → HTTP 200, `ok: true`, all counts 0.
   3. `/pricing` and an owner's Billing page show the subscribe buttons. The function log must not show
      `[billing] checkout … refused:`. If it does, the Price check failed: fix the Price ids or Prices.
   4. Signed live webhook delivery can only be confirmed with a real event (step 8). Don't send synthetic live
      events.
8. **[APPROVAL] First real subscription:** the owner subscribes their own organization, monthly ($9.99, real
   card). Verify:
   - Checkout shows TeamBalance Pro at $9.99/month;
   - you return to the Billing page and it shows **Pro**;
   - the Stripe webhook log shows `200` for `checkout.session.completed` and `customer.subscription.created`;
   - the Portal opens, and cancel-at-period-end works;
   - the next day's reconcile run is green with `exceptions: 0`.

   Then cancel, and refund in the Dashboard if wanted.
9. **Launch:** announce. Watch the daily reconcile runs and Stripe → Webhooks failures.

### Rollback
- **Stop new purchases:** delete `BILLING_ALLOW_LIVE_MODE` (or set `BILLING_ENABLED` to anything other than
  `true`) in Production, then redeploy.
  - Checkout and Portal return 503, the webhook returns 503, and Stripe retries for up to 3 days.
  - Already-paid Organizations keep their current plan in the database.
  - **This does not stop Stripe from charging existing subscribers.** Pause or cancel subscriptions in the
    Stripe Dashboard if charges must stop.
- **Key compromise:** roll the restricted key in Stripe, enter the new one in Vercel, then redeploy.
- **No database restore** is ever part of a billing rollback.

---

## 4. M11.2C launch safeguards (code) and the Dashboard setup they need

**In code (all modes; Production still gated by §1):**
- **US-only:**
  - Checkout requires a **US billing address** (50 states + DC, 5- or 9-digit ZIP). It's validated on the server, then stored on the Stripe Customer with Stripe Tax `validate_location: immediately`.
  - Checkout is created with `customer_update.address = "never"`, so the address can't be changed there.
  - Stripe Checkout itself can't restrict billing countries, which is why the address comes first.
- **Tax:**
  - Checkout always uses `automatic_tax`.
  - It is **refused** (503, log `[billing] checkout … refused: …`) unless all of these hold:
    - Stripe Tax is **active**;
    - both Prices are tax-**exclusive** (or unspecified with an exclusive / USD-inferred default).
  - **M11.2G:** tax collection locations (registrations) are **not** an app requirement. Stripe adds tax only where a location is configured and calculates **$0** elsewhere. Adding a location later applies automatically, including to renewals. The customer-facing wording says tax "where we collect it", which may be $0.
  - An address Stripe Tax can't place → 400 with a clear message.
- **Recurring-charge disclosure:**
  - shown next to the button and on Stripe Checkout: price + tax, automatic renewal, cancel any time with access until period end, the refund policy, and that the trial ends;
  - a **required checkbox** to agree to the Terms and the renewing charge;
  - the Terms version, time and user are stored in the Checkout Session metadata.
- **No orphaned subscriptions:** database triggers refuse to:
  - delete an Organization whose subscription isn't `canceled` / `incomplete_expired`;
  - remove, demote or move its last OWNER, which also blocks deleting that User.

  This applies to the app, scripts and SQL alike. The app has no organization or account deletion feature; deletions are manual.
- **Diagnostics:**
  - one line per applied webhook (`[billing] webhook <evt id> (<type>) processed: plan …`);
  - a reason code for any ignored Checkout return (no ids).
- **Legal:** the new Terms §8 / §10 and Privacy billing disclosures are in the pages, but render **only** after the `billing-terms` item is removed from `src/lib/legal.ts`. That removal is the single publication step, and it also unlocks Live.

**Dashboard (owner, Live and Sandbox), required before activation:**
1. **Stripe Tax:**
   - Settings → Tax: head office address (Massachusetts), status **active**;
   - default tax behavior **exclusive** (or set each Price to "exclusive");
   - collection locations (registrations) are the owner's decision: none are required by the app (M11.2G), and where none is set Stripe adds $0 tax.
2. **Restricted key: add *Tax settings: Read*** (in addition to the five permissions in §2.5). Without it the tax check fails and Checkout stays off. *Tax registrations* access is no longer used (M11.2G).
3. **Customer Portal (Live):**
   - turn **off** plan switching;
   - cancellation **at end of billing period only**;
   - recommended: turn off customer **address** editing, so the billing address stays the validated US one.
4. **Optional:** a Radar rule blocking non-US cards. It isn't needed for tax; the address check is what enforces US-only.
5. **Annual renewal reminder:** Settings → Billing → Subscriptions and emails → upcoming-renewal emails, if available on the account. The Terms deliberately **do not promise** a reminder until it's configured and verified.
6. **Sandbox (Preview):** Stripe Tax active and tax-exclusive test Prices, or Preview Checkout is refused by the same rule. Rehearse with the same collection locations as Live (none) to see the $0-tax outcome.

**Migration** `20270110120000_m112c_launch_safeguards`: one nullable column (`BillingCheckoutSession.requestHash`) and two triggers. It's additive, with no backfill; the rollback is in the file.
