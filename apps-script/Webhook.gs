/**
 * Enquiry Desk: the Google Sheets side.
 * Created by Aarov Makhija. MIT licence.
 *
 * 1. In your sheet, open Extensions > Apps Script, paste this file and save.
 * 2. Run setup() once. It makes the "Enquiries" sheet and prints a secret in the log.
 * 3. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
 * 4. Put the web app URL in SHEETS_WEBHOOK_URL and the secret in SHEETS_SECRET on Vercel.
 *
 * The web app only appends rows, and only when the secret matches.
 */

var SHEET_NAME = "Enquiries";
var HEADERS = ["Received", "Reference", "Name", "Email", "Phone", "Company", "Topic", "Category", "Urgency", "Summary", "Message", "Status"];
var STATUSES = ["New", "Replied", "Waiting", "Closed"];

function setup() {
  var sheet = sheet_();
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("SECRET");
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, "");
    props.setProperty("SECRET", secret);
  }
  Logger.log("Sheet ready: " + sheet.getName());
  Logger.log("Your SHEETS_SECRET is: " + secret);
  return secret;
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build();
    sheet.getRange(2, HEADERS.length, 999, 1).setDataValidation(rule);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "bad json" });
  }
  var secret = PropertiesService.getScriptProperties().getProperty("SECRET");
  if (!secret || body.secret !== secret) return json_({ ok: false, error: "wrong secret" });
  var row = body.row;
  if (!Array.isArray(row) || row.length !== HEADERS.length) return json_({ ok: false, error: "row must have " + HEADERS.length + " cells" });

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = sheet_();
    sheet.appendRow(row.map(function (c) { return String(c).slice(0, 5000); }));
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true });
}

function doGet() {
  return json_({ ok: true, service: "enquiry-desk" });
}
