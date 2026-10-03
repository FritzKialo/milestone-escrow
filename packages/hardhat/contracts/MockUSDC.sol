// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice Faucet token for testing the escrow. Not a real stablecoin.
contract MockUSDC is ERC20 {
    error MintAmountTooLarge();

    /// @notice Maximum amount anyone can mint per call: 10,000 mUSDC.
    uint256 public constant MAX_MINT = 10_000 * 10 ** 6;

    constructor() ERC20("Mock USDC", "mUSDC") {}

    /// @notice Mirrors real USDC, which uses 6 decimals.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet: anyone can mint up to MAX_MINT per call.
    /// @param to Recipient of the minted tokens
    /// @param amount Amount in token units (6 decimals)
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintAmountTooLarge();
        _mint(to, amount);
    }
}