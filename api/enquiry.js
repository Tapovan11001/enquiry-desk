// Vercel function: POST /api/enquiry
// Wires the pipeline in lib/enquiry.js to the real services. Set these in Vercel's project settings:
//   RESEND_API_KEY      from resend.com, with your domain verified
//   RESEND_FROM         e.g. "Aarov Makhija <hello@yourdomain.com>"
//   OWNER_EMAIL         where new enquiries are sent
//   OWNER_NAME          signs the confirmation email
//   SHEETS_WEBHOOK_URL  the web app URL from apps-script/Webhook.gs
//   SHEETS_SECRET       the secret that script printed during setup
//   ANTHROPIC_API_KEY   optional; without it, enquiries are sorted by keyword rules
//   ALLOWED_ORIGINS     optional, comma separated; defaults to any origin
//   REDIRECT_URL        optional; plain HTML forms (no JavaScript) are sent here after a submit

import { claudeTriage, handleEnquiry, memorySeen, resendSender, sheetsWebhook } from "../lib/enquiry.js";

const REQUIRED = ["RESEND_API_KEY", "RESEND_FROM", "OWNER_EMAIL", "SHEETS_WEBHOOK_URL", "SHEETS_SECRET"];
const seen = memorySeen();
const hits = new Map();

/** At most 5 submissions per IP in 10 minutes, per function instance. */
export function rateLimited(ip, now = Date.now(), max = 5, windowMs = 10 * 60 * 1000) {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > max;
}

export function missingConfig(env = process.env) {
  return REQUIRED.filter((k) => !env[k]);
}

function cors(req, res, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin ?? "";
  if (!allowed.length) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return !allowed.length || allowed.includes(origin) || !origin;
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === "object") return b;
  if (typeof b === "string" && b) {
    try { return JSON.parse(b); } catch { return Object.fromEntries(new URLSearchParams(b)); }
  }
  return {};
}

export default async function handler(req, res, env = process.env) {
  const originOk = cors(req, res, env);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, configured: missingConfig(env).length === 0 });
  if (req.method !== "POST") return res.status(405).json({ ok: false, errors: { form: "Use POST." } });
  if (!originOk) return res.status(403).json({ ok: false, errors: { form: "This form can't be sent from this site." } });

  const missing = missingConfig(env);
  if (missing.length) {
    return res.status(503).json({ ok: false, errors: { form: "The form isn't set up yet. Please email me directly." }, missing });
  }

  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ ok: false, errors: { form: "That's a lot of messages in a few minutes. Please try again later." } });

  const input = readBody(req);
  const out = await handleEnquiry(input, {
    sendEmail: resendSender(env.RESEND_API_KEY, env.RESEND_FROM),
    appendRow: sheetsWebhook(env.SHEETS_WEBHOOK_URL, env.SHEETS_SECRET),
    triage: env.ANTHROPIC_API_KEY ? claudeTriage(env.ANTHROPIC_API_KEY) : undefined,
    seen,
    owner: { name: env.OWNER_NAME || "Aarov Makhija", email: env.OWNER_EMAIL, from: env.RESEND_FROM },
  });
  console.log(JSON.stringify({ status: out.status, log: out.log }));

  const plainForm = String(req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
  if (plainForm && env.REDIRECT_URL) {
    const u = new URL(env.REDIRECT_URL);
    if (out.body.ok) u.searchParams.set("ref", out.body.reference);
    else u.searchParams.set("error", Object.values(out.body.errors ?? {})[0] ?? "Something went wrong.");
    res.setHeader("Location", u.toString());
    return res.status(303).end();
  }
  return res.status(out.status).json(out.body);
}
