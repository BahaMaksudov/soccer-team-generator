# M12-A — Google Sign-In: behavior and configuration

Status: implemented on `feature/m12a-google-signin` (not deployed). Google stays
**off** in every environment until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
are both set there — without them the provider isn't registered and no Google
button is shown.

## Behavior

| Situation | Result |
|---|---|
| New email, Google says `email_verified: true` | New User (email verified, Google name, **no password**) + Google link, in one transaction. Normal onboarding; the account's first organization gets the one 90-day trial. |
| Google account already linked (by `sub`) | Signs in as the linked User. Email matches are never consulted. |
| Email belongs to a **password** account, Google not linked | **Refused** (`GoogleLinkRequired`): sign in with the password, then Account → Sign-in methods → Connect Google. Nothing is written. |
| Email belongs to an **unverified** account | Refused (`AccountEmailUnverified`). |
| Email belongs to a Google-only account from before M12-A (no password, no link) | Linked once (backfill) — such an account can only have been created by a Google sign-in for that email. Production had 0 such accounts on 2026-10-16. |
| Google email not verified / no account id | Refused before any database access. |
| User cancels on Google's consent screen | `/login?error=OAuthCallback` → "Google sign-in was cancelled or didn't complete." |

**Connect Google (existing password accounts):** Account → Sign-in methods →
Connect Google → current password → Google. The server creates a single-use,
10-minute link intent (hash stored; raw token in an httpOnly, `SameSite=Lax`
cookie scoped to `/api/auth`). The Google callback consumes it and connects that
Google account **only if** its verified email equals the account email and it
isn't linked elsewhere. Errors return to the Account page; the User stays signed
in as before.

**Disconnect Google:** current password required; only for accounts that keep a
password (a Google-only account can't lock itself out). Ends every session.

**Trials:** linking never touches `User.trialUsedAt`; the trial stays one per
account (first organization).

**Sessions:** JWTs carry the User id. A password reset, a password change and a
Google disconnect set `User.sessionsValidAfter`, voiding every older session —
Google-created sessions included. A password reset does **not** disconnect
Google (it is a separate credential); a user who suspects their Google account
should disconnect it.

**Redirects:** NextAuth's `redirect` callback (`safeAuthRedirect`) keeps every
callback on the app's own origin; callback paths are sanitized
(`safeCallbackPath`). Error codes are mapped to fixed text; raw query values are
never echoed.

## Google Cloud Console (owner performs; nothing was configured by Claude)

1. **Project:** console.cloud.google.com → project picker → create
   "TeamBalance Pro" (or select the existing one used for this product only).
2. **Google Auth Platform → Branding:** App name "Team Balance Pro"; user support
   email (an address you monitor); app logo optional (requires verification);
   **App domain:** home page `https://teambalancepro.com`, privacy policy and
   terms URLs (required before publishing — see the legal checklist in
   `docs/M12_LAUNCH_HARDENING.md`); developer contact email.
3. **Audience:** User type **External**. Publishing status **Testing** first; add
   your own Google accounts under **Test users** (max 100). Switch to **In
   production** only after the Privacy Policy and Terms pages are live. Scopes
   used are only `openid`, `email`, `profile` (non-sensitive → no Google review).
4. **Authorized domains (Branding):** `teambalancepro.com`. (`vercel.app` can't
   be registered as yours — Preview testing works while the app is in Testing.)
5. **Clients → Create client → Web application**, name "TBP Web".
6. **Authorized JavaScript origins:** `https://teambalancepro.com`,
   `http://localhost:3000`, and the stable Preview branch URL you test with
   (e.g. `https://soccer-team-generator-git-<branch>-bahrom-maksudovs-projects.vercel.app`).
   **Authorized redirect URIs** (exact, NextAuth's callback):
   - `https://teambalancepro.com/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`
   - `https://<that Preview URL>/api/auth/callback/google`
   Per-commit Preview URLs change every deployment; use the branch URL. Consider
   a **separate OAuth client for Preview/local** so the Production client lists
   only Production URIs.
7. Copy the **Client ID** and **Client secret** (shown once; can be rotated).
8. **Vercel → Settings → Environment Variables**, separately per environment:

| Variable | Kind | Development | Preview | Production |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Config (public identifier; not a secret, but keep server-side) | dev/test client | dev/test client | production client |
| `GOOGLE_CLIENT_SECRET` | **Secret** — mark *Sensitive* | dev/test client | dev/test client | production client |
| `NEXTAUTH_URL` | Config | `http://localhost:3000` | unset (Vercel sets the URL) | `https://teambalancepro.com` (already set) |
| `NEXTAUTH_SECRET` | **Secret** (existing; unchanged) | — | existing | existing |

   Never prefix with `NEXT_PUBLIC_`; the secret is read only by the server
   (`src/lib/googleAuth.ts` → NextAuth provider).
9. **Test:** with the app in *Testing*, only listed test users can sign in. Run
   the Preview checklist below, then Production, then publish.

## Credentials sign-in limit (M12-A)

Enable Google publicly only together with the database-backed password limit
(`src/lib/loginLimit.ts`; details, thresholds and acceptance steps in
`docs/M12_LAUNCH_HARDENING.md` § 5): 10 failed checks / 15 min per address,
5 per email (except from an address that signed in as it within 30 days),
fail-closed on database errors. Google OAuth never consumes or is blocked by this
limit; a "Too many sign-in attempts" message still leaves "Continue with Google"
and "Forgot password?" available.

## Database

Migrations (additive, in order):
1. `20261110120000_m12a_oauth_accounts`: tables `OAuthAccount` (unique
   `(provider, providerAccountId)` and `(userId, provider)`) and `AccountLinkIntent`.
2. `20261110130000_m12a_login_attempts`: enum `LoginAttemptOutcome` and table
   `LoginAttempt` (indexes for the rolling-window counts and cleanup).
No existing table or row changes.
