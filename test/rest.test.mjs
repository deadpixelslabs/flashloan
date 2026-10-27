import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fetchStart=html.indexOf('async function fetchJSON(');
const fetchSource=html.slice(fetchStart,html.indexOf('\nasync function openDB(',fetchStart));
const v4Start=html.indexOf('async function loadV4Pools(');
const v4Source=html.slice(v4Start,html.indexOf('\nfunction scannerError(',v4Start));
const base='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const token='0x1111111111111111111111111111111111111111';
const pool={venue:'uniswap_v4',poolId:'0x'+'ab'.repeat(32),currency0:token,currency1:base,fee:500,tickSpacing:10,depthUsd:1000};

function harness(responses=[],initialCache){
  let now=0,nextTimer=0;
  const timers=new Map(),calls=[],logs=[];
  const cache=new Map(Object.entries(initialCache||{}));
  const timeout=(fn,ms)=>{timers.set(++nextTimer,{fn,at:now+ms});return nextTimer;};
  const clear=timer=>timers.delete(timer);
  class Clock extends Date {static now(){return now;}}
  function pause(ms,signal){
    if(signal.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
    return new Promise((resolve,reject)=>{
      let timer;
      const abort=()=>{clear(timer);signal.removeEventListener('abort',abort);reject(new DOMException('Aborted','AbortError'));};
      signal.addEventListener('abort',abort,{once:true});
      if(Number.isFinite(ms))timer=timeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    });
  }
  const state={operationAbort:new AbortController(),assets:[{symbol:'TEST',address:token}],v4Pools:new Map(),v4PoolCount:0};
  const context=vm.createContext({
    state,Date:Clock,AbortController,AbortSignal,DOMException,Error,Map,Number,JSON,console,
    setTimeout:timeout,clearTimeout:clear,
    USDG:base,FLETCH_POOLS_API:'/proxy/fletch/dex/pools',FLETCH_POOLS_API_DIRECT:'https://fletch.test/pools',
    ethers:{ZeroAddress:'0x'+'0'.repeat(40)},assetKey:asset=>asset.address.toLowerCase(),
    log:(text,kind)=>logs.push({text,kind}),
    localStorage:{getItem:key=>cache.get(key)??null,setItem:(key,value)=>cache.set(key,value)},
    async fetch(url,{signal}){
      const spec=responses.shift()||{hang:true};calls.push({url,signal,at:now});
      if(spec.hang)await pause(Infinity,signal);
      if(spec.delay)await pause(spec.delay,signal);
      return {ok:(spec.status??200)<400,status:spec.status??200,headers:{get:()=>spec.contentType??'application/json'},async json(){if(spec.bodyDelay)await pause(spec.bodyDelay,signal);return spec.json??{};}};
    }
  });
  vm.runInContext(fetchSource+'\n'+v4Source+'\nglobalThis.api={fetchJSON,loadV4Pools};',context);
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  async function advance(ms){
    const end=now+ms;
    for(;;){
      await flush();
      const next=[...timers.entries()].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;
      timers.delete(next[0]);now=next[1].at;next[1].fn();
    }
    now=end;await flush();
  }
  return {api:context.api,state,calls,logs,timers,advance,flush};
}

test('REST timeout ends a hung proxy after one shared deadline without starting direct fallback',async()=>{
  const h=harness([{hang:true}]);
  const request=h.api.fetchJSON('/proxy','https://direct.test','Registry',{timeoutMs:8000});
  const rejected=assert.rejects(request,/Registry timed out after 8 seconds/);
  await h.advance(7999);assert.equal(h.calls.length,1);
  await h.advance(1);await rejected;
  assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
});

test('proxy and direct fallback share the total timeout budget',async()=>{
  const h=harness([{status:503,delay:3000},{hang:true}]);
  const request=h.api.fetchJSON('/proxy','https://direct.test','Registry',{timeoutMs:8000});
  const rejected=assert.rejects(request,/timed out/);
  await h.advance(3000);assert.equal(h.calls.length,2);assert.equal(h.calls[1].at,3000);
  assert.equal(h.calls[0].signal,h.calls[1].signal);
  await h.advance(5000);await rejected;assert.equal(h.timers.size,0);
});

test('REST timeout covers reading a stalled response body',async()=>{
  const h=harness([{bodyDelay:10000}]);
  const rejected=assert.rejects(h.api.fetchJSON('/proxy',null,'Discovery',{timeoutMs:8000}),/Discovery timed out/);
  await h.advance(8000);await rejected;assert.equal(h.timers.size,0);
});

test('STOP cancels REST immediately and does not try the direct endpoint',async()=>{
  const h=harness([{hang:true}]);
  const rejected=assert.rejects(h.api.fetchJSON('/proxy','https://direct.test','Registry'),e=>e.name==='AbortError');
  await h.advance(1000);h.state.operationAbort.abort();await h.flush();await rejected;
  assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);
});

test('optional V4 timeout reuses cached keys or continues with V2/V3',async()=>{
  const cached=harness([{hang:true}],{'rh-v4-pools-cache':JSON.stringify([pool])});
  const cachedResult=cached.api.loadV4Pools();await cached.advance(8000);await cachedResult;
  assert.equal(cached.state.v4PoolCount,1);assert.ok(cached.logs.some(x=>/using cached PoolKeys/.test(x.text)));
  const empty=harness([{hang:true}]);
  const emptyResult=empty.api.loadV4Pools();await empty.advance(8000);await emptyResult;
  assert.equal(empty.state.v4PoolCount,0);assert.ok(empty.logs.some(x=>/continuing with V2\/V3/.test(x.text)));
});

test('optional V4 discovery preserves partial results and respects the 15-second total budget',async()=>{
  const page=Array.from({length:100},(_,i)=>({...pool,poolId:'pool-'+i}));
  const h=harness([{delay:6000,json:{pools:page}},{delay:6000,json:{pools:page}},{hang:true}]);
  const result=h.api.loadV4Pools();await h.advance(15000);await result;
  assert.equal(h.calls.length,3);assert.equal(h.calls[2].at,12000);
  assert.equal(h.state.v4PoolCount,2);assert.ok(h.logs.some(x=>/partial V4 keys/.test(x.text)));
  assert.equal(h.timers.size,0);
});

test('STOP propagates through optional V4 discovery instead of silently falling back',async()=>{
  const h=harness([{hang:true}],{'rh-v4-pools-cache':JSON.stringify([pool])});
  const rejected=assert.rejects(h.api.loadV4Pools(),e=>e.name==='AbortError');
  await h.advance(1000);h.state.operationAbort.abort();await h.flush();await rejected;
  assert.equal(h.state.v4PoolCount,0);assert.equal(h.calls.length,1);
});
