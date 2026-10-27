import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const region=html.slice(html.indexOf('function resolvedRpcEndpoint(){'),html.indexOf('function safeHost(url)'));
const fields={rpc:{value:'https://rpc.mainnet.chain.robinhood.com'},gasStatus:{textContent:''},chainStatus:{textContent:''},bufferBps:{value:'5'},overheadGas:{value:'220000'}};
let response,fetchCount=0;
const context=vm.createContext({URL,Map,Set,Number,BigInt,Date,Math,Error,Promise,AbortController,setTimeout,clearTimeout,
state:{routeCache:new Map(),decimalsCache:new Map()},CHAIN_ID:4663,USDG:'0xbase',WETH:'0xweth',VENUES:[],V2_ROUTER:'0xv2',V3_QUOTER:'0xv3',V4_QUOTER:'0xv4',
window:{location:{href:'https://example.vercel.app/'},dispatchEvent(){}},els:id=>fields[id],log(){},setLive(){},money:n=>String(n),
ethers:{toQuantity:n=>'0x'+BigInt(n).toString(16),parseUnits:()=>1n},erc20Iface:{encodeFunctionData:()=>'',decodeFunctionResult:(_name,value)=>[BigInt(value)]},
fetch:async()=>{fetchCount++;return {ok:true,json:async()=>response};},bigintToNum:(v,dec)=>Number(v)/10**dec});
vm.runInContext(region,context);
assert.equal(vm.runInContext('resolvedRpcEndpoint()',context),'https://example.vercel.app/proxy/rpc');
fields.rpc.value='https://custom.example/rpc';
assert.equal(vm.runInContext('resolvedRpcEndpoint()',context),'https://custom.example/rpc');
context.state.providerEndpoint='https://custom.example/rpc';
const items=[{target:'0xtoken',callData:'0x',meta:{symbol:'A'}}];
context.items=items;
response=[{id:1,error:{code:3,message:'execution reverted'}}];
assert.equal((await vm.runInContext('rpcBatchPost(items,100)',context))[0].success,false);
response=[{id:1,error:{code:-32005,message:'rate limit exceeded'}}];
await assert.rejects(()=>vm.runInContext('rpcBatchWithFallback(items,100,1)',context),/rate limit/);
assert.equal(fetchCount,2,'rate limit must not trigger recursive retries');
response=[];
await assert.rejects(()=>vm.runInContext('rpcBatchPost(items,100)',context),/omitted response/);
assert.equal(vm.runInContext('scoreRow({netProfit:null,netRoi:null},3)',context),0);
const order=vm.runInContext('[{netProfit:null,grossProfit:100},{netProfit:-2,grossProfit:0},{netProfit:3,grossProfit:3}].sort(sortNetRows)',context);
assert.equal(order[0].netProfit,3);assert.equal(order[2].netProfit,null);
context.state.ethUsd=3000;context.state.gasPriceWei=1n;
context.state.provider={send:async()=>{throw new Error('offline');}};
vm.runInContext('rpcCallRaw=async()=>[]',context);
await vm.runInContext('refreshGas(100)',context);
assert.equal(context.state.ethUsd,null,'stale gas reference must be cleared');
assert.equal(context.state.gasPriceWei,null,'failed gas lookup must not fabricate a gas price');
assert.match(fields.gasStatus.textContent,/net unavailable/);
context.assets=[{address:'0xABC',symbol:'SAME'},{address:'0xDEF',symbol:'SAME'}];
vm.runInContext("rpcCallRaw=async()=>[{success:true,meta:{address:'0xABC'},returnData:'6'},{success:true,meta:{address:'0xDEF'},returnData:'18'}]",context);
const verified=await vm.runInContext('loadTokenDecimals(assets,100)',context);
assert.equal(verified.length,2);assert.equal(verified[0].decimals,6);assert.equal(verified[1].decimals,18);
assert.notEqual(vm.runInContext('assetKey(assets[0])',context),vm.runInContext('assetKey(assets[1])',context));
assert.equal(vm.runInContext("isQuoteRevert({code:-32000,message:'missing trie node'})",context),false);
assert.equal(vm.runInContext("isQuoteRevert({code:'CALL_EXCEPTION',message:'reverted'})",context),true);
console.log('PASS: endpoint consistency; RPC failures vs reverts; no rate-limit retry storm; unknown/stale gas fail closed; null net ranking; verified per-address decimals; symbol collision isolation.');
let scanEvent;
context.CustomEvent=class {constructor(type,init){this.type=type;this.detail=init.detail;}};
context.window.dispatchEvent=event=>{scanEvent=event;};
context.nowIso=()=>new Date().toISOString();context.venueLabel=x=>x;
context.state={provider:{send:async()=>({hash:'0xblock',timestamp:'0x65'})},routeCache:new Map(),v4Pools:new Map(),streaks:new Map(),quickScanCount:0,scanSeq:0,usdgDecimals:6,gasPriceWei:null,ethUsd:null};
context.asset={address:'0xABC',symbol:'SAME',name:'A',decimals:6};
context.buy={type:'v3',venue:'V3-500',fee:500,amountOut:2_000_000n,gasEstimate:110_000n};
context.sell={type:'v2',venue:'V2',amountOut:1_000_000n,gasEstimate:125_000n};
context.bestV4={type:'v4',venue:'V4:pool1',poolId:'pool1',fee:3000,amountOut:3_000_000n,gasEstimate:140_000n};
context.state.v4Pools.set('0xabc',[{poolId:'pool1',currency0:'0xbase',currency1:'0xabc',fee:3000,tickSpacing:60,hooks:'0xhook'}]);
context.v2Iface={encodeFunctionData:(name,args)=>({name,args})};
context.v3Iface=context.v2Iface;context.v4Iface=context.v2Iface;
context.allBuys=new Map([['0xabc',[context.bestV4,context.buy,context.sell]]]);
const pairCalls=vm.runInContext('buildSellCallsFromBuyMap([asset],allBuys)',context);
assert.equal(pairCalls.length,6,'three live venues must produce six ordered distinct pairs');
assert.equal(new Set(pairCalls.map(call=>call.meta.sourceBuyVenue+'>'+call.meta.venue)).size,6);
for(const call of pairCalls){
  const source=context.allBuys.get('0xabc').find(buy=>buy.venue===call.meta.sourceBuyVenue);
  assert.notEqual(call.meta.venue,source.venue);
  assert.equal(call.meta.amountIn,source.amountOut,'sell amount must be the specific buy output');
  assert.equal(call.meta.sourceBuyAmountRaw,source.amountOut.toString());
  const encodedAmount=call.meta.type==='v2'?call.callData.args[0]:call.meta.type==='v3'?call.callData.args[0][2]:call.callData.args[0][2];
  assert.equal(encodedAmount,source.amountOut,'encoded sell calldata must use the exact paired buy output');
}
const pairOutputs=new Map([
  ['V3-500>V2',1_001_000_000n],['V2>V3-500',1_002_000_000n],
  ['V4:pool1>V3-500',1_005_000_000n],['V4:pool1>V2',1_004_000_000n],
  ['V3-500>V4:pool1',1_003_000_000n],['V2>V4:pool1',1_000_000_000n]
]);
context.allSells=new Map([['0xabc',pairCalls.map(call=>({...call.meta,amountOut:pairOutputs.get(call.meta.sourceBuyVenue+'>'+call.meta.venue),gasEstimate:call.meta.type==='v4'?140_000n:call.meta.type==='v2'?125_000n:110_000n}))]]);
context.quoteMaps=[context.allBuys,context.allSells];
vm.runInContext("initProvider=async()=>100;loadTokenDecimals=async assets=>assets;refreshGas=async()=>{};buildQuoteCalls=()=>[];rpcCallRaw=async()=>[];decodeQuotes=()=>quoteMaps.shift();logVenueHits=()=>{};",context);
const scanRows=await vm.runInContext("scanAtSize([asset],1000,'quick',false,false)",context);
assert.equal(scanRows.length,6);
const executableRows=scanRows.filter(row=>row.executionSupported);
assert.equal(executableRows.length,2,'best V4 buy must not hide executable V2/V3 pairs');
assert.equal(new Set(scanRows.map(row=>row.routePairId)).size,6);
const v3ToV2=scanRows.find(row=>row.buyVenue==='V3-500'&&row.sellVenue==='V2');
assert.equal(v3ToV2.buyTokenQty,2);
assert.equal(v3ToV2.amountInRaw,'1');assert.equal(v3ToV2.buyAmountRaw,'2000000');
assert.equal(v3ToV2.sellAmountRaw,'1001000000');assert.equal(v3ToV2.netProfit,null);
assert.equal(v3ToV2.tokenDecimals,6);assert.equal(v3ToV2.blockHash,'0xblock');
assert.equal(v3ToV2.buyRoute.fee,500);assert.equal(v3ToV2.sellRoute.type,'v2');
assert.equal(scanEvent.type,'arb:scan');assert.equal(scanEvent.detail.rows[0],scanRows[0]);
assert.equal(scanRows.filter(row=>row.buyRoute.type==='v4'||row.sellRoute.type==='v4').every(row=>!row.executionSupported),true);
context.state.gasPriceWei=1n;context.state.ethUsd=1000;context.state.ethUsdQuoteBlock=100;
context.quoteMaps=[context.allBuys,context.allSells];
const pricedRows=await vm.runInContext("scanAtSize([asset],1000,'quick',false,false)",context);
assert.equal(pricedRows.every(row=>Number.isFinite(row.netProfit)),true);
assert.equal(pricedRows[0].buyVenue,'V4:pool1');assert.equal(pricedRows[0].sellVenue,'V3-500');
assert.equal(pricedRows[0].gasUnits,140_000+110_000+220_000);
console.log('PASS: all six ordered pairs retain exact per-buy calldata amounts, unique identity, metadata and source block; executable V2/V3 pairs survive a better V4 buy; gas/net rank complete pairs; unknown gas stays null.');
