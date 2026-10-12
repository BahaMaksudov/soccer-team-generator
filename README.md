
# Soccer Team Generator (Admin + Public)

## Requirements covered
- Admin login (email + password via NextAuth Credentials)
- Admin player management (add/edit/disable/delete)
- Select players with checkboxes
- Generate balanced teams (rating-based) + 1 GK per team when enough selected
- Generate preview multiple times
- Publish saves teams for that date (overwrites previous teams for that date)
- Home shows history (newest first), 4 dates per page
- Print / Save as PDF

## Setup (Mac)
1) Install Node 20+ (recommended)
2) Install deps:
   npm install
3) Create env:
   cp .env.example .env
   openssl rand -base64 32   # paste into NEXTAUTH_SECRET
   # Accounts are database-backed: sign up at /signup (no admin env credentials).
4) Init DB:
   npx prisma migrate dev --name init
5) Run:
   npm run dev

Deployment (Vercel): migrations run ONCE per build, in the Vercel project's
build command `npx prisma migrate deploy && npm run build`, against that
environment's DATABASE_URL. `npm run build` itself is only `next build` (it never
migrates), so keep `prisma migrate deploy` in the Vercel build command.

Home: http://localhost:3000
Admin: http://localhost:3000/admin
Login: http://localhost:3000/login
=======
# soccer-team-generator
Soccer Teams

// redeploy
