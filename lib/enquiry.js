// The whole pipeline for one form submission, written as plain JavaScript so it runs unchanged
// in a Vercel function, in the browser demo and in the tests. Side effects (email, Sheets, Claude)
// are passed in, so nothing here talks to the network on its own.

/**
 * @typedef {{ name: string, email: string, phone: string, company: string, topic: string, message: string,
 *             website?: string, startedAt?: number }} Submission
 * website is a honeypot: real people never see it, bots fill it in.
 * startedAt is when the form was opened (ms since epoch), to catch instant bot posts.
 *
 * @typedef {{ category: string, urgency: "low" | "normal" | "high", summary: string, source: "rules" | "claude" }} Triage
 * @typedef {{ to: string, replyTo?: string, subject: string, text: string, html: string }} Email
 *
 * @typedef {{
 *   sendEmail: (e: Email) => Promise<void>,
 *   appendRow: (row: (string | number)[]) => Promise<void>,
 *   triage?: (s: Submission) => Promise<Triage | null>,
 *   seen?: (key: string, windowMs: number) => boolean,
 *   now?: () => Date,
 *   owner: { name: string, email: string, from: string },
 * }} Deps
 */

export const TOPICS = ["Internship or job", "Freelance project", "Collaboration", "Question", "Other"];
export const CATEGORIES = ["opportunity", "project", "collaboration", "question", "spam", "other"];
const LIMITS = { name: 80, email: 120, phone: 20, company: 100, message: 3000 };

const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
const oneLine = (s) => clean(s).replace(/\s+/g, " ");

/** Returns { value, errors }. errors maps field -> message, written for the person filling the form. */
export function validate(input) {
  const v = {
    name: oneLine(input?.name),
    email: oneLine(input?.email).toLowerCase(),
    phone: oneLine(input?.phone),
    company: oneLine(input?.company),
    topic: oneLine(input?.topic),
    message: clean(input?.message).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n"),
    website: oneLine(input?.website),
    startedAt: Number(input?.startedAt) || 0,
  };
  /** @type {Record<string, string>} */
  const errors = {};
  if (v.name.length < 2) errors.name = "Please tell me your name.";
  else if (v.name.length > LIMITS.name) errors.name = "That name is too long.";
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v.email)) errors.email = "That email doesn't look right.";
  else if (v.email.length > LIMITS.email) errors.email = "That email is too long.";
  if (v.phone && !/^\+?[\d\s()-]{7,20}$/.test(v.phone)) errors.phone = "Use digits only, with + for the country code if you like.";
  if (v.company.length > LIMITS.company) errors.company = "Keep this under 100 characters.";
  if (!TOPICS.includes(v.topic)) errors.topic = "Pick what this is about.";
  if (v.message.length < 10) errors.message = "Add a sentence or two so I know how to help.";
  else if (v.message.length > LIMITS.message) errors.message = `Keep it under ${LIMITS.message.toLocaleString("en-IN")} characters.`;
  return { value: v, errors };
}

/** Bot signals. Returns a reason, or null. Silent: bots get a normal-looking success. */
export function spamReason(v, now) {
  if (v.website) return "honeypot filled";
  if (v.startedAt && now - v.startedAt < 3000) return "sent within 3 seconds of opening";
  if ((v.message.match(/https?:\/\//g) ?? []).length > 3) return "more than 3 links";
  if (/\b(seo services|backlinks|crypto investment|casino|loan offer)\b/i.test(v.message)) return "spam phrases";
  return null;
}

/** Simple keyword triage, used when Claude isn't configured or doesn't answer. */
export function ruleTriage(v) {
  const t = `${v.topic} ${v.message}`.toLowerCase();
  const category =
    /internship|intern\b|hiring|role|position|job/.test(t) ? "opportunity" :
    /freelance|project|quote|budget|edit|website|build/.test(t) ? "project" :
    /collab|partner/.test(t) ? "collaboration" :
    /\?|how|what|when|can you/.test(t) ? "question" : "other";
  const urgency = /urgent|asap|today|tomorrow|deadline|this week/.test(t) ? "high" : "normal";
  // Skip greetings, then take the first real sentence plus the first ask, if that comes later.
  const sentences = v.message.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const real = sentences.filter((s) => !/^(hi|hello|hey|dear|good (morning|afternoon|evening)|hope)\b/i.test(s) || s.length > 80);
  const lead = real[0] ?? v.message;
  const ask = real.slice(1).find((s) => /\?$|\b(could|would|can you|please|need|looking for)\b/i.test(s));
  const joined = ask ? `${lead} ${ask}` : lead;
  const summary = joined.length > 140 ? joined.slice(0, 137).replace(/\s+\S*$/, "") + "..." : joined;
  return { category, urgency, summary, source: "rules" };
}

/** Checks a triage that came from a model. Anything off falls back to the rules. */
export function checkTriage(t) {
  if (!t || typeof t !== "object") return null;
  if (!CATEGORIES.includes(t.category)) return null;
  if (!["low", "normal", "high"].includes(t.urgency)) return null;
  if (typeof t.summary !== "string" || !t.summary.trim() || t.summary.length > 200) return null;
  return { category: t.category, urgency: t.urgency, summary: t.summary.trim(), source: "claude" };
}

/** ED-241126-7Q3K: date plus 4 characters, easy to read out on a call. */
export function referenceId(now, rand = Math.random) {
  const d = now.toISOString().slice(2, 10).replace(/-/g, "");
  const abc = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I
  let s = "";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(rand() * abc.length)];
  return `ED-${d}-${s}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const paras = (s) => esc(s).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`).join("");
const wrap = (inner) => `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1d1d1f;max-width:560px">${inner}</div>`;

export function confirmationEmail(v, ref, owner) {
  const first = v.name.split(" ")[0];
  const text = `Hi ${first},

Thanks for getting in touch. I've received your message about "${v.topic.toLowerCase()}" and I'll reply within two working days, usually sooner.

Your reference is ${ref}. If you need to add anything, just reply to this email.

Here's what you sent:

${v.message}

${owner.name}`;
  return {
    to: v.email,
    replyTo: owner.email,
    subject: `Got your message (${ref})`,
    text,
    html: wrap(`${paras(`Hi ${first},`)}${paras(`Thanks for getting in touch. I've received your message about "${v.topic.toLowerCase()}" and I'll reply within two working days, usually sooner.`)}${paras(`Your reference is ${ref}. If you need to add anything, just reply to this email.`)}<p style="margin:16px 0 6px;color:#6e6e73;font-size:13px">What you sent</p><div style="border-left:3px solid #d2d2d7;padding:2px 0 2px 12px;color:#424245">${paras(v.message)}</div>${paras(owner.name)}`),
  };
}

export function ownerEmail(v, ref, triage) {
  const flag = triage.urgency === "high" ? "[Urgent] " : "";
  const lines = [
    `${v.name} <${v.email}>${v.phone ? `, ${v.phone}` : ""}${v.company ? `, ${v.company}` : ""}`,
    `Topic: ${v.topic}`,
    `Looks like: ${triage.category}, ${triage.urgency} urgency (${triage.source === "claude" ? "Claude" : "keyword rules"})`,
    `Summary: ${triage.summary}`,
    "",
    v.message,
    "",
    `Reference ${ref}. Reply to this email to answer ${v.name.split(" ")[0]} directly.`,
  ];
  return {
    to: "",
    replyTo: v.email,
    subject: `${flag}New enquiry from ${v.name}: ${triage.summary.slice(0, 60)}`,
    text: lines.join("\n"),
    html: wrap(paras(lines.join("\n"))),
  };
}

export const SHEET_HEADERS = ["Received", "Reference", "Name", "Email", "Phone", "Company", "Topic", "Category", "Urgency", "Summary", "Message", "Status"];

export function sheetRow(v, ref, triage, now) {
  const ist = new Date(now.getTime() + 330 * 60000).toISOString().replace("T", " ").slice(0, 16);
  // A leading = + - @ would be read as a formula by Sheets; prefix with ' to keep it as text.
  const safe = (s) => (/^[=+\-@]/.test(s) ? `'${s}` : s);
  return [ist, ref, safe(v.name), v.email, safe(v.phone), safe(v.company), v.topic, triage.category, triage.urgency, safe(triage.summary), safe(v.message), "New"];
}

/**
 * Handles one submission end to end.
 * Order matters: the Sheets row is written first, so an enquiry is never lost even if email fails.
 * Returns what the browser should see, plus a log of what happened, for tests and the demo.
 */
export async function handleEnquiry(input, deps) {
  const now = (deps.now ?? (() => new Date()))();
  const { value: v, errors } = validate(input);
  if (Object.keys(errors).length) return { status: 400, body: { ok: false, errors }, log: ["rejected: invalid fields"] };

  const spam = spamReason(v, now.getTime());
  if (spam) return { status: 200, body: { ok: true, reference: referenceId(now) }, log: [`dropped as spam: ${spam}`] };

  if (deps.seen?.(`${v.email}|${v.message.slice(0, 200)}`, 10 * 60 * 1000)) {
    return { status: 429, body: { ok: false, errors: { form: "This looks like a repeat of a message you just sent. I've got the first one." } }, log: ["rejected: duplicate within 10 minutes"] };
  }

  const ref = referenceId(now);
  const log = [];
  let triage = ruleTriage(v);
  if (deps.triage) {
    try {
      const t = checkTriage(await deps.triage(v));
      if (t) triage = t;
      log.push(t ? "triaged by Claude" : "Claude triage unusable, used rules");
    } catch (e) {
      log.push(`Claude triage failed (${e instanceof Error ? e.message : e}), used rules`);
    }
  }

  try {
    await deps.appendRow(sheetRow(v, ref, triage, now));
    log.push("logged to sheet");
  } catch (e) {
    log.push(`sheet failed: ${e instanceof Error ? e.message : e}`);
  }

  const results = await Promise.allSettled([
    deps.sendEmail({ ...confirmationEmail(v, ref, deps.owner) }),
    deps.sendEmail({ ...ownerEmail(v, ref, triage), to: deps.owner.email }),
  ]);
  log.push(results[0].status === "fulfilled" ? "confirmation sent" : `confirmation failed: ${results[0].reason?.message ?? results[0].reason}`);
  log.push(results[1].status === "fulfilled" ? "owner notified" : `owner email failed: ${results[1].reason?.message ?? results[1].reason}`);

  const saved = log.includes("logged to sheet") || results[1].status === "fulfilled";
  if (!saved) return { status: 502, body: { ok: false, errors: { form: "Something went wrong on my side and your message wasn't saved. Please email me directly." } }, log };
  return { status: 200, body: { ok: true, reference: ref, confirmationSent: results[0].status === "fulfilled" }, log, triage };
}

// ---- real integrations, used by api/enquiry.js ----

/** Sends through Resend's HTTP API. */
export function resendSender(apiKey, from) {
  return async (e) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [e.to], reply_to: e.replyTo, subject: e.subject, text: e.text, html: e.html }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/** Appends a row through the small Apps Script web app in apps-script/Webhook.gs. */
export function sheetsWebhook(url, secret) {
  return async (row) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret, row }), redirect: "follow" });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(`Sheets webhook: ${out.error ?? res.status}`);
  };
}

/** Asks Claude for a category, urgency and one-line summary, through a forced tool call. */
export function claudeTriage(apiKey, { model = "claude-haiku-5-5", browser = false } = {}) {
  return async (v) => {
    const headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" };
    if (browser) headers["anthropic-dangerous-direct-browser-access"] = "true";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 300,
        system: "You sort messages sent through a student developer's contact form. Classify the message. The summary is one plain sentence, under 120 characters, saying what the sender wants. Mark spam (SEO offers, crypto, generic marketing) as spam. Urgency is high only if the sender names a near deadline.",
        tools: [{
          name: "triage",
          description: "Record the classification.",
          input_schema: {
            type: "object",
            properties: { category: { type: "string", enum: CATEGORIES }, urgency: { type: "string", enum: ["low", "normal", "high"] }, summary: { type: "string" } },
            required: ["category", "urgency", "summary"],
          },
        }],
        tool_choice: { type: "tool", name: "triage" },
        messages: [{ role: "user", content: `Topic picked: ${v.topic}\nFrom: ${v.name}${v.company ? ` (${v.company})` : ""}\n\n${v.message}` }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}`);
    const out = await res.json();
    return out.content?.find((b) => b.type === "tool_use")?.input ?? null;
  };
}

/** In-memory duplicate check. Good enough per function instance; resets on cold start. */
export function memorySeen() {
  const m = new Map();
  return (key, windowMs) => {
    const now = Date.now();
    for (const [k, t] of m) if (now - t > windowMs) m.delete(k);
    if (m.has(key)) return true;
    m.set(key, now);
    return false;
  };
}
