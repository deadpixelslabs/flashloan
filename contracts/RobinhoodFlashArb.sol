// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Arb {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IMorphoArb {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IV2RouterArb {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline) external returns (uint256[] memory amounts);
}

interface IV3RouterArb {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Owner-only Morpho flash-loan executor. Supports direct Uniswap V2 and V3 round trips.
/// @dev Morpho Blue's flashLoan has no lender fee. Gas is paid separately by the transaction sender.
///      The minimum profit is in base-token units and must include the caller's gas/profit budget.
contract RobinhoodFlashArb {
    struct Plan {
        address token;
        uint256 amount;
        uint256 minProfit;
        uint256 minBuyOut;
        uint256 minSellOut;
        uint8 buyKind;
        uint8 sellKind;
        uint24 buyFee;
        uint24 sellFee;
        uint256 deadline;
    }

    address public immutable owner;
    address public immutable morpho;
    address public immutable v2Router;
    address public immutable v3Router;
    address public immutable baseToken;
    uint256 public immutable expectedChainId;
    uint256 public nonce;

    // 0 idle, 1 awaiting authenticated lender callback, 2 swapping, 3 awaiting loan repayment.
    uint8 private phase;
    bytes32 private pendingHash;
    uint256 private initialBaseBalance;
    uint256 private initialTokenBalance;

    error Unauthorized();
    error InvalidPlan();
    error InvalidCallback();
    error Busy();
    error Expired();
    error WrongChain();
    error TokenCallFailed();
    error InsufficientOutput();
    error InsufficientProfit();
    error BalanceProtection();

    event ArbitrageExecuted(address indexed token, uint256 amount, uint256 profit, uint256 indexed nonce);
    event TokenRecovered(address indexed token, uint256 amount);

    constructor(address morpho_, address v2Router_, address v3Router_, address baseToken_, uint256 expectedChainId_) {
        if (block.chainid != expectedChainId_) revert WrongChain();
        if (morpho_.code.length == 0 || v2Router_.code.length == 0 || v3Router_.code.length == 0 || baseToken_.code.length == 0)
            revert InvalidPlan();
        owner = msg.sender;
        morpho = morpho_;
        v2Router = v2Router_;
        v3Router = v3Router_;
        baseToken = baseToken_;
        expectedChainId = expectedChainId_;
    }

    function execute(Plan calldata plan) external returns (uint256 profit) {
        if (msg.sender != owner) revert Unauthorized();
        if (phase != 0) revert Busy();
        if (block.chainid != expectedChainId) revert WrongChain();
        _validate(plan);
        initialBaseBalance = _balance(baseToken);
        initialTokenBalance = _balance(plan.token);
        uint256 executionNonce = ++nonce;
        bytes memory data = abi.encode(plan, executionNonce);
        pendingHash = keccak256(data);
        phase = 1;
        IMorphoArb(morpho).flashLoan(baseToken, plan.amount, data);
        if (phase != 3) revert InvalidCallback();
        _approve(baseToken, morpho, 0);
        uint256 endingBase = _balance(baseToken);
        if (endingBase < initialBaseBalance || endingBase - initialBaseBalance < plan.minProfit) revert InsufficientProfit();
        if (_balance(plan.token) < initialTokenBalance) revert BalanceProtection();
        profit = endingBase - initialBaseBalance;
        _tokenCall(baseToken, abi.encodeCall(IERC20Arb.transfer, (owner, profit)));
        if (_balance(baseToken) < initialBaseBalance) revert BalanceProtection();
        pendingHash = bytes32(0);
        initialBaseBalance = 0;
        initialTokenBalance = 0;
        phase = 0;
        emit ArbitrageExecuted(plan.token, plan.amount, profit, executionNonce);
    }

    /// @dev Morpho Blue callback: lender transfers assets first and pulls repayment after this returns.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != morpho || phase != 1 || keccak256(data) != pendingHash) revert InvalidCallback();
        (Plan memory plan, uint256 executionNonce) = abi.decode(data, (Plan, uint256));
        if (executionNonce != nonce || assets != plan.amount) revert InvalidCallback();
        _validate(plan);
        phase = 2;
        if (_balance(baseToken) < initialBaseBalance + assets) revert BalanceProtection();
        _swap(baseToken, plan.token, assets, plan.minBuyOut, plan.buyKind, plan.buyFee, plan.deadline);
        if (_balance(baseToken) < initialBaseBalance || _balance(plan.token) < initialTokenBalance) revert BalanceProtection();
        uint256 purchased = _balance(plan.token) - initialTokenBalance;
        if (purchased < plan.minBuyOut) revert InsufficientOutput();
        uint256 baseBeforeSell = _balance(baseToken);
        _swap(plan.token, baseToken, purchased, plan.minSellOut, plan.sellKind, plan.sellFee, plan.deadline);
        if (_balance(plan.token) < initialTokenBalance) revert BalanceProtection();
        uint256 baseAfterSell = _balance(baseToken);
        if (baseAfterSell < baseBeforeSell || baseAfterSell - baseBeforeSell < plan.minSellOut) revert InsufficientOutput();
        if (baseAfterSell < initialBaseBalance + assets + plan.minProfit) revert InsufficientProfit();
        _approve(baseToken, morpho, 0);
        _approve(baseToken, morpho, assets);
        phase = 3;
    }

    function recoverToken(address token, uint256 amount) external {
        if (msg.sender != owner) revert Unauthorized();
        if (phase != 0) revert Busy();
        phase = 2;
        _tokenCall(token, abi.encodeCall(IERC20Arb.transfer, (owner, amount)));
        phase = 0;
        emit TokenRecovered(token, amount);
    }

    function _validate(Plan memory plan) private view {
        if (plan.deadline < block.timestamp) revert Expired();
        // Short-lived plans bound quote staleness; Arbitrum block.number is deliberately not used.
        if (plan.deadline > block.timestamp + 300 || plan.token == baseToken || plan.token.code.length == 0 ||
            plan.amount == 0 || plan.minProfit == 0 || plan.minBuyOut == 0 || plan.minSellOut == 0 ||
            (plan.buyKind != 2 && plan.buyKind != 3) || (plan.sellKind != 2 && plan.sellKind != 3) ||
            (plan.buyKind == 3 && plan.buyFee >= 1_000_000) || (plan.sellKind == 3 && plan.sellFee >= 1_000_000))
            revert InvalidPlan();
    }

    function _swap(address tokenIn, address tokenOut, uint256 amount, uint256 minimum, uint8 kind, uint24 fee, uint256 deadline) private {
        address router = kind == 2 ? v2Router : v3Router;
        _approve(tokenIn, router, 0);
        _approve(tokenIn, router, amount);
        if (kind == 2) {
            address[] memory path = new address[](2);
            path[0] = tokenIn; path[1] = tokenOut;
            IV2RouterArb(router).swapExactTokensForTokens(amount, minimum, path, address(this), deadline);
        } else {
            IV3RouterArb(router).exactInputSingle(IV3RouterArb.ExactInputSingleParams({tokenIn: tokenIn, tokenOut: tokenOut,
                fee: fee, recipient: address(this), amountIn: amount, amountOutMinimum: minimum, sqrtPriceLimitX96: 0}));
        }
        _approve(tokenIn, router, 0);
    }

    function _balance(address token) private view returns (uint256) { return IERC20Arb(token).balanceOf(address(this)); }
    function _approve(address token, address spender, uint256 amount) private {
        _tokenCall(token, abi.encodeCall(IERC20Arb.approve, (spender, amount)));
    }
    function _tokenCall(address token, bytes memory data) private {
        if (token.code.length == 0) revert TokenCallFailed();
        (bool ok, bytes memory result) = token.call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TokenCallFailed();
    }
}
