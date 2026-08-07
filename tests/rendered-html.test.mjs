import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ships the LinkWithBuyers dashboard instead of the starter preview", async () => {
  const [page, layout, campaign, packageJson] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("lib/campaign.ts", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);

  assert.match(layout, /Link With Buyers Dashboard/);
  assert.match(page, /Open LinkedIn/);
  assert.match(page, /Refresh Dashboard/);
  assert.match(page, /Initial Conversation/);
  assert.match(page, /card-toggle-actions/);
  assert.match(page, /\? "Unpin" : "Pin"/);
  assert.doesNotMatch(page, /Follow up directly in LinkedIn/);
  assert.match(page, /Video watched/);
  assert.match(page, /Latest Refresh/);
  assert.match(page, /\? "Unpin" : "Pin"/);
  assert.match(page, /Pinned Cards/);
  assert.match(page, /<h3>Prospects<\/h3>/);
  assert.match(page, /<h3>Archive<\/h3>/);
  assert.doesNotMatch(page, /Priority queue/);
  assert.doesNotMatch(page, /Other activity/);
  assert.doesNotMatch(page, /Campaign summary/);
  assert.doesNotMatch(page, /Action queue view/);
  assert.match(page, /repairCachedView/);
  assert.match(page, /ConversationText/);
  assert.match(page, /Archive prospect/);
  assert.match(page, /link-with-buyers-rabbit\.png/);
  assert.match(page, /fetch\(endpoint, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(page, /POST|PUT|PATCH|DELETE/);
  assert.match(campaign, /reply-before-video/);
  assert.match(campaign, /video wat/);
  assert.match(campaign, /function parseCsv/);
  assert.match(packageJson, /"name": "site-creator-vinext-starter"/);
});
