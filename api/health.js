const RPC='https://rpc.mainnet.chain.robinhood.com';
const contracts={morpho:'0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010',v2Router:'0x89e5db8b5aa49aa85ac63f691524311aeb649eba',v3Router:'0xcaf681a66d020601342297493863e78c959e5cb2',quoter:'0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',usdg:'0x5fc5360d0400a0fd4f2af552add042d716f1d168'};
async function rpc(method,params){
  const response=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error('RPC HTTP '+response.status);
  const data=await response.json();
  if(data.error)throw Error(data.error.message||'RPC error');
  if(data.result===undefined)throw Error('Missing RPC result');
  return data.result;
}
export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.setHeader('Allow','GET');return res.status(405).json({ok:false,error:'GET required'});}
  try{
    const chainId=Number(BigInt(await rpc('eth_chainId',[])));
    if(chainId!==4663)throw Error('Wrong chain: '+chainId);
    const block=await rpc('eth_getBlockByNumber',['latest',false]);
    const ageSeconds=Math.floor(Date.now()/1000)-Number(BigInt(block.timestamp));
    if(ageSeconds>60)throw Error('RPC block is stale: '+ageSeconds+' seconds');
    const tag=block.number;
    const entries=Object.entries(contracts);
    const code=await Promise.all(entries.map(([,address])=>rpc('eth_getCode',[address,tag])));
    const codeBytes=Object.fromEntries(entries.map(([name],i)=>[name,(code[i].length-2)/2]));
    if(Object.values(codeBytes).some(n=>n<=0))throw Error('One or more official contracts have no bytecode');
    const balanceData='0x70a08231'+contracts.morpho.slice(2).padStart(64,'0');
    const [rawBalance,rawDecimals]=await Promise.all([rpc('eth_call',[{to:contracts.usdg,data:balanceData},tag]),rpc('eth_call',[{to:contracts.usdg,data:'0x313ce567'},tag])]);
    const decimals=Number(BigInt(rawDecimals));
    if(decimals!==6)throw Error('Unexpected USDG decimals');
    const balance=BigInt(rawBalance);
    return res.status(200).json({ok:true,checkedAt:new Date().toISOString(),chainId,block:Number(BigInt(block.number)),blockHash:block.hash,ageSeconds,contracts,codeBytes,morphoUsdgRaw:balance.toString(),morphoUsdgUnits:(balance/1000000n).toString()+'.'+(balance%1000000n).toString().padStart(6,'0'),flashLoanAvailable:balance>0n,executorDeploymentChecked:false,executionVerified:false});
  }catch(error){return res.status(502).json({ok:false,checkedAt:new Date().toISOString(),chainId:4663,error:error.message,executionVerified:false});}
}
