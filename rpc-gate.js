(() => {
  'use strict';
  const PUBLIC_RPC='rpc.mainnet.chain.robinhood.com';
  const jobs=[];
  let running=false,active=false,lastStarted=-Infinity,lastSpacing=0;
  let cooldownUntil=0,retryCount=0,message='RPC ready',sequence=0;
  const abortError=()=>Object.assign(new Error('RPC request canceled.'),{name:'AbortError'});
  function getStatus(){return {cooldownUntil,retryCount,message,active,queued:jobs.length};}
  function emit(nextMessage){
    if(nextMessage)message=nextMessage;
    window.dispatchEvent(new CustomEvent('rh:rpc-status',{detail:getStatus()}));
  }
  function publicEndpoint(endpoint){
    try {const url=new URL(endpoint,location.href);return url.hostname===PUBLIC_RPC||url.pathname.replace(/\/$/,'')==='/proxy/rpc';}
    catch(_){return false;}
  }
  function wait(milliseconds,signal){
    if(signal?.aborted)return Promise.reject(abortError());
    return new Promise((resolve,reject)=>{
      let timer;
      const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(abortError());};
      timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},Math.max(0,Math.min(milliseconds,60000)));
      signal?.addEventListener('abort',cancel,{once:true});
    });
  }
  async function waitUntil(deadline,signal){
    while(Date.now()<deadline)await wait(deadline-Date.now(),signal);
    if(signal?.aborted)throw abortError();
  }
  function retryAfter(value){
    if(!value)return 0;
    const seconds=Number(value);
    if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;
    const date=Date.parse(value);
    return Number.isFinite(date)?Math.max(0,date-Date.now()):0;
  }
  function rateError(json){
    const records=Array.isArray(json)?json:[json];
    return records.map(x=>x?.error).find(e=>e&&(Number(e.code)===429||Number(e.code)===-32005||/rate.?limit|too many requests|request limit|quota|compute units|capacity exceeded|limit exceeded/i.test(String(e.message||''))));
  }
  function retrySafe(payload){
    const records=Array.isArray(payload)?payload:[payload];
    return records.every(x=>/^eth_get|^eth_call$|^eth_estimateGas$|^eth_chainId$|^eth_blockNumber$|^eth_gasPrice$|^eth_feeHistory$|^eth_maxPriorityFeePerGas$|^net_version$/.test(x?.method||''));
  }
  async function transport(job){
    const signal=job.signal;
    if(signal?.aborted)throw abortError();
    const controller=new AbortController();
    let timedOut=false;
    const cancel=()=>controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});
    const timeout=setTimeout(()=>{timedOut=true;controller.abort();},15000);
    active=true;emit('RPC request in progress');
    try {
      const response=await fetch(job.endpoint,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(job.payload),cache:'no-store',signal:controller.signal});
      const text=await response.text();
      let json;
      try{json=JSON.parse(text);}catch(_){if(response.status!==429)throw Object.assign(new Error('RPC returned invalid JSON (HTTP '+response.status+').'),{status:response.status,rpcInfrastructure:true});}
      const rate=response.status===429||rateError(json);
      if(rate) {
        const hint=retryAfter(response.headers?.get('retry-after'));
        const minimum=10000*2**job.retries;
        const delay=Math.max(minimum,hint);
        cooldownUntil=Math.max(cooldownUntil,Date.now()+delay);
        retryCount=job.retries+1;
        const error=Object.assign(new Error('RPC rate limited. Cooling down before the next request.'),{rpcRateLimited:true,rpcInfrastructure:true,status:429,retryAfterMs:delay,retryAt:cooldownUntil});
        emit('RPC rate limited; waiting for cooldown');
        throw error;
      }
      if(!response.ok)throw Object.assign(new Error('RPC HTTP '+response.status+'.'),{status:response.status,rpcInfrastructure:true});
      if(json===null||typeof json!=='object')throw Object.assign(new Error('RPC returned an invalid JSON-RPC response.'),{rpcInfrastructure:true});
      retryCount=0;return json;
    }catch(error){
      if(signal?.aborted)throw abortError();
      if(error.rpcRateLimited)throw error;
      if(timedOut)throw Object.assign(new Error('RPC request timed out.'),{rpcInfrastructure:true});
      if(error.rpcInfrastructure)throw error;
      throw Object.assign(new Error('RPC connection failed: '+(error.message||String(error))),{rpcInfrastructure:true,cause:error});
    }finally{
      clearTimeout(timeout);signal?.removeEventListener('abort',cancel);active=false;
      emit(cooldownUntil>Date.now()?'RPC cooldown in progress':'RPC ready');
    }
  }
  async function run(job){
    const spacing=publicEndpoint(job.endpoint)?750:100;
    for(;;){
      await waitUntil(Math.max(cooldownUntil,lastStarted+Math.max(spacing,lastSpacing)),job.signal);
      lastStarted=Date.now();lastSpacing=spacing;
      try{return await transport(job);}
      catch(error){
        if(!error.rpcRateLimited||job.retries>=2||!retrySafe(job.payload))throw error;
        job.retries++;
      }
    }
  }
  async function pump(){
    if(running)return;
    running=true;
    try{
      while(jobs.length){
        jobs.sort((a,b)=>b.priority-a.priority||a.sequence-b.sequence);
        const job=jobs.shift();job.started=true;
        if(job.signal?.aborted){job.reject(abortError());job.cleanup();continue;}
        try{job.resolve(await run(job));}catch(error){job.reject(error);}finally{job.cleanup();}
      }
    }finally{running=false;emit(cooldownUntil>Date.now()?'RPC cooldown in progress':'RPC ready');}
  }
  function request(endpoint,payload,{signal,priority=0}={}){
    if(signal?.aborted)return Promise.reject(abortError());
    if(Array.isArray(payload)&&(!payload.length||payload.length>64))return Promise.reject(new Error('RPC batches must contain 1–64 methods.'));
    return new Promise((resolve,reject)=>{
      const job={endpoint,payload,signal,priority:Number(priority)||0,sequence:sequence++,retries:0,started:false,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',cancel)};
      const cancel=()=>{
        if(job.started)return;
        const index=jobs.indexOf(job);if(index>=0)jobs.splice(index,1);
        job.cleanup();reject(abortError());emit();
      };
      signal?.addEventListener('abort',cancel,{once:true});
      jobs.push(job);emit();void pump();
    });
  }
  function provider(ethers,endpoint,{getSignal}={}){
    const lifetime=new AbortController();
    return new class extends ethers.JsonRpcProvider {
      constructor(){super(endpoint,4663,{staticNetwork:true,batchMaxCount:1,cacheTimeout:0,pollingInterval:4000});}
      async _send(payload){
        const operation=getSignal?.();
        const signal=operation?AbortSignal.any([lifetime.signal,operation]):lifetime.signal;
        const result=await request(endpoint,payload,{signal});
        return Array.isArray(result)?result:[result];
      }
      destroy(){lifetime.abort();super.destroy();}
    }();
  }
  window.RhRpcGate=Object.freeze({request,provider,getStatus});
})();
