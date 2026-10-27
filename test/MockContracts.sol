// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import 'RobinhoodFlashArb.sol';

contract MockToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(uint8 decimals_) { decimals = decimals_; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _transfer(msg.sender,to,amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount,'allowance');
        allowance[from][msg.sender] -= amount;
        _transfer(from,to,amount); return true;
    }
    function _transfer(address from,address to,uint256 amount) private {
        require(balanceOf[from] >= amount,'balance'); balanceOf[from] -= amount; balanceOf[to] += amount;
    }
}

contract MockMorpho {
    // 1 repeat callback, 2 wrong borrowed assets, 3 skip callback, 4 changed commitment data.
    uint8 public mode;
    bytes public lastData;
    uint256 public lastAssets;
    function setMode(uint8 mode_) external { mode=mode_; }
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        lastData=data;lastAssets=assets;
        MockToken(token).transfer(msg.sender,assets);
        if (mode == 4) RobinhoodFlashArb(msg.sender).onMorphoFlashLoan(assets,abi.encodePacked(data,bytes1(0x01)));
        else if (mode != 3) RobinhoodFlashArb(msg.sender).onMorphoFlashLoan(mode == 2 ? assets+1 : assets,data);
        if (mode == 1) RobinhoodFlashArb(msg.sender).onMorphoFlashLoan(assets,data);
        MockToken(token).transferFrom(msg.sender,address(this),assets);
    }
    function replay(address executor, uint256 assets, bytes calldata data) external {
        RobinhoodFlashArb(executor).onMorphoFlashLoan(assets,data);
    }
}

contract MockRouter {
    address public immutable base;
    address public immutable target;
    uint256 public buyNumerator = 2e12;
    uint256 public buyDenominator = 1;
    uint256 public sellNumerator = 55;
    uint256 public sellDenominator = 1e14;
    address public attackLender;
    bool public callbackReentryRejected;
    constructor(address base_,address target_) { base=base_; target=target_; }
    function setSellRate(uint256 n,uint256 d) external { sellNumerator=n; sellDenominator=d; }
    function setAttackLender(address lender) external { attackLender=lender; }
    function swapExactTokensForTokens(uint256 amountIn,uint256 minOut,address[] calldata path,address to,uint256 deadline)
        external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline,'deadline'); require(path.length == 2,'path');
        uint256 out=_swap(path[0],path[1],amountIn,minOut,to);
        amounts=new uint256[](2);amounts[0]=amountIn;amounts[1]=out;
    }
    function exactInputSingle(IV3RouterArb.ExactInputSingleParams calldata p) external payable returns (uint256) {
        require(p.fee==500 || p.fee==3000,'fee');
        return _swap(p.tokenIn,p.tokenOut,p.amountIn,p.amountOutMinimum,p.recipient);
    }
    function _swap(address tokenIn,address tokenOut,uint256 amount,uint256 minimum,address to) private returns (uint256 out) {
        if (attackLender != address(0)) {
            MockMorpho lender=MockMorpho(attackLender);
            try lender.replay(msg.sender,lender.lastAssets(),lender.lastData()) { revert('callback reentry accepted'); }
            catch { callbackReentryRejected=true; }
        }
        require((tokenIn==base && tokenOut==target)||(tokenIn==target && tokenOut==base),'pair');
        out=tokenIn==base ? amount*buyNumerator/buyDenominator : amount*sellNumerator/sellDenominator;
        require(out>=minimum,'slippage');
        MockToken(tokenIn).transferFrom(msg.sender,address(this),amount);
        MockToken(tokenOut).transfer(to,out);
    }
}
