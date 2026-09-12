Robinhood Stock Arb Scanner V1.3 FAST

Deploy index.html and vercel.json together at the project root.

Changes vs V1.2:
- JSON-RPC batch eth_call with adaptive split fallback
- same-origin /proxy/rpc for the default Robinhood RPC
- first scan discovers live routes; later quick scans use a cached topology
- SELL phase only quotes venues that successfully responded in BUY discovery
- reference REST calls removed from quick-scan critical path
- Shadow Mode never overlaps scans
- scan completion log includes duration

Read-only. No wallet/private key and no transaction sending.
