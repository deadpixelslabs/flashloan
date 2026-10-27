import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const regions=[
  source.slice(source.indexOf('function scannerError('),source.indexOf('\nasync function rpcBatchPost')),
  source.slice(source.indexOf('async function runQuick('),source.indexOf('\nfunction safeHost')),
  source.slice(source.indexOf('function renderScannerStatus('),source.indexOf('\nfunction downloadBlob'))
].join('\n');
function fixture(){
  let now=100000;
  const fields=new Map();
  const els=id=>{if(!fields.has(id))fields.set(id,{disabled:false,textContent:'',value:id==='interval'?'30':id==='quickSize'?'1000':''});return fields.get(id);};
  const timers=[],events={};
  const state={scanning:false,loading:false,loadPromise:null,assetsReady:false,operationAbort:null,operationMessage:null,lastError:null,failureCount:0,rpcCooldownUntil:0,nextScanAt:0,autoSession:0,assets:[],latest:[],auto:false,provider:{}};
  const registry={assets:[{tokenSymbol:'A',tokenName:'A',deployments:[{chainId:4663,contractAddress:'0xabc'}]}]};
  const ctx=vm.createContext({state,els,Date:class extends Date{static now(){return now;}},AbortController,DOMException,Math,Number,Map,Set,Promise,Error,CHAIN_ID:4663,ASSET_API:'assets',ASSET_API_DIRECT:'assets-direct',
    localStorage:{getItem:()=>null,setItem(){}},log(){},setLive:(on,text)=>{ctx.badge={on,text};},
    initProvider:async()=>100,fetchJSON:async()=>registry,loadTokenDecimals:async assets=>assets,
    restoreLiveRoutes(){},loadV4Pools:async()=>{},scanAtSize:async()=>[],idbAddMany:async()=>{},
    nowIso:()=>'',safeHost:()=>'',money:String,sortNetRows:()=>0,renderTable(){},updateMetrics(){},
    setTimeout:(fn,delay)=>{const t={fn,delay,cleared:false};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cleared=true;},
    setInterval:fn=>{ctx.tick=fn;},window:{addEventListener:(name,fn)=>events[name]=fn}
  });
  vm.runInContext(regions,ctx);
  return {ctx,state,els,timers,events,advance(ms){now+=ms;ctx.tick();}};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}

test('Load locks Start and Scan before awaiting RPC and duplicate loads share one request',async()=>{
  const f=fixture(),pending=deferred();let calls=0;
  f.ctx.initProvider=()=>{calls++;return pending.promise;};
  const first=vm.runInContext('loadAssets()',f.ctx);
  assert.equal(f.els('startBtn').disabled,true);assert.equal(f.els('scanBtn').disabled,true);
  const second=vm.runInContext('loadAssets()',f.ctx);
  vm.runInContext('startShadow()',f.ctx);
  assert.equal(f.state.auto,false);assert.equal(calls,1);
  pending.resolve(100);assert.equal(await first,true);assert.equal(await second,true);
  assert.equal(f.state.loading,false);assert.equal(f.state.assetsReady,true);assert.equal(f.els('startBtn').disabled,false);
});

test('nested asset load keeps outer scan controls locked',async()=>{
  const f=fixture(),quote=deferred();f.ctx.scanAtSize=()=>quote.promise;
  const scan=vm.runInContext('runQuick()',f.ctx);
  for(let i=0;i<15;i++)await Promise.resolve();
  assert.equal(f.state.assetsReady,true);assert.equal(f.state.loading,false);assert.equal(f.state.scanning,true);
  assert.equal(f.els('loadBtn').disabled,true);assert.equal(f.els('startBtn').disabled,true);
  assert.equal(await vm.runInContext('runQuick()',f.ctx),false);
  quote.resolve([]);assert.equal(await scan,true);assert.equal(f.state.scanning,false);
});

test('quota errors remain paused after finally and cooldown expiry restores retry controls',async()=>{
  const f=fixture();f.ctx.initProvider=async()=>{throw Object.assign(new Error('quota'),{rpcRateLimited:true,status:429,retryAt:120000});};
  assert.equal(await vm.runInContext('loadAssets()',f.ctx),false);
  assert.match(f.ctx.badge.text,/RPC PAUSED/);assert.equal(f.ctx.badge.on,false);
  assert.equal(f.els('scanBtn').disabled,true);assert.match(f.els('assetStatus').textContent,/Metadata incomplete/);
  f.advance(20001);
  assert.match(f.ctx.badge.text,/RPC ERROR/);assert.equal(f.els('scanBtn').disabled,false);
});

test('Stop cancels active work and prevents an old shadow loop from scheduling another scan',async()=>{
  const f=fixture();const pending=deferred();f.state.assetsReady=true;
  f.ctx.scanAtSize=()=>pending.promise;
  vm.runInContext('startShadow()',f.ctx);
  const signal=f.state.operationAbort.signal;
  vm.runInContext('stopShadow()',f.ctx);
  assert.equal(signal.aborted,true);assert.equal(f.state.auto,false);
  pending.reject(Object.assign(new Error('stopped'),{name:'AbortError'}));
  for(let i=0;i<15;i++)await Promise.resolve();
  assert.equal(f.state.scanning,false);assert.equal(f.timers.filter(t=>!t.cleared).length,0);
});

test('deep scan claims the operation before starting metadata load',async()=>{
  const f=fixture(),pending=deferred();let loads=0;
  f.ctx.initProvider=()=>{loads++;return pending.promise;};
  const deep=vm.runInContext('runDeep()',f.ctx);
  assert.equal(f.state.scanning,true);assert.equal(f.els('startBtn').disabled,true);
  assert.equal(await vm.runInContext('runQuick()',f.ctx),false);
  assert.equal(loads,1);pending.resolve(100);await deep;assert.equal(f.state.scanning,false);
});
