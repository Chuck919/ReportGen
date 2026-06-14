# ReportGen

Tax return OCR and workbook extraction (`web/` is the Next.js app deployed to Vercel).

## Deploy to Vercel

1. Push this repo to GitHub (any GitHub account — does not need to match your Cursor login email).
2. In [Vercel](https://vercel.com) → **Add New Project** → import the GitHub repo.
3. Set **Root Directory** to `web`.
4. Environment variables (Production):
   - `NEXT_PUBLIC_VERCEL=1` (required for Vercel OCR modes on `/tax`)
   - `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (if using Supabase)
   - `PARSE_TAX_API_KEY` (optional — locks down `/api/parse-tax-return`)
5. Deploy. Hobby plan: OCR functions use `maxDuration: 300` (see `web/vercel.json`).

### CLI (alternative to Git integration)

```bash
cd web
npx vercel login          # sign in with your Vercel account
npx vercel link           # link to team/project
npx vercel env pull .env.local
npx vercel --prod
```

## Local dev

```bash
cd web
npm install
npm run dev
```

See `web/PRE_DEPLOY_VERCEL.md` for the full checklist.
