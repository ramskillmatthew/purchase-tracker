# Purchase Tracker

Minimal personal tracker built with Next.js 15, TypeScript, Tailwind and Supabase.

## Setup

1. Create a Supabase project and run `supabase-schema.sql` in its SQL editor.
2. Copy `.env.example` to `.env.local` and add the project URL and service role key.
3. Run `npm install`, then `npm run dev`.

For Vercel, add the same environment variables in project settings. The service role key is used only by server routes.

CSV headings and column order are in `lib/csv.ts`. Edit the two arrays there when the exact spreadsheet layout is known.
