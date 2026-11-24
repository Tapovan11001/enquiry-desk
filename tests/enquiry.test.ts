import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  checkTriage, confirmationEmail, handleEnquiry, memorySeen, referenceId, ruleTriage, sheetRow, spamReason, validate, SHEET_HEADERS,
} from "../lib/enquiry.js";
import handler, { missingConfig } from "../api/enquiry.js";

const NOW = new Date("2026-11-24T10:30:00Z");
const good = {
  name: "Meera Iyer",
  email: "Meera@Example.org ",
  phone: "+91 98200 12345",
  company: "Lantern Labs",
  topic: "Internship or job",
  message: "Hi! We're hiring a summer intern for our tools team. Could we talk this week?",
  website: "",
  startedAt: NOW.getTime() - 60_000,
};

function fakeDeps(over: Record<string, unknown> = {}) {
  const sent: any[] = [];
  const rows: any[][] = [];
  const order: string[] = [];
  return {
    sent, rows, order,
    deps: {
      sendEmail: async (e: any) => { order.push(`email:${e.to}`); sent.push(e); },
      appendRow: async (r: any[]) => { order.push("row"); rows.push(r); },
      seen: memorySeen(),
      now: () => NOW,
      owner: { name: "Aarov Makhija", email: "owner@example.com", from: "Aarov <hi@example.com>" },
      ...over,
    },
  };
}

test("validate tidies input and explains each problem", () => {
  const ok = validate(good);
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value.email, "meera@example.org");
  const bad = validate({ name: "A", email: "nope", phone: "call me", topic: "Pizza", message: "hi" });
  assert.deepEqual(Object.keys(bad.errors).sort(), ["email", "message", "name", "phone", "topic"]);
  assert.match(bad.errors.message, /sentence or two/);
});

test("spam signals: honeypot, instant posts, link floods, spam phrases", () => {
  const v = validate(good).value;
  const t = NOW.getTime();
  assert.equal(spamReason(v, t), null);
  assert.equal(spamReason({ ...v, website: "http://x.co" }, t), "honeypot filled");
  assert.equal(spamReason({ ...v, startedAt: t - 1000 }, t), "sent within 3 seconds of opening");
  assert.equal(spamReason({ ...v, message: "a http://1 http://2 http://3 http://4" }, t), "more than 3 links");
  assert.equal(spamReason({ ...v, message: "Cheap SEO services and backlinks for your site" }, t), "spam phrases");
});

test("a good enquiry is saved first, then both emails go out", async () => {
  const f = fakeDeps();
  const out = await handleEnquiry(good, f.deps);
  assert.equal(out.status, 200);
  assert.match(out.body.reference!, /^ED-261124-[2-9A-HJ-NP-Z]{4}$/);
  assert.equal(out.body.confirmationSent, true);
  assert.equal(f.order[0], "row", "the sheet row is written before any email");
  assert.deepEqual(f.order.slice(1).sort(), ["email:meera@example.org", "email:owner@example.com"]);

  const [confirm, owner] = [f.sent.find((e) => e.to === "meera@example.org"), f.sent.find((e) => e.to === "owner@example.com")];
  assert.match(confirm.subject, /Got your message \(ED-/);
  assert.match(confirm.text, /^Hi Meera,/);
  assert.match(confirm.text, /two working days/);
  assert.equal(confirm.replyTo, "owner@example.com");
  assert.equal(owner.replyTo, "meera@example.org", "replying to the owner email answers the sender");
  assert.match(owner.subject, /^\[Urgent\] New enquiry from Meera Iyer/);

  const row = f.rows[0];
  assert.equal(row.length, SHEET_HEADERS.length);
  assert.equal(row[0], "2026-11-24 16:00", "timestamps are in IST");
  assert.equal(row[4], "'+91 98200 12345", "a leading + is kept as text, not a formula");
  assert.deepEqual([row[7], row[8], row[11]], ["opportunity", "high", "New"]);
  assert.deepEqual(out.log, ["logged to sheet", "confirmation sent", "owner notified"]);
});

test("bots get a normal-looking success and nothing is saved or sent", async () => {
  const f = fakeDeps();
  const out = await handleEnquiry({ ...good, website: "spam.example" }, f.deps);
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(f.rows.length + f.sent.length, 0);
  assert.deepEqual(out.log, ["dropped as spam: honeypot filled"]);
});

test("invalid input is rejected with field errors", async () => {
  const f = fakeDeps();
  const out = await handleEnquiry({ ...good, email: "meera@" }, f.deps);
  assert.equal(out.status, 400);
  assert.ok(out.body.errors?.email);
  assert.equal(f.rows.length, 0);
});

test("the same message twice in ten minutes is only handled once", async () => {
  const f = fakeDeps();
  assert.equal((await handleEnquiry(good, f.deps)).status, 200);
  const again = await handleEnquiry(good, f.deps);
  assert.equal(again.status, 429);
  assert.equal(f.rows.length, 1);
});

test("if email fails the enquiry is still saved; if everything fails the sender is told", async () => {
  const fail = async () => { throw new Error("Resend 500"); };
  const f = fakeDeps({ sendEmail: fail });
  const out = await handleEnquiry(good, f.deps);
  assert.equal(out.status, 200);
  assert.equal(out.body.confirmationSent, false);
  assert.equal(f.rows.length, 1);
  assert.ok(out.log.includes("confirmation failed: Resend 500"));

  const g = fakeDeps({ sendEmail: fail, appendRow: async () => { throw new Error("quota"); } });
  const worst = await handleEnquiry(good, g.deps);
  assert.equal(worst.status, 502);
  assert.match(worst.body.errors!.form, /wasn't saved/);
});

test("Claude's triage is used when valid, and the rules take over when it isn't", async () => {
  const f = fakeDeps({ triage: async () => ({ category: "opportunity", urgency: "normal", summary: "Lantern Labs wants to talk about a summer internship." }) });
  const out = await handleEnquiry(good, f.deps);
  assert.equal(out.triage?.source, "claude");
  assert.equal(f.rows[0][9], "Lantern Labs wants to talk about a summer internship.");

  const g = fakeDeps({ triage: async () => ({ category: "VIP", urgency: "high", summary: "x" }) });
  const out2 = await handleEnquiry(good, g.deps);
  assert.equal(out2.triage?.source, "rules");
  assert.ok(out2.log.includes("Claude triage unusable, used rules"));

  const h = fakeDeps({ triage: async () => { throw new Error("timeout"); } });
  assert.equal((await handleEnquiry(good, h.deps)).status, 200);

  assert.equal(checkTriage({ category: "spam", urgency: "low", summary: "" }), null);
});

test("rules, references, rows and HTML escaping", () => {
  const v = validate({ ...good, topic: "Freelance project", message: "Can you edit 4 reels for our cafe? Budget is fixed." }).value;
  assert.equal(ruleTriage(v).category, "project");
  assert.equal(referenceId(NOW, () => 0), "ED-261124-2222");
  const formula = sheetRow({ ...v, name: "=HYPERLINK(\"x\")" }, "ED-1", ruleTriage(v), NOW);
  assert.equal(formula[2], "'=HYPERLINK(\"x\")");
  const html = confirmationEmail({ ...v, message: "<script>alert(1)</script>" }, "ED-1", { name: "A", email: "a@b.co" }).html;
  assert.ok(!html.includes("<script>") && html.includes("&lt;script&gt;"));
});

// ---- the Vercel function, with fetch faked ----

function fakeRes() {
  const r: any = { code: 0, headers: {} as Record<string, string>, body: undefined };
  r.status = (c: number) => { r.code = c; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; };
  return r;
}
const ENV = { RESEND_API_KEY: "re_test", RESEND_FROM: "Aarov <hi@example.com>", OWNER_EMAIL: "owner@example.com", SHEETS_WEBHOOK_URL: "https://script.google.com/macros/s/x/exec", SHEETS_SECRET: "s3cret" };

test("the API reports missing settings instead of failing quietly", async () => {
  assert.deepEqual(missingConfig({}), ["RESEND_API_KEY", "RESEND_FROM", "OWNER_EMAIL", "SHEETS_WEBHOOK_URL", "SHEETS_SECRET"]);
  const res = fakeRes();
  await handler({ method: "POST", headers: {}, body: good }, res, {});
  assert.equal(res.code, 503);
  const get = fakeRes();
  await handler({ method: "GET", headers: {} }, get, ENV);
  assert.deepEqual(get.body, { ok: true, configured: true });
});

test("the API calls Resend twice and the Sheets webhook once", async () => {
  const calls: { url: string, body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(url.includes("resend") ? { id: "1" } : { ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const res = fakeRes();
    await handler({ method: "POST", headers: { "x-forwarded-for": "1.2.3.4", "content-type": "application/json" }, body: JSON.stringify({ ...good, startedAt: Date.now() - 30_000 }) }, res, ENV);
    assert.equal(res.code, 200);
    assert.equal(res.body.ok, true);
    assert.equal(calls.filter((c) => c.url.includes("resend")).length, 2);
    const sheet = calls.find((c) => c.url.includes("script.google"))!;
    assert.equal(sheet.body.secret, "s3cret");
    assert.equal(sheet.body.row.length, 12);
    assert.equal(res.headers["access-control-allow-origin"], "*");

    const blocked = fakeRes();
    await handler({ method: "POST", headers: { origin: "https://evil.example" }, body: good }, blocked, { ...ENV, ALLOWED_ORIGINS: "https://aarov.dev" });
    assert.equal(blocked.code, 403);
  } finally {
    globalThis.fetch = real;
  }
});

// ---- the Apps Script side, in a fake Apps Script ----

test("Webhook.gs appends rows only with the right secret", () => {
  const rows: string[][] = [];
  const props = new Map<string, string>();
  const sheet = {
    getName: () => "Enquiries",
    getLastRow: () => rows.length,
    appendRow: (r: string[]) => rows.push(r),
    setFrozenRows: () => {},
    getRange: () => ({ setFontWeight: () => {}, setDataValidation: () => {} }),
  };
  let made = false;
  const ctx: any = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: () => (made ? sheet : null), insertSheet: () => { made = true; return sheet; } }),
      newDataValidation: () => ({ requireValueInList: () => ({ build: () => ({}) }) }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v) }) },
    Utilities: { getUuid: () => "1234-abcd" },
    Logger: { log: () => {} },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    ContentService: { MimeType: { JSON: "json" }, createTextOutput: (s: string) => ({ setMimeType: () => JSON.parse(s) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../apps-script/Webhook.gs", import.meta.url), "utf8"), ctx);
  const secret = ctx.setup();
  assert.equal(secret, "1234abcd");
  assert.equal(rows[0][0], "Received");

  const post = (body: unknown) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  const row = sheetRow(validate(good).value, "ED-1", ruleTriage(validate(good).value), NOW);
  assert.deepEqual(post({ secret: "wrong", row }), { ok: false, error: "wrong secret" });
  assert.deepEqual(post({ secret, row: [1, 2] }), { ok: false, error: "row must have 12 cells" });
  assert.deepEqual(post({ secret, row }), { ok: true });
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], "ED-1");
});
