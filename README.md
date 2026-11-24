# Enquiry Desk

A contact form backend. It checks each message, saves it as a row in Google Sheets, emails the sender a confirmation through Resend, and tells you what the message is about before you open it.

**Live:** {{live-url}}

## How it works in 100 words

Most contact forms just forward an email, and messages get lost or never answered. Enquiry Desk is the part behind the form. When someone presses Send, it first checks the message is real and quietly drops spam bots. Then it saves the message as a new row in your Google Sheet, so nothing is ever lost. It emails the sender straight away to say their enquiry was received, with a reference number, and emails you a short summary. Claude can read each message and mark whether it's a job offer, a project or a question, and how urgent it is.

_Created by Aarov Makhija._

## Why

A contact form that only forwards an email isn't much use. The person who wrote in doesn't know if it arrived. The message sits in an inbox next to spam, and a week later nobody remembers who asked what. I wanted a form where every enquiry gets a reply within seconds, lands in a sheet I can sort and mark as answered, and comes with a one-line summary so the job offers don't get buried under the SEO pitches.

## What happens when someone presses Send

1. **Checked.** Name, email, topic and message are validated, and each problem comes back as a plain sentence next to the field.
2. **Spam dropped.** Four signals catch bots:
   - a hidden field that only bots fill in,
   - a form sent less than 3 seconds after it opened,
   - more than 3 links,
   - the usual spam phrases.

   Bots get a normal "thanks" so they don't learn to try harder. The same message sent twice in ten minutes is kept once, and each IP gets at most 5 sends in 10 minutes.
3. **Sorted.** Claude Haiku picks a category (opportunity, project, collaboration, question, spam, other) and an urgency, and writes a one-line summary. The answer comes back through a forced tool call and is checked before it's used. Without an API key, or if Claude's answer is malformed, keyword rules do the sorting instead.
4. **Saved to the sheet first.** The row is written before any email is sent, so if email fails the enquiry still isn't lost. Cells that start with `=`, `+`, `-` or `@` are stored as text, so nobody can inject a formula into your sheet.
5. **Two emails.**
   - The sender gets "Got your message" with a reference like `ED-261124-7Q3K` and a copy of what they wrote.
   - You get the summary, the category and the full message. Replying to it replies to the sender.

If both the sheet and your email fail, the sender is told plainly to email you directly. It never shows a fake success.

## How the code is put together

```
lib/enquiry.js        the whole pipeline, plain JavaScript, no network calls of its own
api/enquiry.js        the Vercel function that plugs in Resend, the sheet and Claude
apps-script/Webhook.gs  the Google Sheets side: appends rows when the secret matches
web/                  the demo page, which runs lib/enquiry.js in the browser
```

Email, the sheet and Claude are passed into `handleEnquiry` as functions. That's what lets the tests, the browser demo and the real server all run the same code.

## Set it up

1. **The sheet.** Make a Google Sheet, open **Extensions → Apps Script**, paste [`apps-script/Webhook.gs`](apps-script/Webhook.gs), and run `setup`. It creates an **Enquiries** sheet with a Status dropdown and prints a secret.
2. **Publish the script.** Go to **Deploy → New deployment → Web app**, execute as you, with access for anyone. Copy the URL.
3. **Resend.** Verify your domain at resend.com and create an API key.
4. **Deploy on Vercel** and set these variables:

| Variable | What goes in it |
|---|---|
| `RESEND_API_KEY` | Your Resend key |
| `RESEND_FROM` | Sender on your verified domain, like `Aarov Makhija <hello@yourdomain.com>` |
| `OWNER_EMAIL` | Where new enquiries go |
| `OWNER_NAME` | How the confirmation is signed |
| `SHEETS_WEBHOOK_URL` | The web app URL from step 2 |
| `SHEETS_SECRET` | The secret `setup` printed |
| `ANTHROPIC_API_KEY` | Optional. Sorts with Claude instead of keywords |
| `ALLOWED_ORIGINS` | Optional, comma separated. Only these sites can post |
| `REDIRECT_URL` | Optional. Where a plain HTML form (no JavaScript) lands after sending |

5. **Point your form at it.** POST JSON to `/api/enquiry` with `name`, `email`, `topic`, `message`, and optionally `phone`, `company`, `website` (the honeypot) and `startedAt`. The demo page has a copy-paste snippet. Calling `GET /api/enquiry` tells you whether the server is configured.

The answer is `{ ok: true, reference }` or `{ ok: false, errors: { field: "message" } }`.

## Run it locally

```bash
npm install
npm test        # 12 tests: validation, spam, ordering, failures, Claude fallback, the API with fetch faked, Webhook.gs in a fake Apps Script
npm run dev     # the demo at localhost:5173
```

## Limits

- The duplicate check and the rate limit live in memory, per server instance. That's fine for a personal site; a busy one would want Redis or similar.
- Resend's free plan sends 3,000 emails a month and 100 a day.
- Apps Script web apps take a second or two to answer, which is most of the time a submission takes.

## License

MIT
