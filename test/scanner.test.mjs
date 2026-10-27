import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {ethers} from 'ethers';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const region=html.slice(html.indexOf('function resolvedRpcEndpoint(){'),html.indexOf('function safeHost(url)'));
const address=n=>'0x'+n.toString(16).padStart(40,'0');
const multiIface=new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
const erc20Iface=new ethers.Interface(['function decimals() view returns(uint8)']);
const v2Iface=new ethers.Interface(['function getAmountsOut(uint256 amountIn,address[] path) view returns(uint256[])']);
const v3Iface=new ethers.Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256,uint160,uint32,uint256)']);
const v4Iface=new ethers.Interface(['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256,uint256)']);
const deployedCode='0x60806382ad56cb60005260206000f3';
function harness(){
  const h={requests:[],storage:new Map(),handler:null};
  h.fields={rpc:{value:'https://custom.example/rpc'},gasStatus:{textContent:''},chainStatus:{textContent:''},bufferBps:{value:'5'},overheadGas:{value:'220000'}};
  const gate={request:async(url,payload,options={})=>{
    assert.equal(Array.isArray(payload),false,'scanner transport must never create a JSON-RPC batch');
    h.requests.push({url,payload,options});
    const result=await h.handler(payload,options);
    return {jsonrpc:'2.0',id:payload.id,...result};
  },provider:(library,endpoint,options)=>{h.providerOptions={library,endpoint,options};return {destroy(){},send:async(method,params)=>{
    const reply=await gate.request('https://custom.example/rpc',{jsonrpc:'2.0',id:999,method,params});
    if(reply.error) throw Object.assign(new Error(reply.error.message),reply.error);
    return reply.result;
  }}}};
  h.context=vm.createContext({URL,Map,Set,Number,BigInt,Date,Math,Error,Promise,AbortController,setTimeout,clearTimeout,
    state:{routeCache:new Map(),decimalsCache:new Map(),providerEndpoint:'https://custom.example/rpc'},
    CHAIN_ID:4663,USDG:address(1),WETH:address(2),VENUES:[],V2_ROUTER:address(3),V3_QUOTER:address(4),V4_QUOTER:address(5),MULTICALL3:address(6),
    window:{location:{href:'https://example.vercel.app/'},RhRpcGate:gate,dispatchEvent(){}},
    localStorage:{getItem:key=>h.storage.get(key)??null,setItem:(key,value)=>h.storage.set(key,value)},
    els:id=>h.fields[id],log(){},setLive(){},money:n=>String(n),ethers,multiIface,erc20Iface,v2Iface,v3Iface,v4Iface,
    bigintToNum:(value,decimals)=>Number(ethers.formatUnits(value,decimals)),chunks:(array,count)=>Array.from({length:Math.ceil(array.length/count)},(_,i)=>array.slice(i*count,(i+1)*count))});
  vm.runInContext(region,h.context);return h;
}
const h=harness(),c=h.context;
h.fields.rpc.value='https://rpc.mainnet.chain.robinhood.com';
assert.equal(vm.runInContext('resolvedRpcEndpoint()',c),'https://example.vercel.app/proxy/rpc');
h.fields.rpc.value='https://custom.example/rpc';
assert.equal(vm.runInContext('resolvedRpcEndpoint()',c),'https://custom.example/rpc');
let active=0,maxActive=0,aggregateCount=0;
h.handler=async request=>{
  active++;maxActive=Math.max(maxActive,active);
  try{
    await new Promise(resolve=>setTimeout(resolve,1));
    if(request.method==='eth_getCode'){assert.equal(request.params[1],'0x64');return {result:deployedCode};}
    assert.equal(request.method,'eth_call');assert.equal(request.params[0].to,address(6));assert.equal(request.params[1],'0x64');
    assert.equal('staticcall' in request.params[0],false,'non-view quoters must use ordinary calls inside eth_call');
    const calls=multiIface.decodeFunctionData('aggregate3',request.params[0].data)[0];
    assert.ok(calls.length<=16);assert.ok(calls.every(call=>call.allowFailure===true));aggregateCount++;
    return {result:multiIface.encodeFunctionResult('aggregate3',[calls.map((call,index)=>[index!==0,index===0?'0x':v3Iface.encodeFunctionResult('quoteExactInputSingle',[7n,0,0,110000])])])};
  }finally{active--;}
};
c.quoteCalls=Array.from({length:34},(_,index)=>({target:address(4),callData:v3Iface.encodeFunctionData('quoteExactInputSingle',[[address(1),address(20),1n,500,0]]),meta:{index,type:'v3'}}));
const aggregated=await vm.runInContext("rpcCallRaw(quoteCalls,100,'TEST')",c);
assert.equal(aggregated.length,34);assert.equal(aggregateCount,3);assert.equal(h.requests.length,4,'34 quotes must use one code check and three aggregate calls');
assert.equal(maxActive,1);assert.equal(aggregated.filter(result=>!result.success).length,3,'reverting subcalls must not be retried');
assert.equal(aggregated[17].meta.index,17);assert.equal(v3Iface.getFunction('quoteExactInputSingle').stateMutability,'nonpayable');
const fallback=harness();
fallback.context.calls=c.quoteCalls.slice(0,3);
fallback.handler=async request=>request.method==='eth_getCode'?{result:'0x'}:{result:'0x1234'};
const singles=await vm.runInContext("rpcCallRaw(calls,100,'NO MULTICALL')",fallback.context);
assert.equal(singles.length,3);assert.equal(fallback.requests.length,4);assert.equal(fallback.requests.filter(r=>r.payload.method==='eth_call').every(r=>r.payload.params[0].to===address(4)&&r.payload.params[1]==='0x64'),true);
const quota=harness();quota.context.calls=c.quoteCalls;
quota.handler=async request=>{if(request.method==='eth_getCode')return {result:deployedCode};throw Object.assign(new Error('RPC HTTP 429'),{rpcRateLimited:true,rpcInfrastructure:true,status:429,retryAt:1234});};
await assert.rejects(()=>vm.runInContext("rpcCallRaw(calls,100,'QUOTA')",quota.context),error=>error.rpcRateLimited&&error.retryAt===1234);
assert.equal(quota.requests.length,2,'quota exhaustion must not trigger nested splitting or single-call retries');
const absentSelector=harness();absentSelector.context.calls=c.quoteCalls.slice(0,1);
absentSelector.handler=async request=>request.method==='eth_getCode'?{result:'0x60006000'}:{result:'0x1234'};
await vm.runInContext("rpcCallRaw(calls,100)",absentSelector.context);
assert.equal(absentSelector.requests[1].payload.params[0].to,address(4),'unverified aggregate3 bytecode must use direct calls');
const initialized=harness();initialized.context.state.operationAbort=new AbortController();
initialized.handler=async request=>({result:request.method==='eth_chainId'?'0x1237':request.method==='eth_blockNumber'?'0x64':erc20Iface.encodeFunctionResult('decimals',[6])});
assert.equal(await vm.runInContext('initProvider()',initialized.context),100);
assert.equal(initialized.providerOptions.endpoint,'https://custom.example/rpc');
assert.equal(initialized.providerOptions.options.getSignal(),initialized.context.state.operationAbort.signal);
assert.equal(initialized.context.state.usdgDecimals,6);
const persistedBase=JSON.parse(initialized.storage.get('rh-verified-token-decimals-4663-v1'));
assert.equal(persistedBase[address(1)].decimals,6,'base token decimals must also be verified and persisted');
const stopped=harness();stopped.context.calls=c.quoteCalls;stopped.context.state.operationAbort=new AbortController();
stopped.handler=async request=>{
  if(request.method==='eth_getCode')return {result:deployedCode};
  const calls=multiIface.decodeFunctionData('aggregate3',request.params[0].data)[0];
  return {result:multiIface.encodeFunctionResult('aggregate3',[calls.map(()=>[true,'0x1234'])])};
};
await assert.rejects(()=>vm.runInContext("rpcCallRaw(calls,100,'STOP TEST',()=>state.operationAbort.abort())",stopped.context),error=>error.name==='AbortError');
assert.equal(stopped.requests.length,2,'STOP must prevent the next aggregate from entering the gate');
console.log('PASS: 34 non-view quotes use three serial aggregate3 calls at one block; reverts are not retried; missing Multicall uses paced singles; quota errors preserve cooldown without a retry storm.');
const decimals=harness();
decimals.context.assets=Array.from({length:20},(_,index)=>({address:address(100+index),symbol:'TOKEN'+index}));
let decimalAggregates=0;
decimals.handler=async request=>{
  if(request.method==='eth_getCode')return {result:deployedCode};
  decimalAggregates++;
  if(decimalAggregates===2) throw Object.assign(new Error('rate limit'),{rpcRateLimited:true,status:429});
  const calls=multiIface.decodeFunctionData('aggregate3',request.params[0].data)[0];
  return {result:multiIface.encodeFunctionResult('aggregate3',[calls.map(()=>[true,erc20Iface.encodeFunctionResult('decimals',[6])])])};
};
await assert.rejects(()=>vm.runInContext('loadTokenDecimals(assets,100)',decimals.context),/rate limit/);
const cacheKey='rh-verified-token-decimals-4663-v1';
assert.equal(Object.keys(JSON.parse(decimals.storage.get(cacheKey))).length,16,'completed chunk must persist before a later429');
const resumed=harness();resumed.storage.set(cacheKey,decimals.storage.get(cacheKey));resumed.context.assets=decimals.context.assets;
resumed.handler=async request=>{
  if(request.method==='eth_getCode')return {result:deployedCode};
  const calls=multiIface.decodeFunctionData('aggregate3',request.params[0].data)[0];assert.equal(calls.length,4,'reload must only request the four missing decimals');
  return {result:multiIface.encodeFunctionResult('aggregate3',[calls.map(()=>[true,erc20Iface.encodeFunctionResult('decimals',[18])])])};
};
const restored=await vm.runInContext('loadTokenDecimals(assets,100)',resumed.context);
assert.equal(restored.length,20);assert.equal(restored[0].decimals,6);assert.equal(restored[19].decimals,18);
const beforeCached=resumed.requests.length;await vm.runInContext('loadTokenDecimals(assets,101)',resumed.context);assert.equal(resumed.requests.length,beforeCached,'valid24h decimals must not query RPC again');
const oldRecord={chainId:4663,decimals:6,verifiedAt:Date.now()-25*60*60*1000};
const stale=harness();stale.storage.set(cacheKey,JSON.stringify({[address(100)]:oldRecord,[address(101)]:{...oldRecord,chainId:1,verifiedAt:Date.now()}}));
stale.context.assets=decimals.context.assets.slice(0,2);
stale.handler=async request=>request.method==='eth_getCode'?{result:'0x'}:{result:erc20Iface.encodeFunctionResult('decimals',[9])};
const staleResult=await vm.runInContext('loadTokenDecimals(assets,100)',stale.context);assert.equal(staleResult[0].decimals,9);assert.equal(stale.requests.length,3,'expired/wrong-chain values must be verified again');
const partialSingles=harness();partialSingles.context.assets=decimals.context.assets.slice(0,3);let individualCount=0;
partialSingles.handler=async request=>{if(request.method==='eth_getCode')return {result:'0x'};if(++individualCount===2)throw new Error('offline');return {result:erc20Iface.encodeFunctionResult('decimals',[8])};};
await assert.rejects(()=>vm.runInContext('loadTokenDecimals(assets,100)',partialSingles.context),/offline/);
assert.equal(Object.keys(JSON.parse(partialSingles.storage.get(cacheKey))).length,1,'fallback must persist each completed individual result');
const revertedMetadata=harness();revertedMetadata.context.assets=decimals.context.assets.slice(0,1);
revertedMetadata.handler=async request=>request.method==='eth_getCode'?{result:deployedCode}:{result:multiIface.encodeFunctionResult('aggregate3',[[[false,'0x']]])};
assert.equal((await vm.runInContext('loadTokenDecimals(assets,100)',revertedMetadata.context)).length,0,'failed decimals must never be guessed');
assert.equal(revertedMetadata.storage.has(cacheKey),false);
console.log('PASS: partial verified decimals survive later quota failure and reload; only missing tokens are queried;24h expiry/chain isolation work; fallback saves each successful single result.');
assert.equal(vm.runInContext('scoreRow({netProfit:null,netRoi:null},3)',c),0);
const order=vm.runInContext('[{netProfit:null,grossProfit:100},{netProfit:-2,grossProfit:0},{netProfit:3,grossProfit:3}].sort(sortNetRows)',c);
assert.equal(order[0].netProfit,3);assert.equal(order[2].netProfit,null);
c.state.ethUsd=3000;c.state.gasPriceWei=1n;c.state.provider={send:async()=>{throw new Error('offline');}};
vm.runInContext('rpcCallRaw=async()=>[]',c);await vm.runInContext('refreshGas(100)',c);
assert.equal(c.state.ethUsd,null);assert.equal(c.state.gasPriceWei,null);assert.match(h.fields.gasStatus.textContent,/net unavailable/);
let scanEvent;
c.CustomEvent=class {constructor(type,init){this.type=type;this.detail=init.detail;}};
c.window.dispatchEvent=event=>{scanEvent=event;};c.nowIso=()=>new Date().toISOString();c.venueLabel=value=>value;
c.state={provider:{send:async()=>({hash:'0xblock',timestamp:'0x65'})},routeCache:new Map(),v4Pools:new Map(),streaks:new Map(),quickScanCount:0,scanSeq:0,usdgDecimals:6,gasPriceWei:null,ethUsd:null};
c.asset={address:address(100),symbol:'SAME',name:'A',decimals:6};
c.buy={type:'v3',venue:'V3-500',fee:500,amountOut:2_000_000n,gasEstimate:110_000n};
c.sell={type:'v2',venue:'V2',amountOut:1_000_000n,gasEstimate:125_000n};
c.bestV4={type:'v4',venue:'V4:pool1',poolId:'pool1',fee:3000,amountOut:3_000_000n,gasEstimate:140_000n};
c.state.v4Pools.set(c.asset.address,[{poolId:'pool1',currency0:address(1),currency1:c.asset.address,fee:3000,tickSpacing:60,hooks:ethers.ZeroAddress}]);
c.allBuys=new Map([[c.asset.address,[c.bestV4,c.buy,c.sell]]]);
const pairCalls=vm.runInContext('buildSellCallsFromBuyMap([asset],allBuys)',c);
assert.equal(pairCalls.length,6);assert.equal(new Set(pairCalls.map(call=>call.meta.sourceBuyVenue+'>'+call.meta.venue)).size,6);
for(const call of pairCalls){
  const source=c.allBuys.get(c.asset.address).find(buy=>buy.venue===call.meta.sourceBuyVenue);
  assert.notEqual(call.meta.venue,source.venue);assert.equal(call.meta.amountIn,source.amountOut);assert.equal(call.meta.sourceBuyAmountRaw,source.amountOut.toString());
  const decoder=call.meta.type==='v2'?v2Iface:call.meta.type==='v3'?v3Iface:v4Iface;
  const encoded=decoder.decodeFunctionData(call.meta.type==='v2'?'getAmountsOut':'quoteExactInputSingle',call.callData);
  const encodedAmount=call.meta.type==='v2'?encoded[0]:call.meta.type==='v3'?encoded[0].amountIn:encoded[0].exactAmount;
  assert.equal(encodedAmount,source.amountOut);
}
const pairOutputs=new Map([['V3-500>V2',1_001_000_000n],['V2>V3-500',1_002_000_000n],['V4:pool1>V3-500',1_005_000_000n],['V4:pool1>V2',1_004_000_000n],['V3-500>V4:pool1',1_003_000_000n],['V2>V4:pool1',1_000_000_000n]]);
c.allSells=new Map([[c.asset.address,pairCalls.map(call=>({...call.meta,amountOut:pairOutputs.get(call.meta.sourceBuyVenue+'>'+call.meta.venue),gasEstimate:call.meta.type==='v4'?140_000n:call.meta.type==='v2'?125_000n:110_000n}))]]);
c.quoteMaps=[c.allBuys,c.allSells];
vm.runInContext("initProvider=async()=>100;loadTokenDecimals=async assets=>assets;refreshGas=async()=>{};buildQuoteCalls=()=>[];rpcCallRaw=async()=>[];decodeQuotes=()=>quoteMaps.shift();logVenueHits=()=>{};",c);
const scanRows=await vm.runInContext("scanAtSize([asset],1000,'quick',false,false)",c);
assert.equal(scanRows.length,6);assert.equal(scanRows.filter(row=>row.executionSupported).length,2);assert.equal(new Set(scanRows.map(row=>row.routePairId)).size,6);
const v3ToV2=scanRows.find(row=>row.buyVenue==='V3-500'&&row.sellVenue==='V2');
assert.equal(v3ToV2.buyTokenQty,2);assert.equal(v3ToV2.amountInRaw,'1000000000');assert.equal(v3ToV2.buyAmountRaw,'2000000');assert.equal(v3ToV2.sellAmountRaw,'1001000000');assert.equal(v3ToV2.netProfit,null);
assert.equal(v3ToV2.tokenDecimals,6);assert.equal(v3ToV2.blockHash,'0xblock');assert.equal(v3ToV2.buyRoute.fee,500);assert.equal(v3ToV2.sellRoute.type,'v2');
assert.equal(scanEvent.type,'arb:scan');assert.equal(scanEvent.detail.rows[0],scanRows[0]);assert.equal(scanRows.filter(row=>row.buyRoute.type==='v4'||row.sellRoute.type==='v4').every(row=>!row.executionSupported),true);
c.state.gasPriceWei=1n;c.state.ethUsd=1000;c.state.ethUsdQuoteBlock=100;c.quoteMaps=[c.allBuys,c.allSells];
const pricedRows=await vm.runInContext("scanAtSize([asset],1000,'quick',false,false)",c);
assert.equal(pricedRows.every(row=>Number.isFinite(row.netProfit)),true);assert.equal(pricedRows[0].buyVenue,'V4:pool1');assert.equal(pricedRows[0].sellVenue,'V3-500');assert.equal(pricedRows[0].gasUnits,140_000+110_000+220_000);
console.log('PASS: six complete ordered pairs preserve exact calldata/amounts, executable V2/V3 routes, metadata, block identity, gas/net ranking, unknown-cost nulls and scan events.');
