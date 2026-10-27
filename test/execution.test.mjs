import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import * as ethers from 'ethers';

const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('execution.js', root), 'utf8');
const artifact = JSON.parse(fs.readFileSync(new URL('artifacts/RobinhoodFlashArb.json', root), 'utf8'));
const account = '0x1111111111111111111111111111111111111111';
const executorAddress = '0x2222222222222222222222222222222222222222';
const token = '0x3333333333333333333333333333333333333333';
const base = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const executorInterface = new ethers.Interface(artifact.abi);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)']);
const v2 = new ethers.Interface(['function getAmountsOut(uint256,address[]) view returns(uint256[])', 'function getAmountsIn(uint256,address[]) view returns(uint256[])']);
const v3 = new ethers.Interface(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)', 'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amountOut,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)']);

function harness(options = {}) {
  const elements = new Map();
  const handlers = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value:'', textContent:'', disabled:false, children:[], dataset:{},
      prepend(c){this.children.unshift(c);},
      replaceChildren(...c){this.children=c;},
      addEventListener(name,fn){this[name]=fn;},
      getAttribute(){return id;}
    });
    return elements.get(id);
  }
  element('rpc').value = 'https://rpc.mainnet.chain.robinhood.com';
  element('executorAddress').value = executorAddress;
  element('executionRoute').value = '0';
  element('executionSlippage').value = '10';
  element('executionMinProfit').value = '1';
  element('executionMaxGas').value = '0.0002';
  const calls=[],gateProviders=[];
  let sent=0;
  const block = {number:'0x64',hash:'0x'+'44'.repeat(32),timestamp:ethers.toQuantity(Math.floor(Date.now()/1000))};
  function replacementCost(amount,route) {
    if(options.quoteInfrastructure)throw Object.assign(new Error('execution reverted: upstream rate limit 429'),{code:'CALL_EXCEPTION'});
    if(options.noGasQuote)throw Object.assign(new Error('execution reverted'),{code:'CALL_EXCEPTION'});
    const cost=route==='v2'?options.v2ReplacementCost??305000000n:options.v3ReplacementCost??301000000n;
    return amount*cost/ethers.parseEther('0.1');
  }
  function output(tokenIn, tokenOut, amount) {
    if (tokenIn.toLowerCase()===weth) {
      if(options.noGasQuote) throw Object.assign(new Error('execution reverted'),{code:'CALL_EXCEPTION'});
      return amount*3000n*1000000n/(10n**18n);
    }
    if(tokenIn.toLowerCase()===base)return amount*2n*10n**12n;
    return amount*101n/(200n*10n**12n);
  }
  class Provider {
    destroy(){this.destroyed=true;}
    async send(method,args) {
      calls.push([method,args]);
      if(method==='eth_chainId') return options.wrongChain?'0x1':'0x1237';
      if(method==='eth_getBlockByNumber') return block;
      if(method==='eth_getCode')return options.badCode&&args[0]===executorAddress?'0x6000':artifact.deployedBytecode;
      if(method==='eth_gasPrice')return '0x5f5e100'; // 0.1 gwei
      if(method==='eth_estimateGas')return ethers.toQuantity(options.gasEstimate??100000n);
      if(method==='eth_getBalance')return ethers.toQuantity(options.ethBalance??10n**18n);
      if(method==='eth_call') {
        const tx=args[0];const selector=tx.data.slice(0,10);
        if(selector===erc20.getFunction('decimals').selector)return erc20.encodeFunctionResult('decimals',[6]);
        if(selector===erc20.getFunction('balanceOf').selector)return erc20.encodeFunctionResult('balanceOf',[options.liquidity??1000000000000n]);
        if(selector===v2.getFunction('getAmountsOut').selector) {
          const [amount,path]=v2.decodeFunctionData('getAmountsOut',tx.data);
          return v2.encodeFunctionResult('getAmountsOut',[[amount,output(path[0],path[1],amount)]]);
        }
        if(selector===v2.getFunction('getAmountsIn').selector) {
          const [amount,path]=v2.decodeFunctionData('getAmountsIn',tx.data);
          assert.equal(path[0].toLowerCase(),base);assert.equal(path[1].toLowerCase(),weth);
          return v2.encodeFunctionResult('getAmountsIn',[[replacementCost(amount,'v2'),amount]]);
        }
        if(selector===v3.getFunction('quoteExactInputSingle').selector) {
          const [p]=v3.decodeFunctionData('quoteExactInputSingle',tx.data);
          return v3.encodeFunctionResult('quoteExactInputSingle',[output(p.tokenIn,p.tokenOut,p.amountIn),1,0,100000]);
        }
        if(selector===v3.getFunction('quoteExactOutputSingle').selector) {
          const [p]=v3.decodeFunctionData('quoteExactOutputSingle',tx.data);
          assert.equal(p.tokenIn.toLowerCase(),base);assert.equal(p.tokenOut.toLowerCase(),weth);
          return v3.encodeFunctionResult('quoteExactOutputSingle',[replacementCost(p.amountOut,'v3'),1,0,100000]);
        }
        if(selector===executorInterface.getFunction('execute').selector) {
          const [plan]=executorInterface.decodeFunctionData('execute',tx.data);
          const profit=options.atomicProfit??10000000n;
          if(profit<plan.minProfit)throw Object.assign(new Error('InsufficientProfit'),{code:'CALL_EXCEPTION'});
          return executorInterface.encodeFunctionResult('execute',[profit]);
        }
        throw Error('Unexpected call selector '+selector);
      }
      throw Error('Unexpected method '+method);
    }
  }
  class Contract {
    constructor(address) {this.interface=executorInterface;this.address=address;}
    async getAddress(){return this.address;}
    async owner(){return options.wrongOwner?'0x5555555555555555555555555555555555555555':account;}
    async morpho(){return '0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010';}
    async v2Router(){return '0x89e5db8b5aa49aa85ac63f691524311aeb649eba';}
    async v3Router(){return '0xcaf681a66d020601342297493863e78c959e5cb2';}
    async baseToken(){return base;}
    async expectedChainId(){return 4663n;}
  }
  const window = {
    RhRpcGate:options.missingGate?undefined:{provider(namespace,endpoint){
      const provider=new Provider();gateProviders.push({namespace,endpoint,provider});return provider;
    }},
    ethereum:{
      async request({method}){if(method==='eth_chainId')return '0x1237';if(method==='eth_accounts')return [account];throw Error(method);},
      on(name,fn){handlers.set(name,fn);}
    },
    addEventListener(name,fn){handlers.set(name,fn);}
  };
  const context=vm.createContext({
    ethers:{...ethers,JsonRpcProvider:class {constructor(){throw Error('Direct RPC provider bypassed the shared gate.');}},Contract},window,
    document:{getElementById:element,createElement:()=>element(Symbol())},
    location:{href:'https://example.test/'},URL,BigInt,Date,Error,console,
    localStorage:{getItem(){return null;},setItem(){}},
    async fetch(){return {ok:true,async json(){return artifact;}};},
    setInterval(){},
  });
  const hook='globalThis.__test={s,preflight,send,executor,routeOf,maskedRuntime,health,ethInBase,provider};';
  vm.runInContext(source.replace(/\}\)\(\);\s*$/,hook+'\n})();'),context);
  const api=context.__test;
  api.s.account=account;
  api.s.signer={async sendTransaction(){sent++;return {hash:'0x'+'ab'.repeat(32),async wait(){return {status:1};}};}};
  api.s.rows=[{symbol:'TEST',address:token,size:1000,amountInRaw:'1000000000',buyVenue:'V2',sellVenue:'V3-500',buyRoute:{type:'v2'},sellRoute:{type:'v3',fee:500}}];
  return {api,elements,calls,handlers,gateProviders,get sent(){return sent;}};
}

test('preflight encodes the contract ABI and raises minimum profit to cover the whole gas budget',async()=>{
  const h=harness();const checked=await h.api.preflight();
  const [plan]=executorInterface.decodeFunctionData('execute',checked.data);
  assert.equal(plan.amount,1000000000n);
  assert.equal(plan.buyKind,2n);assert.equal(plan.sellKind,3n);assert.equal(plan.sellFee,500n);
  assert.ok(plan.minProfit>1000000n);
  assert.ok(plan.minSellOut>=plan.amount+plan.minProfit);
  assert.ok(checked.gasLimit>100000n);
  assert.equal(h.sent,0);
});

test('execution refuses unavailable flash liquidity before any transaction submission',async()=>{
  const h=harness({liquidity:999n});
  await assert.rejects(h.api.send(),/exceeds the current Morpho balance/);
  assert.equal(h.sent,0);
});

test('unknown ETH gas valuation blocks execution',async()=>{
  const h=harness({noGasQuote:true});
  await assert.rejects(h.api.send(),/Cannot value ETH gas/);assert.equal(h.sent,0);
});

test('full transaction gas limit and available wallet ETH are enforced',async()=>{
  const high=harness({gasEstimate:1000000000n});await assert.rejects(high.api.send(),/exceeds your ETH limit/);assert.equal(high.sent,0);
  const poor=harness({ethBalance:0n});await assert.rejects(poor.api.send(),/needs ETH/);assert.equal(poor.sent,0);
});

test('executor bytecode and owner checks block substitution',async()=>{
  const code=harness({badCode:true});await assert.rejects(code.api.preflight(),/bytecode/);
  const owner=harness({wrongOwner:true});await assert.rejects(owner.api.preflight(),/owner does not match/);
});

test('wrong-chain RPC and unsupported V4 execution fail closed',async()=>{
  const chain=harness({wrongChain:true});await assert.rejects(chain.api.preflight(),/chain 4663/);
  const v4h=harness();v4h.api.s.rows[0].buyVenue='V4:pool';v4h.api.s.rows[0].buyRoute={type:'v4'};
  await assert.rejects(v4h.api.preflight(),/V4 remains scan-only/);
});

test('execute refreshes preflight and signs only a checked transaction',async()=>{
  const h=harness();await h.api.send();
  assert.equal(h.sent,1);assert.equal(h.api.s.validation,null);
  assert.match(h.elements.get('executionStatus').textContent,/confirmed/);
});

test('wallet changes discard the cached preflight and signing account',async()=>{
  const h=harness();await h.api.preflight();assert.ok(h.api.s.validation);
  h.handlers.get('accountsChanged')();assert.equal(h.api.s.validation,null);assert.equal(h.api.s.signer,null);
  assert.equal(h.elements.get('sendArbBtn').disabled,true);
});

test('gas valuation uses exact-output replacement cost with an upward 2% buffer',async()=>{
  const h=harness({v2ReplacementCost:1000000000n,v3ReplacementCost:300000001n});
  const value=await h.api.ethInBase(await h.api.provider(),'0x64');
  assert.equal(value,(3000000010n*102n+99n)/100n);
  const reverseCalls=h.calls.filter(([method,args])=>method==='eth_call'&&args[0].data.startsWith(v3.getFunction('quoteExactOutputSingle').selector));
  assert.equal(reverseCalls.length,4);
  assert.ok(reverseCalls.every(([,args])=>args[1]==='0x64'));
});

test('gas valuation propagates RPC failure instead of treating it as an absent pool',async()=>{
  const h=harness({quoteInfrastructure:true});
  await assert.rejects(h.api.send(),/rate limit 429/);assert.equal(h.sent,0);
});

test('runtime verification rejects malformed, truncated and inconsistent immutable code',()=>{
  const h=harness();assert.throws(()=>h.api.maskedRuntime('0x123',{}),/Invalid/);
  assert.throws(()=>h.api.maskedRuntime('0x6000',{x:[{start:10,length:32}]}),/Truncated/);
  assert.throws(()=>h.api.maskedRuntime('0x11112222',{x:[{start:0,length:2},{start:2,length:2}]}),/inconsistent/);
});

test('execution RPC uses and reuses the shared gate and replaces it on endpoint change',async()=>{
  const h=harness();const first=await h.api.provider();
  assert.equal(await h.api.provider(),first);assert.equal(h.gateProviders.length,1);
  assert.equal(h.gateProviders[0].endpoint,'https://example.test/proxy/rpc');
  h.elements.get('rpc').value='https://custom.test/rpc';
  const second=await h.api.provider();assert.notEqual(second,first);assert.equal(first.destroyed,true);
  assert.equal(h.gateProviders.length,2);assert.equal(h.gateProviders[1].endpoint,'https://custom.test/rpc');
});

test('execution refuses an unavailable gate instead of bypassing the rate manager',async()=>{
  const h=harness({missingGate:true});
  await assert.rejects(h.api.provider(),/RPC request manager unavailable/);
  assert.equal(h.calls.length,0);
});
