import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/campaign.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const campaign = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const header = "Lead First Name,Lead Last Name,Video Sent,Notes,Lead Profile URL,Lead Title,Lead Location,Lead Company Name,Timestamp,Event Type";
const sourceData = [
  header,
  'Maya,Ng,,"Maya: Could you send more detail?",https://linkedin.example/maya,VP Sales,Nashville,Acme,2026-07-29T09:00:00Z,connection_request_accepted',
  'Jon,Hall,07/28/2026,"Carlton: [video watched]",https://linkedin.example/jon,Founder,Nashville,Signal,2026-07-29T08:00:00Z,connection_request_accepted',
  'Nia,Price,07/28/2026,"Carlton: [video watched]\nCarlton: Thank you for watching the video.",https://linkedin.example/nia,CEO,Atlanta,Northstar,2026-07-29T07:00:00Z,connection_request_accepted',
  'Ari,Moore,07/28/2026,"Carlton: [video sent]",https://linkedin.example/ari,Director,Nashville,Point,2026-07-29T06:00:00Z,connection_request_accepted',
].join("\n");

const summaryOnlyData = [
  "Lead First Name,Lead Last Name,Video Sent,Lead Phone,Lead Email,Notes,Summary,Last Searched,Lead Profile URL,Lead Title,Lead Location,Lead Company Name,Timestamp,Event Type",
  'Warren,Brown,07/27/2026,,,"Warren: Let’s talk Friday.\nCarlton: Sounds good.",07/28/2026,https://linkedin.example/warren,,,,,,',
].join("\n");

const watchedDateData = [
  "Lead First Name,Lead Last Name,Video Sent,Notes,Summary,Last Searched,Lead Profile URL,Timestamp,Event Type",
  'Bea,Stone,07/20/2026,,"Carlton: [video watched]",07/24/2026,https://linkedin.example/bea,2026-07-25T08:00:00Z,connection_request_accepted',
].join("\n");

test("parses multiline activity and prioritizes campaign exceptions", () => {
  const records = campaign.normalizeRows(campaign.parseCsv(sourceData));
  assert.equal(records.length, 4);
  assert.equal(records.find((record) => record.firstName === "Maya").kind, "reply-before-video");
  assert.equal(records.find((record) => record.firstName === "Jon").kind, "watched");
  assert.equal(records.find((record) => record.firstName === "Nia").kind, "watched-complete");
  assert.equal(records.find((record) => record.firstName === "Ari").kind, "video-sent");
  assert.equal(records.find((record) => record.firstName === "Maya").hasVideoSent, false);
  assert.equal(records.find((record) => record.firstName === "Jon").hasVideoSent, true);
});

test("reports the latest usable Video Sent date and simplifies US locations", () => {
  const records = campaign.normalizeRows(campaign.parseCsv(sourceData));
  assert.equal(campaign.latestVideoSent(records), "07/28/2026");
  assert.equal(campaign.formatDateOnly(campaign.latestVideoSent(records)), "Jul 28, 2026");
  assert.equal(campaign.simplifyLocation("Nashville, Tennessee, United States"), "Nashville, Tennessee");
});

test("keeps quote and newline content together in the Notes field", () => {
  const records = campaign.normalizeRows(campaign.parseCsv(sourceData));
  const record = records.find((item) => item.firstName === "Nia");
  assert.match(record.notes, /\n/);
  assert.match(record.notes, /Thank you for watching/);
});

test("uses Summary as the conversation source when Notes is empty", () => {
  const [record] = campaign.normalizeRows(campaign.parseCsv(summaryOnlyData));
  assert.match(record.notes, /Let’s talk Friday/);
  assert.match(record.notes, /Carlton: Sounds good/);
});

test("uses column C for video sent and column H for a watched video date", () => {
  const [record] = campaign.normalizeRows(campaign.parseCsv(watchedDateData));
  assert.equal(record.hasVideoSent, true);
  assert.equal(record.videoSent, "07/20/2026");
  assert.equal(record.hasWatched, true);
  assert.equal(record.watchedAt, "07/24/2026");
});

test("recognizes the video watrched marker in column G", () => {
  const data = [
    "Lead First Name,Lead Last Name,Video Sent,Lead Phone,Lead Email,Notes,Summary,Last Searched,Lead Profile URL,Lead Title,Lead Location,Lead Company Name,Timestamp,Event Type",
    'Ira,West,07/20/2026,,,,"Carlton: [video watrched]",07/24/2026,https://linkedin.example/ira,Founder,Nashville,Acme,2026-07-25T08:00:00Z,connection_request_accepted',
  ].join("\n");
  const [record] = campaign.normalizeRows(campaign.parseCsv(data));
  assert.equal(record.hasWatched, true);
  assert.equal(record.watchedAt, "07/24/2026");
});

test("continues to use the correct column positions when a source header is malformed", () => {
  const data = [
    "Unexpected first header,Lead Last Name,Video Sent,Lead Phone,Lead Email,Notes,Unexpected summary header,Last Searched,Lead Profile URL,Lead Title,Lead Location,Lead Company Name,Timestamp,Event Type",
    'Rae,Walker,07/20/2026,555-0100,rae@example.com,,"[video watched]",07/24/2026,https://linkedin.example/rae,Founder,"Nashville, Tennessee, United States",Acme,2026-07-25T08:00:00Z,connection_request_accepted',
  ].join("\n");
  const [record] = campaign.normalizeRows(campaign.parseCsv(data));
  assert.equal(record.fullName, "Rae Walker");
  assert.equal(record.hasVideoSent, true);
  assert.equal(record.watchedAt, "07/24/2026");
});

test("uses the approved local display correction for Christopher Block MBA", () => {
  const data = [
    "Lead First Name,Lead Last Name,Video Sent,Lead Phone,Lead Email,Notes,Summary,Last Searched,Lead Profile URL,Lead Title,Lead Location,Lead Company Name,Timestamp,Event Type",
    'Christopher,MBA,08/05/2026,,,,,,https://www.linkedin.com/in/ACoAAAJlcqgBP1UDV-tbzWOq3wFj8oEljYwd3z8,Director of Sales,Seattle,Arctic Club Hotel,2026-08-04T20:34:26Z,connection_request_accepted',
  ].join("\n");
  const [record] = campaign.normalizeRows(campaign.parseCsv(data));
  assert.equal(record.fullName, "Christopher Block MBA");
});
