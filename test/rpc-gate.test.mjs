import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../rpc-gate.js',import.meta.url),'utf8');
const endpoint='https://example.test/proxy/rpc';
const rpc={jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]};

function harness(responses=[]){
  let time=0,id=0;
  const timers=new Map(),calls=[],events=[];
  class Clock extends Date {static now(){return time;}}
  const timeout=(fn,ms)=>{timers.set(++id,{fn,at:time+ms});return id;};
  const clear=key=>timers.delete(key);
  const context=vm.createContext({
    URL,AbortController,AbortSignal,Date:Clock,Error,Promise,console,
    location:{href:'https://example.test/'},
    setTimeout:timeout,clearTimeout:clear,
    CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail;}},
    window:{dispatchEvent(e){events.push(e);}},
    async fetch(url,options){
      calls.push({url,options,at:time});
      const spec=responses.shift()||{};
      if(spec.throw)throw spec.throw;
      if(spec.deferred)return spec.deferred;
      const status=spec.status??200;
      return {status,ok:status>=200&&status<300,headers:{get:k=>k==='retry-after'?spec.retryAfter:null},async text(){return spec.text??JSON.stringify(spec.json??{jsonrpc:'2.0',id:1,result:'0x64'});}};
    }
  });
  vm.runInContext(source,context);
  const flush=async()=>{for(let n=0;n<30;n++)await Promise.resolve();};
  async function advance(ms){
    const end=time+ms;
    for(;;){
      await flush();
      const next=[...timers.entries()].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;
      timers.delete(next[0]);time=next[1].at;next[1].fn();
    }
    time=end;await flush();
  }
  return {gate:context.window.RhRpcGate,calls,events,advance,flush,get time(){return time;}};
}

test('public RPC transport is serialized and starts no faster than every 750 ms',async()=>{
  const h=harness();
  const first=h.gate.request(endpoint,rpc),second=h.gate.request(endpoint,rpc);
  await h.flush();assert.equal(h.calls.length,1);
  await h.advance(749);assert.equal(h.calls.length,1);
  await h.advance(1);assert.equal(h.calls.length,2);
  assert.deepEqual(h.calls.map(x=>x.at),[0,750]);
  assert.equal((await first).result,'0x64');assert.equal((await second).result,'0x64');
});

test('HTTP429 honors Retry-After and serializes later requests behind the cooldown',async()=>{
  const h=harness([{status:429,retryAfter:'25',text:'busy'},{},{ }]);
  const first=h.gate.request(endpoint,rpc),second=h.gate.request(endpoint,rpc);
  await h.flush();assert.equal(h.gate.getStatus().cooldownUntil,25000);
  assert.equal(h.calls.length,1);assert.equal(h.gate.getStatus().active,false);
  await h.advance(24999);assert.equal(h.calls.length,1);
  await h.advance(1);assert.equal(h.calls.length,2);
  await h.advance(750);assert.equal(h.calls.length,3);
  await Promise.all([first,second]);
  assert.ok(h.events.some(e=>e.type==='rh:rpc-status'&&e.detail.cooldownUntil===25000&&e.detail.retryCount===1));
});

test('JSON-RPC quota errors retry twice then expose the shared final cooldown',async()=>{
  const failure={json:{jsonrpc:'2.0',id:1,error:{code:-32005,message:'rate limit exceeded'}}};
  const h=harness([failure,failure,failure]);
  const promise=h.gate.request(endpoint,rpc);
  const rejected=assert.rejects(promise,e=>e.rpcRateLimited&&e.rpcInfrastructure&&e.status===429&&e.retryAt===70000&&e.retryAfterMs===40000);
  await h.flush();assert.equal(h.calls.length,1);
  await h.advance(10000);assert.equal(h.calls.length,2);
  await h.advance(20000);assert.equal(h.calls.length,3);
  await rejected;assert.equal(h.gate.getStatus().cooldownUntil,70000);
});

test('contract reverts are returned to the RPC client without retrying or cooling down',async()=>{
  const h=harness([{json:{jsonrpc:'2.0',id:1,error:{code:3,message:'execution reverted'}}}]);
  const result=await h.gate.request(endpoint,rpc);
  assert.equal(result.error.code,3);assert.equal(h.calls.length,1);assert.equal(h.gate.getStatus().cooldownUntil,0);
});

test('STOP cancels a cooldown wait and removes queued work without another transport',async()=>{
  const h=harness([{status:429,text:'quota'}]);
  const active=new AbortController(),queued=new AbortController();
  const first=h.gate.request(endpoint,rpc,{signal:active.signal});
  const second=h.gate.request(endpoint,rpc,{signal:queued.signal});
  const firstRejected=assert.rejects(first,e=>e.name==='AbortError');
  const secondRejected=assert.rejects(second,e=>e.name==='AbortError');
  await h.flush();queued.abort();active.abort();await h.flush();
  await Promise.all([firstRejected,secondRejected]);
  await h.advance(60000);assert.equal(h.calls.length,1);assert.equal(h.gate.getStatus().queued,0);
});

test('provider adapter normalizes single responses and honors operation cancellation',async()=>{
  const h=harness();const operation=new AbortController();
  class JsonRpcProvider {constructor(...args){this.args=args;}destroy(){this.destroyed=true;}}
  const p=h.gate.provider({JsonRpcProvider},endpoint,{getSignal:()=>operation.signal});
  const result=await p._send(rpc);
  assert.equal(result.length,1);assert.equal(result[0].result,'0x64');
  assert.equal(p.args[1],4663);assert.equal(p.args[2].batchMaxCount,1);
  operation.abort();await assert.rejects(p._send(rpc),e=>e.name==='AbortError');
  p.destroy();assert.equal(p.destroyed,true);
});

test('HTTP errors and malformed responses are infrastructure failures without retry storms',async()=>{
  const h=harness([{status:503,json:{message:'down'}}]);
  await assert.rejects(h.gate.request(endpoint,rpc),e=>e.rpcInfrastructure&&e.status===503);
  assert.equal(h.calls.length,1);
  const invalid=harness([{text:'<html>unavailable</html>'}]);
  await assert.rejects(invalid.gate.request(endpoint,rpc),e=>e.rpcInfrastructure&&/invalid JSON/.test(e.message));
  assert.equal(invalid.calls.length,1);
});

test('write methods are never automatically retried on rate limiting',async()=>{
  const h=harness([{status:429,text:'quota'}]);
  await assert.rejects(h.gate.request(endpoint,{...rpc,method:'eth_sendRawTransaction'}),e=>e.rpcRateLimited);
  await h.advance(60000);assert.equal(h.calls.length,1);
});
