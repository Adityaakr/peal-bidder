// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "peal-sealed-auction-test/mocks/MockERC20.sol";
import {SealedAuction} from "peal-sealed-auction/SealedAuction.sol";
import {BidderVault} from "../src/BidderVault.sol";

/// Refuses one holder, the way PEAL-B refuses a contract.
contract GatedToken is MockERC20("Gated", "GATE", 18) {
    address public refused;

    function setRefused(address a) external {
        refused = a;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to != refused, "NotEligible");
        super._update(from, to, value);
    }
}

/// A factory that vouches for anything: the hostile venue the outflow checks defend against.
contract OpenFactory {
    function isAuction(address) external pure returns (bool) {
        return true;
    }
}

abstract contract HostileAuction {
    SealedAuction.Config internal _c;

    constructor(SealedAuction.Config memory c) {
        _c = c;
    }

    function config() external view returns (SealedAuction.Config memory) {
        return _c;
    }

    function commitBid(uint32, bytes32, bytes32, bytes32[] calldata, bytes[] calldata, uint256 escrow)
        external
        returns (uint256)
    {
        _take(escrow + _c.bidBond);
        return 0;
    }

    function _take(uint256 total) internal virtual;
}

/// Pulls what was agreed; records the allowance it was given.
contract LazyAuction is HostileAuction {
    uint256 public allowanceSeen;

    constructor(SealedAuction.Config memory c) HostileAuction(c) {}

    function _take(uint256 total) internal override {
        allowanceSeen = IERC20(_c.quoteToken).allowance(msg.sender, address(this));
        IERC20(_c.quoteToken).transferFrom(msg.sender, address(this), total);
    }

    function pullAgain(address from) external {
        IERC20(_c.quoteToken).transferFrom(from, address(this), 1);
    }
}

/// A token whose transferFrom does not use the allowance up.
contract StickyAllowanceToken is MockERC20("Sticky", "STK", 6) {
    function _spendAllowance(address owner, address spender, uint256 value) internal view override {
        require(allowance(owner, spender) >= value, "allowance");
    }
}

/// Takes nothing and hopes to keep the allowance.
contract StickyAuction is HostileAuction {
    constructor(SealedAuction.Config memory c) HostileAuction(c) {}

    function _take(uint256) internal override {}
}

/// Takes one unit too many.
contract GreedyAuction is HostileAuction {
    constructor(SealedAuction.Config memory c) HostileAuction(c) {}

    function _take(uint256 total) internal override {
        IERC20(_c.quoteToken).transferFrom(msg.sender, address(this), total + 1);
    }
}

/// On the vault's zero-value probe, calls back into every entry point.
contract ReentrantToken is MockERC20("Re", "RE", 18) {
    BidderVault public vault;
    bool public called;
    bool public allRefused;
    bool internal armed;

    function arm(BidderVault v) external {
        vault = v;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!armed) return;
        armed = false;
        called = true;
        bytes[] memory calls = new bytes[](5);
        BidderVault.Policy memory p;
        calls[0] = abi.encodeCall(vault.bid, (address(this), 0, 0, 0, new bytes32[](0), new bytes[](0), 1));
        calls[1] = abi.encodeCall(vault.setPolicy, (p, new BidderVault.Approval[](0), 0, ""));
        calls[2] = abi.encodeCall(vault.revoke, (0, ""));
        calls[3] = abi.encodeCall(vault.sweep, (IERC20(address(this)), 0, 0, ""));
        calls[4] = abi.encodeCall(vault.sweepAfterExit, (IERC20(address(this))));
        bool refused = true;
        bytes4 guard = bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = address(vault).call(calls[i]);
            if (ok || ret.length < 4 || bytes4(ret) != guard) refused = false;
        }
        allRefused = refused;
    }
}
