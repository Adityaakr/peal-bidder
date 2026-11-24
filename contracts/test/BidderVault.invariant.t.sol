// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {SealedAuction} from "peal-sealed-auction/SealedAuction.sol";
import {BidderVault} from "../src/BidderVault.sol";
import {VaultBase} from "./VaultBase.sol";

/// Drives the vault as a thief of the operator key, the owner, strangers and the clock would.
contract VaultHandler is VaultBase {
    SealedAuction[2] public auctions; // approved, and a real auction of the venue that is not
    uint256 public committed; // gross, all bids
    uint256 public swept;
    uint256 public bidsPlaced;
    uint256 public epochBids;
    uint256 public epochCommitted;
    uint256 public maxSpentInADay;
    /// The loosest daily limit any policy on that day allowed, and what was spent.
    mapping(uint256 day => uint256) public loosest;
    mapping(uint256 day => bool) internal _seen;
    uint256[] public daysSeen;
    uint256[] internal _ids;

    /// fUSD in the vault when the owner stopped funding it.
    uint256 public constant FUNDED = 300e6;

    function init() external {
        setUp();
        SealedAuction.Config memory c = _config(); // open long enough for several UTC days of bids
        c.endTime = uint64(vm.getBlockTimestamp() + 10 days);
        c.releaseDeadline = c.endTime + 1 hours;
        auctions[0] = auction = _create(c);
        auctions[1] = _create(_config());
        _setPolicy(_policy(), _one(auction));
        _note();
    }

    function _note() internal {
        uint256 day = vm.getBlockTimestamp() / 1 days;
        if (!_seen[day]) {
            _seen[day] = true;
            daysSeen.push(day);
        }
        (,,,, uint128 daily,) = vault.policy();
        if (daily > loosest[day]) loosest[day] = daily;
    }

    function daysCount() external view returns (uint256) {
        return daysSeen.length;
    }

    function theVault() external view returns (BidderVault) {
        return vault;
    }

    function balances() external view returns (uint256 inVault, uint256 inAuctions, uint256 burned, uint256 withOwner) {
        inVault = quote.balanceOf(address(vault));
        inAuctions = quote.balanceOf(address(auctions[0])) + quote.balanceOf(address(auctions[1]));
        burned = quote.balanceOf(address(0xdEaD));
        withOwner = quote.balanceOf(owner);
    }

    function allowances() external view returns (uint256) {
        return
            quote.allowance(address(vault), address(auctions[0]))
                + quote.allowance(address(vault), address(auctions[1]));
    }

    function elsewhere() external view returns (uint256) {
        return quote.balanceOf(thief) + quote.balanceOf(operator == owner ? address(1) : operator);
    }

    // ------------------------------------------------------------------ actions

    function bid(uint256 which, uint256 escrow, bool asOperator) external {
        SealedAuction a = auctions[which % 2];
        escrow = escrow % 5 == 0 ? escrow : bound(escrow, 0, 130e6);
        uint32 seq = a.bidCountOf(address(vault));
        Sealed memory z = _seal(address(a), address(vault), seq, _plaintext(1, 0), 2, seq + 1);
        uint256 before = quote.balanceOf(address(vault));
        _note();
        vm.prank(asOperator ? operator : thief);
        try vault.bid(address(a), seq, z.ct, z.keyHash, z.shareHashes, z.envelopes, escrow) {
            require(asOperator && which % 2 == 0, "a bid that had to be refused");
            uint256 total = escrow + BOND;
            require(before - quote.balanceOf(address(vault)) == total, "outflow");
            committed += total;
            epochCommitted += total;
            ++epochBids;
            ++bidsPlaced;
        } catch {}
    }

    function policy(uint128 perBid, uint128 daily, uint128 budget, uint32 maxBids, uint32 life) external {
        BidderVault.Policy memory p = _policy();
        p.maxPerBid = uint128(bound(perBid, 1, 150e6));
        p.dailyLimit = uint128(bound(daily, 1, 250e6));
        p.budget = uint128(bound(budget, 1, 300e6));
        p.maxBids = uint32(bound(maxBids, 1, 6));
        p.expiresAt = uint64(vm.getBlockTimestamp() + bound(life, 1, 30 days));
        BidderVault.Approval[] memory l = _one(auctions[0]);
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        vault.setPolicy(p, l, dl, _policySig(p, l, dl));
        epochBids = 0;
        epochCommitted = 0;
        _note();
    }

    function forgedPolicy(uint256 seed) external {
        BidderVault.Policy memory p = _policy();
        p.operator = thief;
        bytes memory sig = new bytes(4627);
        sig[seed % 4627] = 0x01;
        try vault.setPolicy(p, _one(auctions[1]), vm.getBlockTimestamp() + 1 hours, sig) {
            revert("forged policy accepted");
        } catch {}
    }

    function revokeByOwner() external {
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        vault.revoke(dl, _sig(vault.REVOKE(), bytes32(0), dl));
        epochBids = 0; // counters restart with the next policy
        epochCommitted = 0;
    }

    function sweepByOwner(uint256 amount) external {
        amount = bound(amount, 0, quote.balanceOf(address(vault)) / 4);
        uint256 dl = vm.getBlockTimestamp() + 1 hours;
        vm.prank(thief);
        vault.sweep(quote, amount, dl, _sweepSig(address(quote), amount, dl));
        swept += amount;
    }

    function exit() external {
        uint256 b = quote.balanceOf(address(vault));
        bool early = vm.getBlockTimestamp() < vault.exitOpensAt();
        vm.prank(thief);
        try vault.sweepAfterExit(quote) {
            require(!early, "exit opened early");
            swept += b;
        } catch {}
    }

    function claim(uint256 id) external {
        SealedAuction a = auctions[0];
        if (a.bidCount() == 0) return;
        vm.prank(thief);
        try a.claim(id % a.bidCount()) {} catch {}
    }

    function settleByTimeout() external {
        SealedAuction a = auctions[0];
        if (vm.getBlockTimestamp() < a.config().endTime) return;
        try a.closeCommit() {} catch {}
        try a.failOnTimeout() {} catch {}
    }

    function wait(uint256 dt) external {
        vm.warp(vm.getBlockTimestamp() + bound(dt, 1, 20 hours));
        _note();
    }
}

contract BidderVaultInvariantTest is VaultBase {
    VaultHandler internal h;

    function setUp() public override {
        h = new VaultHandler();
        h.init();
        bytes4[] memory s = new bytes4[](10);
        s[0] = VaultHandler.bid.selector;
        s[1] = VaultHandler.bid.selector; // bid more often than anything else
        s[2] = VaultHandler.policy.selector;
        s[3] = VaultHandler.forgedPolicy.selector;
        s[4] = VaultHandler.revokeByOwner.selector;
        s[5] = VaultHandler.sweepByOwner.selector;
        s[6] = VaultHandler.exit.selector;
        s[7] = VaultHandler.claim.selector;
        s[8] = VaultHandler.settleByTimeout.selector;
        s[9] = VaultHandler.wait.selector;
        targetSelector(FuzzSelector(address(h), s));
        targetContract(address(h));
    }

    /// The budget is in the vault, in the approved auction, burned as a bond, or with the owner. Nowhere else.
    function invariant_moneyIsNowhereElse() public view {
        (uint256 inVault, uint256 inAuctions, uint256 burned, uint256 withOwner) = h.balances();
        assertEq(inVault + inAuctions + burned + withOwner, h.FUNDED());
        assertEq(h.elsewhere(), 0);
        assertEq(withOwner, h.swept());
    }

    function invariant_noStandingAllowance() public view {
        assertEq(h.allowances(), 0);
    }

    function invariant_policyLimits() public view {
        (,, uint32 maxBids,,, uint128 budget) = h.theVault().policy();
        assertLe(h.epochCommitted(), budget);
        assertLe(h.epochBids(), maxBids);
    }

    function invariant_dailyLimitAcrossPolicies() public view {
        for (uint256 i; i < h.daysCount(); ++i) {
            uint256 day = h.daysSeen(i);
            assertLe(h.theVault().spentOn(day), h.loosest(day));
        }
    }
}
