import WEBHOOK from "../apps-script/Webhook.gs?raw";
import { TOPICS, SHEET_HEADERS, claudeTriage, handleEnquiry, memorySeen, validate } from "../lib/enquiry.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;

type Email = { to: string, replyTo?: string, subject: string, text: string, html: string };
const OWNER = { name: "Aarov Makhija", email: "you@yourdomain.com", from: "Aarov Makhija <hello@yourdomain.com>" };
const SAMPLES: Record<string, Record<string, string>> = {
  intern: {
    name: "Meera Iyer", email: "meera.iyer@lanternlabs.example", phone: "+91 98200 12345", company: "Lantern Labs",
    topic: "Internship or job",
    message: "Hi Aarov, I saw your TinyHarness project. We're a small team building internal AI tools and we take two remote interns each summer. Could we set up a 20 minute call this week? Applications close on the 5th.",
  },
  freelance: {
    name: "Rohan Desai", email: "rohan@chaiandcode.example", phone: "", company: "Chai & Code Cafe",
    topic: "Freelance project",
    message: "Hey! We need 4 short reels edited for our cafe's Instagram every month. Raw clips are shot on a phone. What would you charge, and how fast can you turn them around?",
  },
  bot: {
    name: "Best SEO", email: "promo@rank-fast.example", phone: "", company: "",
    topic: "Other",
    message: "We offer cheap SEO services and backlinks to rank your website #1 on Google. Visit http://a.example http://b.example http://c.example http://d.example",
    website: "http://rank-fast.example",
  },
};

let startedAt = 0;
const rows: (string | number)[][] = [];
const seen = memorySeen();

// ---- form setup ----
const topic = field("topic") as unknown as HTMLSelectElement;
for (const t of TOPICS) topic.append(new Option(t, t));
form.addEventListener("focusin", () => { if (!startedAt) startedAt = Date.now(); });

document.querySelectorAll<HTMLButtonElement>("[data-sample]").forEach((b) =>
  b.addEventListener("click", () => {
    const s = SAMPLES[b.dataset.sample!];
    for (const k of ["name", "email", "phone", "company", "topic", "message", "website"]) field(k).value = s[k] ?? "";
    // A person takes a while to type; the bot posts the moment the page loads.
    startedAt = b.dataset.sample === "bot" ? Date.now() : Date.now() - 45_000;
    clearErrors();
    $("thanks").hidden = true;
  }),
);

function clearErrors() {
  form.querySelectorAll(".err").forEach((e) => e.remove());
  form.querySelectorAll("[aria-invalid]").forEach((e) => e.removeAttribute("aria-invalid"));
  $("form-error").textContent = "";
}

function showErrors(errors: Record<string, string>) {
  for (const [k, msg] of Object.entries(errors)) {
    if (k === "form") { $("form-error").textContent = msg; continue; }
    const el = field(k);
    if (!el) continue;
    el.setAttribute("aria-invalid", "true");
    const p = Object.assign(document.createElement("span"), { className: "err", textContent: msg });
    el.closest("label")!.append(p);
  }
  const first = form.querySelector<HTMLElement>("[aria-invalid]");
  first?.focus();
}

function values() {
  const data: Record<string, string | number> = Object.fromEntries(new FormData(form) as any);
  data.startedAt = startedAt;
  return data;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  clearErrors();
  const input = values();
  const pre = validate(input).errors;
  if (Object.keys(pre).length) return showErrors(pre);

  const btn = $<HTMLButtonElement>("send");
  btn.disabled = true;
  btn.textContent = "Sending...";
  try {
    if ($<HTMLInputElement>("live").checked) await sendLive(input);
    else await sendDemo(input);
  } finally {
    btn.disabled = false;
    btn.textContent = "Send message";
  }
});

// ---- demo: the real pipeline, with the sheet and inbox kept in this tab ----
async function sendDemo(input: Record<string, string | number>) {
  const outbox: Email[] = [];
  const key = $<HTMLInputElement>("api-key").value.trim();
  const out = await handleEnquiry(input, {
    sendEmail: async (e: Email) => { await pause(250); outbox.push(e); },
    appendRow: async (r: (string | number)[]) => { await pause(200); rows.unshift(r); },
    triage: key ? claudeTriage(key, { browser: true }) : undefined,
    seen,
    owner: OWNER,
  });
  render(out, outbox);
}

async function sendLive(input: Record<string, string | number>) {
  try {
    const res = await fetch("./api/enquiry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await res.json();
    render({ status: res.status, body, log: [res.ok ? "sent to the live server" : `server answered ${res.status}`] }, []);
  } catch {
    showErrors({ form: "Couldn't reach the server. Check your connection and try again." });
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Out = { status: number, body: any, log: string[], triage?: { category: string, urgency: string, summary: string, source: string } };

function render(out: Out, outbox: Email[]) {
  if (!out.body.ok) showErrors(out.body.errors ?? { form: "Something went wrong." });
  else {
    const thanks = $("thanks");
    thanks.hidden = false;
    thanks.textContent = `Thanks, your message is in. Your reference is ${out.body.reference}.${outbox.length || out.log[0]?.startsWith("sent") ? " A confirmation is on its way to your inbox." : ""}`;
    form.reset();
    startedAt = 0;
  }

  $("empty").hidden = true;
  const steps = $("steps");
  steps.hidden = false;
  steps.replaceChildren(...stepsFor(out).map(([state, title, detail]) => {
    const li = document.createElement("li");
    li.className = state;
    li.append(Object.assign(document.createElement("b"), { textContent: title }));
    if (detail) li.append(Object.assign(document.createElement("span"), { textContent: detail }));
    return li;
  }));

  const them = outbox.find((e) => e.to && e.to !== OWNER.email);
  const you = outbox.find((e) => e.to === OWNER.email);
  $("mails").hidden = !them && !you;
  if (them) {
    $("them-to").textContent = them.to;
    $("them-subject").textContent = them.subject;
    // The HTML is built by lib/enquiry.js with every user value escaped. Show it in a sandboxed frame anyway.
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.title = "Confirmation email";
    frame.srcdoc = `<body style="margin:0;background:#fff">${them.html}</body>`;
    frame.addEventListener("load", () => { frame.style.height = `${(frame.contentDocument?.body.scrollHeight ?? 300) + 8}px`; });
    $("them-body").replaceChildren(frame);
  }
  if (you && out.triage) {
    $("you-subject").textContent = you.subject;
    $("you-body").textContent = you.text;
    const t = out.triage;
    $("you-badges").replaceChildren(
      badge(t.category, `cat-${t.category}`),
      badge(`${t.urgency} urgency`, `urg-${t.urgency}`),
      badge(t.source === "claude" ? "sorted by Claude" : "sorted by rules", "src"),
    );
  }
  drawSheet();
  if (window.matchMedia("(max-width: 900px)").matches) $("res-h").scrollIntoView({ behavior: "smooth", block: "start" });
}

function badge(text: string, cls: string) {
  return Object.assign(document.createElement("span"), { className: `badge ${cls}`, textContent: text });
}

function stepsFor(out: Out): [string, string, string][] {
  const has = (s: string) => out.log.some((l) => l.startsWith(s));
  const line = (s: string) => out.log.find((l) => l.startsWith(s)) ?? "";
  if (out.status === 400) return [["bad", "Checked", "Some fields need fixing, so nothing was saved. The sender sees what to change next to each field."]];
  if (has("dropped as spam")) return [
    ["ok", "Checked", "The fields look fine."],
    ["bad", "Caught as spam", `${line("dropped as spam").replace("dropped as spam: ", "Reason: ")}. The bot is shown a normal "thanks", so it doesn't learn to try harder. Nothing is saved or sent.`],
  ];
  if (out.status === 429) return [["bad", "Repeat", "The same person sent the same message a moment ago. The first one is kept."]];
  if (has("sent to the live server")) return [["ok", "Sent to the live server", "Check the inbox and the sheet."]];
  if (has("server answered")) return [["bad", "The server said no", line("server answered")]];
  const t = out.triage!;
  return [
    ["ok", "Checked", "Name, email and message look real. No spam signals."],
    has("Claude triage failed") || has("Claude triage unusable")
      ? ["warn", "Sorted by keyword rules", `${line("Claude triage")}. ${cap(t.category)}, ${t.urgency} urgency.`]
      : ["ok", t.source === "claude" ? "Sorted by Claude" : "Sorted by keyword rules", `${cap(t.category)}, ${t.urgency} urgency. "${t.summary}"`],
    has("logged to sheet") ? ["ok", "Saved to your sheet", "A new row, before any email goes out."] : ["bad", "Sheet failed", line("sheet failed")],
    has("confirmation sent") ? ["ok", "Confirmation sent to them", `With reference ${out.body.reference}, so they know it arrived.`] : ["bad", "Confirmation failed", line("confirmation failed")],
    has("owner notified") ? ["ok", "You're told", "With a summary at the top. Reply to it and you're replying to them."] : ["bad", "Your email failed", line("owner email failed")],
  ];
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// ---- the sheet ----
function drawSheet() {
  const t = $("sheet");
  const show = [0, 1, 2, 3, 6, 7, 8, 9, 11];
  const head = document.createElement("tr");
  head.append(Object.assign(document.createElement("th"), { className: "rn" }));
  show.forEach((c, i) => head.append(Object.assign(document.createElement("th"), { textContent: `${"ABCDEFGHIJKL"[c]}  ${SHEET_HEADERS[c]}`, className: i === 7 ? "wide" : "" })));
  const body = rows.length
    ? rows.map((r, i) => {
      const tr = document.createElement("tr");
      tr.append(Object.assign(document.createElement("th"), { className: "rn", textContent: String(rows.length - i + 1) }));
      show.forEach((c) => {
        const td = document.createElement("td");
        const v = String(r[c]).replace(/^'/, "");
        if (c === 7 || c === 8) td.append(badge(v, c === 7 ? `cat-${v}` : `urg-${v}`));
        else if (c === 11) td.append(Object.assign(document.createElement("span"), { className: "status", textContent: v }));
        else td.textContent = v;
        if (c === 9) td.className = "wide";
        tr.append(td);
      });
      if (i === 0) tr.className = "fresh";
      return tr;
    })
    : [Object.assign(document.createElement("tr"), { innerHTML: `<td colspan="${show.length + 1}" class="empty-row">No enquiries yet.</td>` })];
  t.replaceChildren(Object.assign(document.createElement("thead"), {}), document.createElement("tbody"));
  t.querySelector("thead")!.append(head);
  t.querySelector("tbody")!.append(...body);
  $("row-count").textContent = rows.length ? `${rows.length} row${rows.length > 1 ? "s" : ""}` : "";
}

$("copy-sheet").addEventListener("click", async (e) => {
  const tsv = [SHEET_HEADERS, ...rows].map((r) => r.map((c) => String(c).replace(/[\t\n]+/g, " ")).join("\t")).join("\n");
  await copy(tsv, e.currentTarget as HTMLButtonElement, "Copied");
});
$("clear").addEventListener("click", () => { rows.length = 0; drawSheet(); });

async function copy(text: string, btn: HTMLButtonElement, done: string) {
  const was = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = done; }
  catch { btn.textContent = "Select and copy"; }
  setTimeout(() => (btn.textContent = was), 1600);
}

// ---- setup code ----
const SNIPPET = `<form id="contact">
  <input name="name" placeholder="Your name" required>
  <input name="email" type="email" placeholder="Email" required>
  <select name="topic">
${TOPICS.map((t) => `    <option>${t}</option>`).join("\n")}
  </select>
  <textarea name="message" required></textarea>
  <!-- bots fill this in, people never see it -->
  <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">
  <button>Send</button>
  <p id="contact-status" role="status"></p>
</form>
<script>
  const f = document.getElementById("contact");
  const opened = Date.now();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = { ...Object.fromEntries(new FormData(f)), startedAt: opened };
    const res = await fetch("https://YOUR-APP.vercel.app/api/enquiry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const out = await res.json();
    document.getElementById("contact-status").textContent = out.ok
      ? "Thanks! Check your inbox for a confirmation (" + out.reference + ")."
      : Object.values(out.errors).join(" ");
    if (out.ok) f.reset();
  });
</script>`;
const CODE = { gs: WEBHOOK, snippet: SNIPPET };
let shown: keyof typeof CODE = "gs";
function showCode() {
  $("code").textContent = CODE[shown];
  document.querySelectorAll<HTMLButtonElement>("[data-code]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.code === shown)));
}
document.querySelectorAll<HTMLButtonElement>("[data-code]").forEach((b) => b.addEventListener("click", () => { shown = b.dataset.code as keyof typeof CODE; showCode(); }));
$("copy-code").addEventListener("click", (e) => copy(CODE[shown], e.currentTarget as HTMLButtonElement, "Copied"));

// ---- live mode, only when this page is served next to a configured /api/enquiry ----
if (location.protocol.startsWith("http")) {
  fetch("./api/enquiry").then((r) => (r.ok ? r.json() : null)).then((s) => {
    if (s?.configured) $("live-wrap").hidden = false;
  }).catch(() => {});
}

showCode();
drawSheet();
