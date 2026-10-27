# Robinhood Flash Loan Atomic Arbitrage V2.1

Scanner and wallet-operated flash-loan executor for Robinhood Chain mainnet (4663).

The scanner reads the official stock-token registry and quotes direct USDG pools on Uniswap V2, V3 and discovered V4 pools. V2/V3 candidates can be executed with the included Morpho receiver. V4 remains scan-only. This version does not run an unattended signer or a 24/7 trading service.

## Use

1. Load assets and scan. Keep Shadow Mode open for repeated scans.
2. Connect a wallet on Robinhood Chain and check Morpho USDG liquidity.
3. Deploy your executor from the page, signing the deployment with your wallet. You can attach an existing executor from this exact compiled version instead.
4. Select a V2/V3 candidate and set minimum desired net profit, slippage and maximum ETH gas budget.
5. Check the atomic route, then execute. Sending rechecks the route and requests a wallet signature.

The wallet needs ETH for deployment and transaction gas. It does not need the loan's USDG principal. Morpho lends only up to its actual USDG balance. A missing deployment, unavailable price, failed quote, insufficient lender balance, stale block or failing whole-transaction call blocks execution. A positive scanner estimate alone is not execution proof.

The executor borrows, buys, sells, repays and pays profit to its immutable owner in one transaction. Only the owner can execute. Callback data is bound to the in-flight request and nonce. Existing base and target-token balances are preserved, and router/lender approvals are scoped and cleared. Minimum token profit is checked onchain; the frontend adds a conservative estimated gas budget to the requested net amount. ETH/USDG valuation remains an estimate. Reverted transactions still spend gas.

## Verified configuration

| Contract | Robinhood mainnet address |
| --- | --- |
| Morpho Blue | `0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010` |
| Uniswap V2 Router02 | `0x89e5db8b5aa49aa85ac63f691524311aeb649eba` |
| Uniswap SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| Uniswap QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| USDG | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |

Official sources: [Robinhood network](https://docs.robinhood.com/chain/connecting/), [Morpho addresses](https://docs.morpho.org/developers/contracts/addresses/), [Morpho flashLoan API](https://docs.morpho.org/developers/contracts/blue/#flashloan), [Uniswap deployments](https://github.com/Uniswap/contracts/blob/main/deployments/4663.md).

## Development and checks

```sh
npm ci
npm run compile
npm run test:contracts
node --test test/scanner.test.mjs test/execution.test.mjs test/rpc-gate.test.mjs test/lifecycle.test.mjs test/rest.test.mjs
```

`contracts/RobinhoodFlashArb.sol` is the receiver; `artifacts/RobinhoodFlashArb.json` contains its ABI, deployment bytecode, runtime bytecode and immutable references. The browser verifies runtime code and immutable configuration before using an attached executor. Ethers is vendored at its pinned version.

`GET /api/health` performs read-only mainnet checks for chain, recent block, deployed dependencies and Morpho USDG balance. It does not verify a trading opportunity or user deployment. The server stores no wallet credentials. Vercel serves the committed static artifact and the dependency-free health function; npm installation is skipped during deployment.

Current scope: direct USDG stock-token pools; all distinct ordered buy/sell pairs across discovered direct pools. Multihop routes and additional base currencies are not included. Whole-route checks must succeed against current mainnet state before a transaction is offered.

## RPC quota handling

All scanner and execution reads share one request queue. Public RPC requests start at least 750 ms apart. The scanner verifies Multicall3 bytecode and groups up to 16 reads into each eth_call; if Multicall is absent, it uses paced individual calls. This supports non-view Uniswap quoters with ordinary CALL inside aggregate3. HTTP 429 or JSON-RPC quota errors pause the queue, honor Retry-After, and retry read operations at most twice. The UI displays a cooldown countdown and preserves errors after an operation finishes. STOP cancels queued scanner work. Load, Quick Scan and Deep Scan cannot overlap.

Onchain token decimals are saved by chain and token address for 24 hours as soon as each chunk succeeds, so a later failure does not discard earlier progress. A reload resumes only missing metadata. No decimals are guessed. Browser scanning still depends on the public RPC remaining available; quota handling is not a dedicated production RPC service.

Optional pool-index requests have an8-second request timeout and15-second total discovery budget. If the pool index is unavailable, scanning continues using cached/partial V4 discovery or V2/V3 pools. STOP also cancels a pending index or registry request.
