(() => {
  'use strict';
  const CHAIN = 4663;
  const OFFICIAL_RPC = 'https://rpc.mainnet.chain.robinhood.com';
  const ADDR = Object.freeze({
    morpho: '0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010',
    v2: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
    v3: '0xcaf681a66d020601342297493863e78c959e5cb2',
    quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
    base: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
  });
  const $ = id => document.getElementById(id);
  const s = {wallet:null, signer:null, account:null, artifact:null, provider:null, rpc:null, rows:[], decimals:6, busy:false, validation:null};
  const erc20 = new ethers.Interface(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)']);
  const v2 = new ethers.Interface(['function getAmountsOut(uint256,address[]) view returns(uint256[])', 'function getAmountsIn(uint256,address[]) view returns(uint256[])']);
  const v3 = new ethers.Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)', 'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amountOut,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)']);
  const same = (a,b) => String(a).toLowerCase() === String(b).toLowerCase();
  const units = n => ethers.formatUnits(n,s.decimals);
  const status = text => { $('executionStatus').textContent = text; };
  const errorText = e => e.reason || e.shortMessage || e.message || String(e);
  function note(text, error=false) {
    const line = document.createElement('div');
    line.className = error ? 'err' : 'ok';
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
    $('executionLog').prepend(line);
    while ($('executionLog').children.length > 40) $('executionLog').lastChild.remove();
  }
  function invalidate() { s.validation=null; $('sendArbBtn').disabled=true; }
  async function run(task) {
    if (s.busy) return;
    s.busy=true; invalidate();
    const buttons=['walletBtn','deployExecutorBtn','attachExecutorBtn','flashHealthBtn','preflightBtn','sendArbBtn'];
    buttons.forEach(id=>$(id).disabled=true);
    try { await task(); } catch(e) { status('Blocked: '+errorText(e)); note(errorText(e),true); }
    finally {
      s.busy=false;
      buttons.filter(id=>id!=='sendArbBtn').forEach(id=>$(id).disabled=false);
      $('sendArbBtn').disabled=!s.validation;
    }
  }
  async function artifact() {
    if(s.artifact) return s.artifact;
    const r=await fetch('/artifacts/RobinhoodFlashArb.json',{cache:'no-store'});
    if(!r.ok) throw Error('Compiled executor artifact is unavailable.');
    s.artifact=await r.json();
    if(!Array.isArray(s.artifact.abi) || !/^0x[0-9a-f]+$/i.test(s.artifact.bytecode)) throw Error('Invalid executor artifact.');
    return s.artifact;
  }
  async function provider() {
    const raw=$('rpc').value.trim().replace(/\/$/,'');
    const endpoint=raw===OFFICIAL_RPC ? new URL('/proxy/rpc',location.href).href : raw;
    if(!s.provider || endpoint!==s.rpc) {
      if(s.provider) s.provider.destroy();
      if(!window.RhRpcGate)throw Error('RPC request manager unavailable. Reload this page.');
      s.provider=window.RhRpcGate.provider(ethers,endpoint);
      s.rpc=endpoint;
    }
    const cid=BigInt(await s.provider.send('eth_chainId',[]));
    if(cid!==BigInt(CHAIN)) throw Error('RPC must be Robinhood mainnet, chain 4663.');
    return s.provider;
  }
  async function call(p,to,iface,name,args,tag='latest',from) {
    const tx={to,data:iface.encodeFunctionData(name,args)};
    if(from)tx.from=from;
    return iface.decodeFunctionResult(name,await p.send('eth_call',[tx,tag]));
  }
  async function health(p=undefined) {
    p=p||await provider();
    const block=await p.send('eth_getBlockByNumber',['latest',false]);
    if(!block || Date.now()/1000-Number(BigInt(block.timestamp))>60) throw Error('RPC block is stale; check the connection.');
    const tag=block.number;
    const entries=Object.entries(ADDR).filter(([k])=>['morpho','v2','v3','quoter','base'].includes(k));
    const codes=await Promise.all(entries.map(([,a])=>p.send('eth_getCode',[a,tag])));
    codes.forEach((code,i)=>{if(code==='0x'||code==='0x0')throw Error(entries[i][0]+' has no contract code on this RPC.');});
    const dec=Number((await call(p,ADDR.base,erc20,'decimals',[],tag))[0]);
    if(dec!==6)throw Error('Canonical USDG decimals do not match the expected deployment.');
    s.decimals=dec;
    const available=(await call(p,ADDR.base,erc20,'balanceOf',[ADDR.morpho],tag))[0];
    $('flashLiquidity').textContent=Number(units(available)).toLocaleString(undefined,{maximumFractionDigits:2})+' USDG';
    $('flashBlock').textContent=Number(BigInt(block.number)).toLocaleString();
    return {p,block,available};
  }
  async function connect() {
    if(!window.ethereum) throw Error('Open this page in a browser with an Ethereum wallet extension.');
    const injected=window.ethereum;
    await injected.request({method:'eth_requestAccounts'});
    try {await injected.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1237'}]});}
    catch(e) {
      if(Number(e.code)!==4902) throw e;
      await injected.request({method:'wallet_addEthereumChain',params:[{chainId:'0x1237',chainName:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:[OFFICIAL_RPC],blockExplorerUrls:['https://robinhoodchain.blockscout.com']}]});
      await injected.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1237'}]});
    }
    s.wallet=new ethers.BrowserProvider(injected,undefined,{cacheTimeout:-1});
    s.signer=await s.wallet.getSigner(); s.account=await s.signer.getAddress();
    if(Number((await s.wallet.getNetwork()).chainId)!==CHAIN)throw Error('Wallet network must be Robinhood Chain.');
    $('walletAccount').textContent=s.account;
    const saved=localStorage.getItem('rh-executor-4663-'+s.account.toLowerCase());
    if(saved)$('executorAddress').value=saved;
    status('Wallet connected. Check liquidity, then deploy or attach your executor.');
  }
  async function walletReady() {
    if(!s.signer || !s.account)throw Error('Connect your wallet first.');
    const cid=Number(BigInt(await window.ethereum.request({method:'eth_chainId'})));
    const accounts=await window.ethereum.request({method:'eth_accounts'});
    if(cid!==CHAIN || !accounts.length || !same(accounts[0],s.account))throw Error('Wallet changed. Reconnect before continuing.');
  }
  function maskedRuntime(code,refs) {
    if(!/^0x(?:[0-9a-f]{2})+$/i.test(code))throw Error('Invalid executor runtime bytecode.');
    const hex=code.toLowerCase().slice(2);
    const chars=hex.split('');
    for(const list of Object.values(refs||{})) {
      const values=list.map(ref=>hex.slice(ref.start*2,(ref.start+ref.length)*2));
      if(values.some(value=>value!==values[0]))throw Error('Executor immutable values are inconsistent.');
      for(const ref of list) {
        if((ref.start+ref.length)*2>hex.length)throw Error('Truncated executor runtime bytecode.');
        for(let i=ref.start*2;i<(ref.start+ref.length)*2;i++)chars[i]='0';
      }
    }
    return chars.join('');
  }
  async function executor(p) {
    await walletReady();
    const a=await artifact();
    const address=$('executorAddress').value.trim();
    if(!ethers.isAddress(address))throw Error('Deploy an executor or enter its address.');
    const code=await p.send('eth_getCode',[address,'latest']);
    if(!a.deployedBytecode || maskedRuntime(code,a.immutableReferences)!==maskedRuntime(a.deployedBytecode,a.immutableReferences))throw Error('Executor bytecode does not match this tested build. Deploy this version.');
    const c=new ethers.Contract(address,a.abi,p);
    const keys=['owner','morpho','v2Router','v3Router','baseToken','expectedChainId'];
    const values=await Promise.all(keys.map(k=>c[k]()));
    const expected=[s.account,ADDR.morpho,ADDR.v2,ADDR.v3,ADDR.base,String(CHAIN)];
    values.forEach((v,i)=>{if(!same(v,expected[i]))throw Error('Executor '+keys[i]+' does not match your wallet/network configuration.');});
    localStorage.setItem('rh-executor-4663-'+s.account.toLowerCase(),address);
    return c;
  }
  async function deploy() {
    await walletReady(); const {p}=await health(); const a=await artifact();
    const factory=new ethers.ContractFactory(a.abi,a.bytecode,s.signer);
    const args=[ADDR.morpho,ADDR.v2,ADDR.v3,ADDR.base,CHAIN];
    const unsigned=await factory.getDeployTransaction(...args);
    const estimate=await p.estimateGas({...unsigned,from:s.account});
    note('Deploying your executor. Estimated gas: '+estimate+'. Confirm the deployment in your wallet.');
    const c=await factory.deploy(...args);
    note('Deployment submitted: '+c.deploymentTransaction().hash);
    await c.waitForDeployment();
    $('executorAddress').value=await c.getAddress();
    await executor(p);
    status('Executor deployed and verified. Run the scanner and check a V2/V3 route.');
  }
  function routeOf(r,side) {
    const supplied=r[side+'Route']; const venue=r[side+'Venue'];
    if(supplied?.type==='v2'||venue==='V2')return {kind:2,fee:0};
    if(supplied?.type==='v3'||/^V3-\d+$/.test(venue||'')) {
      const fee=Number(supplied?.fee??venue.slice(3));
      if(![100,500,3000,10000].includes(fee))throw Error('Unsupported V3 fee.');
      return {kind:3,fee};
    }
    throw Error('This route uses V4. V4 remains scan-only in this executor version.');
  }
  async function quote(p,tokenIn,tokenOut,amount,route,tag) {
    if(route.kind===2){const result=await call(p,ADDR.v2,v2,'getAmountsOut',[amount,[tokenIn,tokenOut]],tag);return result[0][1];}
    return (await call(p,ADDR.quoter,v3,'quoteExactInputSingle',[[tokenIn,tokenOut,amount,route.fee,0]],tag))[0];
  }
  async function ethInBase(p,tag) {
    const size=ethers.parseEther('0.1'); const prices=[];
    for(const route of [{kind:2,fee:0},...[100,500,3000,10000].map(fee=>({kind:3,fee}))]) {
      try {
        // Price the USDG needed to replace gas ETH, including DEX fees and impact.
        const cost=route.kind===2
          ? (await call(p,ADDR.v2,v2,'getAmountsIn',[size,[ADDR.base,ADDR.weth]],tag))[0][0]
          : (await call(p,ADDR.quoter,v3,'quoteExactOutputSingle',[[ADDR.base,ADDR.weth,size,route.fee,0]],tag))[0];
        if(cost>0n)prices.push(cost*10n);
      }catch(e) {
        const nested=[e,e.error,e.info?.error];
        const messages=nested.filter(Boolean).map(x=>String(x.message||x.shortMessage||'')).join(' ');
        const infrastructure=/rate.?limit|too many|timeout|timed out|network|failed to fetch|socket|gateway|header not found|missing trie|historical|prun|429|50[234]|limit exceeded|quota|service unavailable/i.test(messages);
        const contractRevert=e.code==='CALL_EXCEPTION'||nested.some(x=>Number(x?.code)===3&&/revert/i.test(String(x.message)));
        if(infrastructure||!contractRevert)throw e;
      }
    }
    if(!prices.length)throw Error('Cannot value ETH gas in USDG; execution is blocked.');
    // The cheapest live replacement route avoids illiquid-pool outliers. Add 2%
    // and round upward; the full gas-limit budget is buffered separately.
    const best=prices.reduce((a,b)=>a<b?a:b);
    return (best*102n+99n)/100n;
  }
  function numberInput(id,min,max) {
    const n=Number($(id).value);if(!Number.isFinite(n)||n<min||n>max)throw Error('Invalid '+$(id).getAttribute('aria-label')+'.');return n;
  }
  async function preflight() {
    await walletReady();
    const row=s.rows[Number($('executionRoute').value)];
    if(!row)throw Error('Run the scanner and select a supported V2/V3 route.');
    const buy=routeOf(row,'buy'),sell=routeOf(row,'sell');
    if(buy.kind===sell.kind&&buy.fee===sell.fee)throw Error('Buy and sell must use different pools.');
    const {p,block,available}=await health();
    const c=await executor(p);
    const amount=BigInt(row.amountInRaw||ethers.parseUnits(String(row.size),s.decimals));
    if(amount<=0n||amount>available)throw Error('The requested USDG loan exceeds the current Morpho balance.');
    const slippage=BigInt(Math.round(numberInput('executionSlippage',0,100)));
    const requestedProfit=ethers.parseUnits(String(numberInput('executionMinProfit',0.000001,1000000)),s.decimals);
    const maxGas=ethers.parseEther(String(numberInput('executionMaxGas',0.00000001,1)));
    const tag=block.number;
    const buyOut=await quote(p,ADDR.base,row.address,amount,buy,tag);
    const minBuyOut=buyOut*(10000n-slippage)/10000n;
    if(minBuyOut===0n)throw Error('Buy quote rounds to zero.');
    const sellOut=await quote(p,row.address,ADDR.base,buyOut,sell,tag);
    const lowerSellOut=await quote(p,row.address,ADDR.base,minBuyOut,sell,tag);
    const minQuotedSell=lowerSellOut*(10000n-slippage)/10000n;
    const ethPrice=await ethInBase(p,tag);
    const gasPrice=BigInt(await p.send('eth_gasPrice',[]))*120n/100n+1n;
    let gasLimit=1000000n;
    let gasCostBase=0n;
    const deadline=Number(BigInt(block.timestamp))+120;
    const iface=c.interface;
    let plan,data,profit;
    for(let pass=0;pass<4;pass++) {
      const minProfit=requestedProfit+gasCostBase;
      const requiredSell=amount+minProfit;
      plan={token:row.address,amount,minProfit,minBuyOut,minSellOut:minQuotedSell>requiredSell?minQuotedSell:requiredSell,buyKind:buy.kind,sellKind:sell.kind,buyFee:buy.fee,sellFee:sell.fee,deadline};
      data=iface.encodeFunctionData('execute',[plan]);
      const tx={from:s.account,to:await c.getAddress(),data,gasPrice:ethers.toQuantity(gasPrice)};
      profit=iface.decodeFunctionResult('execute',await p.send('eth_call',[tx,'latest']))[0];
      const estimate=BigInt(await p.send('eth_estimateGas',[tx]));
      gasLimit=estimate*125n/100n+10000n;
      if(gasLimit*gasPrice>maxGas)throw Error('Full transaction gas budget exceeds your ETH limit.');
      const needed=(gasLimit*gasPrice*ethPrice+10n**18n-1n)/10n**18n;
      if(needed<=gasCostBase)break;
      if(pass===3)throw Error('Gas budget did not stabilize; check the route again.');
      gasCostBase=needed;
    }
    if(profit<plan.minProfit)throw Error('Atomic result does not cover gas and minimum net profit.');
    if(Date.now()/1000>deadline-45)throw Error('RPC checks took too long. Check the route again.');
    const balance=BigInt(await p.send('eth_getBalance',[s.account,'latest']));
    if(balance<gasLimit*gasPrice)throw Error('Your wallet needs ETH for the transaction gas budget.');
    const net=profit-gasCostBase;
    $('atomicProfit').textContent=Number(units(net)).toFixed(6)+' USDG';
    $('atomicGas').textContent=ethers.formatEther(gasLimit*gasPrice)+' ETH';
    s.validation={to:await c.getAddress(),data,plan,gasPrice,gasLimit,account:s.account,createdAt:Date.now(),blockHash:block.hash,blockNumber:block.number};
    status('Atomic call passed. Net estimate covers the gas budget. Sending will request a wallet signature.');
    note(row.symbol+': '+units(amount)+' USDG loan → '+units(sellOut)+' USDG quoted return. Full atomic call returned '+units(profit)+' USDG before gas; minimum net '+units(requestedProfit)+' USDG.');
    return s.validation;
  }
  async function send() {
    const checked=await preflight();
    const p=await provider();
    const quoteBlock=await p.send('eth_getBlockByNumber',[checked.blockNumber,false]);
    if(!quoteBlock||quoteBlock.hash!==checked.blockHash)throw Error('Quote block changed; check the route again.');
    await walletReady();
    if(Date.now()-checked.createdAt>10000)throw Error('Checks expired; check the route again.');
    invalidate();
    const tx=await s.signer.sendTransaction({to:checked.to,data:checked.data,gasLimit:checked.gasLimit,gasPrice:checked.gasPrice,type:0,chainId:CHAIN});
    const a=document.createElement('a');a.href='https://robinhoodchain.blockscout.com/tx/'+tx.hash;a.target='_blank';a.rel='noopener';a.textContent=tx.hash;
    $('executionTx').replaceChildren(a);
    status('Transaction submitted. Waiting for confirmation.');
    const receipt=await tx.wait();
    if(receipt.status!==1)throw Error('Transaction reverted. Check the explorer for gas used.');
    status('Flash loan transaction confirmed. Loan repaid and profit sent to the executor owner.');
    note('Confirmed: '+tx.hash);
  }
  function updateRows(rows) {
    s.rows=rows.filter(r=>ethers.isAddress(r.address));
    const select=$('executionRoute'); const old=select.selectedOptions[0]?.dataset.key;
    select.replaceChildren();
    for(let i=0;i<s.rows.length;i++) {
      const r=s.rows[i];const option=document.createElement('option');option.value=String(i);option.dataset.key=[r.address,r.buyVenue,r.sellVenue,r.size].join('|');
      let supported=true;try{routeOf(r,'buy');routeOf(r,'sell');}catch(_){supported=false;}
      option.disabled=!supported;
      option.textContent=r.symbol+' · '+r.size+' USDG · '+r.buyVenue+' → '+r.sellVenue+(supported?'':' · scan only');
      select.append(option);
      if(option.dataset.key===old&&!option.disabled)option.selected=true;
    }
    if(!select.selectedOptions.length||select.selectedOptions[0].disabled){const first=[...select.options].find(o=>!o.disabled);if(first)select.value=first.value;}
    if(!select.options.length){const o=document.createElement('option');o.textContent='Run a scan to load candidate routes';o.value='';select.append(o);}
    if(!s.busy)invalidate();
  }
  $('walletBtn').onclick=()=>run(connect);
  $('flashHealthBtn').onclick=()=>run(async()=>{const h=await health();status(h.available>0n?'Morpho USDG liquidity verified at the displayed block.':'Morpho USDG balance is zero. No loan is currently available.');});
  $('deployExecutorBtn').onclick=()=>run(deploy);
  $('attachExecutorBtn').onclick=()=>run(async()=>{await executor(await provider());status('Executor bytecode, owner and configuration verified.');});
  $('preflightBtn').onclick=()=>run(preflight);
  $('sendArbBtn').onclick=()=>run(send);
  ['executorAddress','executionRoute','executionSlippage','executionMinProfit','executionMaxGas','rpc'].forEach(id=>$(id).addEventListener('input',invalidate));
  window.addEventListener('arb:scan',e=>updateRows(e.detail.rows||[]));
  if(window.ethereum?.on) {
    for(const event of ['accountsChanged','chainChanged'])window.ethereum.on(event,()=>{invalidate();s.signer=null;s.account=null;$('walletAccount').textContent='Reconnect wallet';status('Wallet changed. Reconnect to continue.');});
  }
  setInterval(()=>{if(s.validation&&Date.now()-s.validation.createdAt>10000){invalidate();status('Route check expired. Check again before sending.');}},1000);
})();
