# Gmail setup

Gmail is a second read-only mailbox. Yahoo remains on IMAP. Email Assistant and Purchase Import search both providers.

## Supabase

Run `supabase-gmail-accounts.sql` in **Supabase → SQL Editor → New query**.

## Google Cloud

1. Create or select a Google Cloud project and enable **Gmail API**.
2. Configure the OAuth consent screen; for a private testing app add your Gmail address as a test user.
3. Create an **OAuth client ID → Web application**.
4. Add redirect URIs:
   - `http://localhost:3000/api/gmail/callback`
   - `https://YOUR-VERCEL-DOMAIN/api/gmail/callback`
5. Copy the client ID and client secret. Never commit the secret.

The app requests read-only Gmail access plus offline access so it can use a stored refresh token.

## Local `.env.local`

```env
NEXT_PUBLIC_APP_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/api/gmail/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=...
```

Generate the encryption key once:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Keep the same encryption key. Changing it requires reconnecting Gmail.

## Vercel

Add the same variables under **Project → Settings → Environment Variables**, using the production URL, then redeploy.

## Connect and verify

1. Sign in to Purchase Tracker as the owner.
2. Open **Settings → Gmail accounts → Connect Gmail**.
3. Grant read-only access.
4. Test Email Assistant with a known Gmail sender.
5. Run Purchase Import for a date range containing a Gmail receipt and confirm it appears only once.

Disconnecting removes the saved token from Purchase Tracker and does not modify Gmail.
