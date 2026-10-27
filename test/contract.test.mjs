import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ganache from 'ganache';
import {BrowserProvider, ContractFactory, AbiCoder} from 'ethers';
import {compile} from '../scripts/compile.mjs';

const output = compile({'MockContracts.sol':{content:fs.readFileSync(new URL('./MockContracts.sol',import.meta.url),'utf8')}});
async function fixture() {
  const chain=ganache.provider({chain:{chainId:31337,hardfork:'merge'},logging:{quiet:true},wallet:{totalAccounts:2}});
  const provider=new BrowserProvider(chain);
  provider.pollingInterval=20;
  const owner=await provider.getSigner(0), stranger=await provider.getSigner(1);
  async function deploy(file,name,args=[]) {
    const c=output.contracts[file][name];
    const contract=await new ContractFactory(c.abi,'0x'+c.evm.bytecode.object,owner).deploy(...args);
    await contract.waitForDeployment();return contract;
  }
  const base=await deploy('MockContracts.sol','MockToken',[6]);
  const token=await deploy('MockContracts.sol','MockToken',[18]);
  const lender=await deploy('MockContracts.sol','MockMorpho');
  const v2=await deploy('MockContracts.sol','MockRouter',[base.target,token.target]);
  const v3=await deploy('MockContracts.sol','MockRouter',[base.target,token.target]);
  const arb=await deploy('RobinhoodFlashArb.sol','RobinhoodFlashArb',[lender.target,v2.target,v3.target,base.target,31337]);
  for(const target of [lender.target,v2.target,v3.target]) await (await base.mint(target,1000000000000n)).wait();
  for(const target of [v2.target,v3.target]) await (await token.mint(target,10n**30n)).wait();
  const block=await provider.getBlock('latest');
  const plan={token:token.target,amount:1000000n,minProfit:50000n,minBuyOut:1990000000000000000n,
    minSellOut:1090000n,buyKind:2,sellKind:3,buyFee:0,sellFee:500,deadline:block.timestamp+240};
  return {chain,provider,owner,stranger,base,token,lender,v2,v3,arb,plan,deploy};
}
async function rejected(action) { await assert.rejects(action); }

test('Morpho/V2/V3 round trip needs no principal and preserves existing balances',async t=>{
  const f=await fixture();t.after(()=>f.chain.disconnect());
  await (await f.base.mint(f.arb.target,7654321n)).wait();
  await (await f.token.mint(f.arb.target,123456789n)).wait();
  const lenderBefore=await f.base.balanceOf(f.lender.target), ownerBefore=await f.base.balanceOf(await f.owner.getAddress());
  assert.equal(await f.arb.execute.staticCall(f.plan),100000n);
  await (await f.arb.execute(f.plan)).wait();
  assert.equal(await f.base.balanceOf(f.lender.target),lenderBefore,'loan repaid in full');
  assert.equal(await f.base.balanceOf(f.arb.target),7654321n,'base prefund protected');
  assert.equal(await f.token.balanceOf(f.arb.target),123456789n,'token prefund protected');
  assert.equal(await f.base.balanceOf(await f.owner.getAddress())-ownerBefore,100000n,'profit delivered to owner');
  for(const spender of [f.lender.target,f.v2.target,f.v3.target]) {
    assert.equal(await f.base.allowance(f.arb.target,spender),0n);
    assert.equal(await f.token.allowance(f.arb.target,spender),0n);
  }
  assert.equal(await f.arb.nonce(),1n);
});

test('V3 buy and V2 sell also execute with exact-input bounds',async t=>{
  const f=await fixture();t.after(()=>f.chain.disconnect());
  const p={...f.plan,buyKind:3,buyFee:3000,sellKind:2,sellFee:0};
  await (await f.arb.execute(p)).wait();
  assert.equal(await f.base.balanceOf(await f.owner.getAddress()),100000n);
});

test('unprofitable execution cannot spend prefunded base or target balances',async t=>{
  const f=await fixture();t.after(()=>f.chain.disconnect());
  await (await f.base.mint(f.arb.target,10000000n)).wait();
  await (await f.token.mint(f.arb.target,123n)).wait();
  await (await f.v3.setSellRate(49,10n**14n)).wait();
  await rejected(f.arb.execute({...f.plan,minSellOut:1n,minProfit:1n}));
  assert.equal(await f.base.balanceOf(f.arb.target),10000000n);
  assert.equal(await f.token.balanceOf(f.arb.target),123n);
  assert.equal(await f.arb.nonce(),0n,'whole state rolled back');
});

test('owner authorization and authenticated single callback reject outsiders, replay and wrong amount',async t=>{
  const f=await fixture();t.after(()=>f.chain.disconnect());
  await rejected(f.arb.connect(f.stranger).execute(f.plan));
  await rejected(f.arb.onMorphoFlashLoan(1000000n,'0x'));
  const tuple='tuple(address token,uint256 amount,uint256 minProfit,uint256 minBuyOut,uint256 minSellOut,uint8 buyKind,uint8 sellKind,uint24 buyFee,uint24 sellFee,uint256 deadline)';
  const data=AbiCoder.defaultAbiCoder().encode([tuple,'uint256'],[f.plan,1n]);
  await rejected(f.lender.replay(f.arb.target,1000000n,data));
  for(const mode of [1,2,3,4]) {
    await (await f.lender.setMode(mode)).wait();
    await rejected(f.arb.execute.staticCall(f.plan));
  }
});

test('authenticated callback reentry during router execution is rejected without blocking a valid loan',async t=>{
  const f=await fixture();t.after(()=>f.chain.disconnect());
  await (await f.v2.setAttackLender(f.lender.target)).wait();
  await (await f.arb.execute(f.plan)).wait();
  assert.equal(await f.v2.callbackReentryRejected(),true);
  assert.equal(await f.base.balanceOf(await f.owner.getAddress()),100000n);
});

test('expiration, long-lived quotes, invalid venue, zero profit and wrong chain are rejected',async t=>{
  const f=await fixture();t.after(()=>f.chain.disconnect());
  const now=(await f.provider.getBlock('latest')).timestamp;
  for(const invalid of [{deadline:now-1},{deadline:now+301},{buyKind:4},{sellKind:0},{minProfit:0n},{token:f.base.target},{amount:0n}])
    await rejected(f.arb.execute.staticCall({...f.plan,...invalid}));
  await rejected(f.deploy('RobinhoodFlashArb.sol','RobinhoodFlashArb',[f.lender.target,f.v2.target,f.v3.target,f.base.target,4663]));
});
