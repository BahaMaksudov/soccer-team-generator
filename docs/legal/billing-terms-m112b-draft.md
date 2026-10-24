# DRAFT — paid subscription terms (M11.2B), for owner review

**Not published.** This text changes nothing on the site. Publishing it is a separate, owner-approved code change
that also removes the `billing-terms` item from `OWNER_ITEMS` in `src/lib/legal.ts`. Live billing stays disabled
in code until that item is removed. **No attorney has reviewed this draft** (legal review recommended). Bracketed
items **[DECIDE]** need an owner choice.

---

## Terms of Service — replacement for §8 "Paid plans" bullet

> **Paid plans (Pro):** Pro is a subscription for one organization, billed in advance in US dollars:
> currently $9.99 per month or $99 per year **[DECIDE: "plus applicable taxes" if tax is collected — see
> docs/M11_2B_STRIPE_LIVE.md §2.7]**. Only an organization's owner can subscribe or manage billing.
>
> - **Automatic renewal.** Your subscription renews automatically at the end of each billing period, and the
>   card or payment method on file is charged the then-current price, until you cancel.
> - **Cancelling.** You can cancel at any time from your organization's Billing page ("Manage billing"). The
>   cancellation takes effect at the end of the current billing period. Pro features stay available until then,
>   and you won't be charged again. When Pro ends, the organization moves to the Free plan. Nothing is deleted,
>   but Free limits apply.
> - **Refunds.** **[DECIDE — recommended:]** Payments are non-refundable, and we don't give refunds or credits
>   for partial billing periods or unused time, except where the law requires it. If you were charged by
>   mistake, contact us at support@teambalancepro.com within 14 days and we'll review it.
> - **Free trial.** Subscribing during your Pro trial starts paid billing immediately, and the rest of the trial
>   ends. The trial is not extended or repeated.
> - **Failed payments.** If a payment fails, we and our payment processor may retry it. Pro stays available
>   while payment is retried. If payment can't be collected, the subscription ends and the organization moves
>   to the Free plan.
> - **Price changes.** We may change Pro prices. A change applies from your next billing period after we tell
>   you about it by email at least 30 days in advance **[DECIDE: 30 days recommended]**. You can cancel before
>   it takes effect.
> - **Payments are processed by Stripe.** We don't receive or store your full card details.
>
> We may change plans and limits. A change that reduces a paid plan's features applies from your next billing
> period.

**[DECIDE] Annual renewal reminder.** Recommended: turn on Stripe's upcoming-renewal reminder email for annual
subscriptions (some US states require notice before an annual auto-renewal). Optionally add to the
"Automatic renewal" bullet: "For annual plans, we'll remind you by email before your subscription renews."

## Privacy Policy — replacement for the Stripe processor line

> **Stripe** — processes subscription payments. When an organization owner subscribes, Stripe collects the
> payment details directly. We receive and store only the Stripe customer and subscription references, the
> plan, its status and its billing dates. We never receive full card numbers.

Also in the "information we collect" section, add:

> **Billing information (organization owners who subscribe):** the organization's Stripe customer reference,
> subscription status, plan interval and billing dates. Payment card details are handled by Stripe.

## Pricing page

When billing is enabled, the pricing page already shows live purchase copy. Before publishing, confirm the
displayed prices match the Stripe Prices ($9.99 / $99). The code refuses live Checkout otherwise.

## Owner sign-off

| Item | Decision |
| --- | --- |
| Refund policy | |
| Price-change notice period | |
| Annual renewal reminder | |
| Tax wording (§2.7 A or B) | |
| Legal review done / waived | |
