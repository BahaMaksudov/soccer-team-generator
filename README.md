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
   node -e "const bcrypt=require('bcrypt'); bcrypt.hash('YourPassword123!',10).then(console.log)"
   # paste into ADMIN_PASSWORD_HASH
4) Init DB:
   npx prisma migrate dev --name init
5) Run:
   npm run dev

Home: http://localhost:3000
Admin: http://localhost:3000/admin
Login: http://localhost:3000/login
