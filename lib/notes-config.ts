// Write endpoint for dashboard note edits.
//
// The dashboard reads the Sheet through the public CSV export URL, which is
// read-only. Saving a note therefore POSTs to a Google Apps Script web app
// that holds the Google-side permission to write.
//
// This file is bundled into a public static site, so `token` is not a secret.
// The Apps Script enforces the real limits: an allowlist of sheet IDs, a single
// writable column, and no ability to add or remove rows.
export const notesConfig = {
  endpoint:
    "https://script.google.com/macros/s/AKfycbweMP30MtmWl2pwqchQuL4YDaPZEvXM8L21eB1_ZmETGNP6WPqjk0Xzb48fEGWoKhWNNg/exec",
  token: "lwb_rsmo3znI5FVN_EjRpBeg7MbqdwctkL1e",
};
