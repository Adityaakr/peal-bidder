// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {MockERC20} from "peal-sealed-auction-test/mocks/MockERC20.sol";
import {SealedAuction} from "peal-sealed-auction/SealedAuction.sol";
import {BidderVault} from "../src/BidderVault.sol";
import {ISealedAuctionFactory} from "../src/interfaces/ISealedAuction.sol";
import {
    GreedyAuction,
    LazyAuction,
    OpenFactory,
    ReentrantToken,
    StickyAllowanceToken,
    StickyAuction
} from "./Hostile.sol";
import {VaultBase} from "./VaultBase.sol";

contract BidderVaultHostileTest is VaultBase {
    // ------------------------------------------------------------------ defence in depth against a hostile venue (the three surviving mutants)

    /// With a token that does not use allowances up, the vault itself must take the allowance back.
    function test_MUTANT_allowanceResetToZero() public {
        StickyAllowanceToken t = new StickyAllowanceToken();
        SealedAuction.Config memory c = _config();
        c.quoteToken = address(t);
        LazyAuction a = new LazyAuction(c);
        BidderVault v = new BidderVault(owner, t, ISealedAuctionFactory(address(new OpenFactory())));
        t.mint(address(v), 300e6);
        _hostilePolicy(v, address(a));
        vm.prank(operator);
        v.bid(address(a), 0, 0, 0, new bytes32[](0), new bytes[](0), 10e6);
        assertEq(a.allowanceSeen(), 10e6 + BOND);
        assertEq(t.balanceOf(address(a)), 10e6 + BOND);
        assertEq(t.allowance(address(v), address(a)), 0);
        vm.expectRevert(); // so a later pull takes nothing
        a.pullAgain(address(v));
    }

    /// USDT-style and leftover allowances: set to exactly the total, never added to.
    function test_MUTANT_allowanceIsExact() public {
        LazyAuction lazy = new LazyAuction(_hostileConfig(address(quote)));
        (BidderVault v, address a) = _hostile(address(lazy));
        vm.prank(operator);
        v.bid(a, 0, 0, 0, new bytes32[](0), new bytes[](0), 0);
        assertEq(lazy.allowanceSeen(), BOND);
    }

    function test_MUTANT_wrongQuoteRefused() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        SealedAuction.Config memory c = _config();
        c.quoteToken = address(other);
        SealedAuction a = _create(c);
        BidderVault.Policy memory p = _policy();
        BidderVault.Approval[] memory l = _one(a);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _policySig(p, l, dl);
        vm.expectRevert(abi.encodeWithSelector(BidderVault.WrongQuote.selector, address(a)));
        vault.setPolicy(p, l, dl, s);
    }

    function test_MUTANT_outflowMustEqualEscrowPlusBond() public {
        (BidderVault v, address a) = _hostile(address(new StickyAuction(_hostileConfig(address(quote)))));
        vm.expectRevert(abi.encodeWithSelector(BidderVault.UnexpectedOutflow.selector, 0, 10e6 + BOND));
        vm.prank(operator);
        v.bid(a, 0, 0, 0, new bytes32[](0), new bytes[](0), 10e6);
        // Taking more than agreed is impossible: the allowance is exact.
        (v, a) = _hostile(address(new GreedyAuction(_hostileConfig(address(quote)))));
        vm.expectRevert();
        vm.prank(operator);
        v.bid(a, 0, 0, 0, new bytes32[](0), new bytes[](0), 10e6);
        assertEq(quote.balanceOf(address(v)), 300e6);
    }

    /// A sale token that calls back during the probe finds every entry point locked.
    function test_reentrancyFromSaleTokenProbe() public {
        ReentrantToken r = new ReentrantToken();
        OpenFactory f = new OpenFactory();
        BidderVault v = new BidderVault(owner, quote, ISealedAuctionFactory(address(f)));
        quote.mint(address(v), 300e6);
        r.arm(v);
        LazyAuction a = new LazyAuction(_hostileConfig(address(r)));
        _hostilePolicy(v, address(a));
        assertTrue(r.called());
        assertTrue(r.allRefused());
    }

    // ------------------------------------------------------------------ helpers

    function _hostileConfig(address saleToken) internal view returns (SealedAuction.Config memory c) {
        c = _config();
        if (saleToken != address(quote)) c.saleToken = saleToken;
    }

    function _hostile(address a) internal returns (BidderVault v, address) {
        v = new BidderVault(owner, quote, ISealedAuctionFactory(address(new OpenFactory())));
        quote.mint(address(v), 300e6);
        _hostilePolicy(v, a);
        return (v, a);
    }

    function _hostilePolicy(BidderVault v, address a) internal {
        BidderVault.Approval[] memory l = new BidderVault.Approval[](1);
        l[0] = BidderVault.Approval(a, keccak256(abi.encode(SealedAuction(a).config())));
        BidderVault.Policy memory p = _policy();
        uint256 dl = block.timestamp + 1 hours;
        bytes memory m = pqMessage(address(v), owner, v.SET_POLICY(), 0, dl, keccak256(abi.encode(p, l)));
        v.setPolicy(p, l, dl, pqSign(ownerSecret, m));
    }
}
