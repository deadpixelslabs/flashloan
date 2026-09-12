ROBINHOOD STOCK ARB SCANNER V1.1 — CORS FIX

IMPORTANT:
Deploy BOTH files at the project root:
  index.html
  vercel.json

Why V1 failed:
The browser could reach Robinhood Chain RPC, but direct browser requests to the Robinhood/Fletch REST APIs can be blocked by CORS.
V1.1 sends those REST calls to same-origin paths on your Vercel domain. vercel.json rewrites them server-side to the official/public upstream endpoints.

After deploy:
1. Open the site.
2. Click LOAD ASSETS.
3. The log should show: "Official asset registry loaded through same-origin Vercel proxy."
4. Then click SCAN ONCE.

No wallet/private key is required. Scanner remains read-only.
