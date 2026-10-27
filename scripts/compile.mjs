import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = path.resolve(import.meta.dirname, '..');
export function compile(extraSources = {}) {
  const source = fs.readFileSync(path.join(root, 'contracts/RobinhoodFlashArb.sol'), 'utf8');
  const input = { language: 'Solidity', sources: {'RobinhoodFlashArb.sol': {content:source}, ...extraSources},
    settings: {optimizer:{enabled:true,runs:200}, evmVersion:'paris',
      outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','evm.deployedBytecode.immutableReferences']}}} };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(x => x.severity === 'error');
  if (errors.length) throw new Error(errors.map(x => x.formattedMessage).join('\n'));
  return output;
}
if (process.argv[1] === import.meta.filename) {
  const output = compile();
  const compiled = output.contracts['RobinhoodFlashArb.sol'].RobinhoodFlashArb;
  const artifact = {contractName:'RobinhoodFlashArb', compiler:solc.version(), evmVersion:'paris',
    abi:compiled.abi, bytecode:'0x'+compiled.evm.bytecode.object,
    deployedBytecode:'0x'+compiled.evm.deployedBytecode.object,
    immutableReferences:compiled.evm.deployedBytecode.immutableReferences};
  fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
  fs.writeFileSync(path.join(root,'artifacts/RobinhoodFlashArb.json'), JSON.stringify(artifact,null,2)+'\n');
  console.log(`Compiled RobinhoodFlashArb (${compiled.evm.bytecode.object.length / 2} deployment bytes).`);
}
