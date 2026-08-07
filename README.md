# David Zopf Dashboard

This is David Zopf's read-only campaign dashboard. It never writes to the Google Sheet.

## Publish through GitHub

1. Create a new GitHub repository named `david-zopf-dashboard`.
2. Upload the complete contents of this folder.
3. In the repository, open **Settings**, then **Pages**.
4. Under **Build and deployment**, select **GitHub Actions** as the source.
5. The included workflow will publish the dashboard. Its public address will appear in the workflow after it finishes.

David's shareable Google Sheet is already configured in this copy. Refresh Dashboard always reads the current Sheet data.

## Safety

- The dashboard only reads campaign data.
- Pins and archive decisions are stored in the viewer's browser.
- The Google Sheet remains the source of truth.
- The Sheet link is intentionally included because this demonstration uses a shareable Sheet.
