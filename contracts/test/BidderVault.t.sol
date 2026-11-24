// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqAuth} from "qore-pq-kit/PqAuth.sol";
import {SealedAuction} from "peal-sealed-auction/SealedAuction.sol";
import {BidderVault} from "../src/BidderVault.sol";
import {VaultBase} from "./VaultBase.sol";

contract BidderVaultTest is VaultBase {
    // ------------------------------------------------------------------ the whole life of a vault bid

    function test_bid_settle_claim_sweep() public {
        uint256 id = _vaultBid(20e18, 4); // 20 at 3.00
        assertEq(auction.getBid(id).bidder, address(vault));
        assertEq(quote.balanceOf(address(vault)), 300e6 - 60e6 - BOND);
        assertEq(quote.allowance(address(vault), address(auction)), 0);
        assertEq(quote.balanceOf(owner), 0); // nothing ever moves from the owner's account
        _bid(auction, makeAddr("rival"), 100e18, 1); // 100 at 1.50
        _close(auction);
        _release(auction, 1);
        _release(auction, 2);
        _openAll(auction);
        vm.warp(auction.config().releaseDeadline + 1);
        auction.finalize();
        assertEq(auction.clearingPrice(), 1_500_000);
        vm.prank(thief); // permissionless, and pays the vault
        auction.claim(id);
        assertEq(sale.balanceOf(address(vault)), 20e18);
        assertEq(quote.balanceOf(address(vault)), 300e6 - 30e6);
        uint256 dl = block.timestamp + 1 hours;
        vault.sweep(sale, 20e18, dl, _sweepSig(address(sale), 20e18, dl));
        assertEq(sale.balanceOf(owner), 20e18);
    }

    function test_failedAuction_refundsVaultInFull() public {
        uint256 id = _vaultBid(20e18, 4);
        _close(auction);
        vm.warp(uint256(auction.config().releaseDeadline) + 1);
        _openAll(auction);
        auction.finalize(); // nobody released
        auction.claim(id);
        assertEq(quote.balanceOf(address(vault)), 300e6);
    }

    function test_timeoutFailure_refundsVaultInFull() public {
        uint256 id = _vaultBid(20e18, 4);
        _close(auction);
        vm.warp(uint256(auction.config().releaseDeadline) + 3 days + 1);
        auction.failOnTimeout();
        auction.claim(id);
        assertEq(quote.balanceOf(address(vault)), 300e6);
    }

    /// The trap: a committee that cannot find a vault bid's envelopes flags it, and the bond burns.
    function test_TRAP_envelopesNotFound_burnsBond() public {
        uint256 id = _vaultBid(20e18, 4);
        _close(auction);
        _release(auction, 1, 1);
        _release(auction, 2, 1);
        _release(auction, 3, 1);
        _openAll(auction);
        auction.finalize();
        auction.claim(id);
        assertTrue(auction.getBid(id).bondBurned);
        assertEq(quote.balanceOf(address(vault)), 300e6 - BOND);
    }

    /// Sealing to the owner's address while the vault commits makes the shares fail their hashes.
    function test_sealedToOwnerInsteadOfVault_isWorthless() public {
        uint128 q = 1e18;
        uint256 e = auction.escrowFor(q, 0);
        Sealed memory z = _seal(address(auction), owner, 0, _plaintext(q, 0), 2, 1);
        vm.prank(operator);
        uint256 id = vault.bid(address(auction), 0, z.ct, z.keyHash, z.shareHashes, z.envelopes, e);
        dealt[address(auction)][id] = z.shares;
        _close(auction);
        uint256[] memory s = _releaseShares(auction, 1, 0);
        uint256 dl = block.timestamp + 10 minutes;
        bytes memory sg = _signRelease(auction, 1, s, 0, dl);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.WrongShare.selector, 0));
        auction.submitRelease(1, s, 0, dl, sg);
    }

    function test_bid_eventAndCounters() public {
        uint256 total = auction.escrowFor(20e18, 4) + BOND;
        Sealed memory z = _seal(address(auction), address(vault), 0, _plaintext(20e18, 4), 2, 7);
        vm.expectEmit(address(vault));
        emit BidderVault.BidPlaced(address(auction), 0, 0, total);
        vm.prank(operator);
        vault.bid(address(auction), 0, z.ct, z.keyHash, z.shareHashes, z.envelopes, total - BOND);
        assertEq(vault.budgetUsed(), total);
        assertEq(vault.bidsUsed(), 1);
        assertEq(vault.spentOn(block.timestamp / 1 days), total);
        (uint256 today, uint256 budget, uint256 bids) = vault.remaining();
        assertEq(today, 250e6 - total);
        assertEq(budget, 300e6 - total);
        assertEq(bids, 3);
    }

    // ------------------------------------------------------------------ what a stolen operator key can try

    function test_onlyOperator() public {
        vm.expectRevert(BidderVault.NotOperator.selector);
        _raw(thief, address(auction), 1e6);
    }

    function test_unapprovedAuction() public {
        SealedAuction other = _create(_config());
        vm.expectRevert(abi.encodeWithSelector(BidderVault.NotApproved.selector, address(other)));
        _raw(operator, address(other), 1e6);
    }

    function test_fakeAuction() public {
        vm.expectRevert(abi.encodeWithSelector(BidderVault.NotApproved.selector, thief));
        _raw(operator, thief, 1e6);
    }

    function test_tokenAsAuction() public {
        vm.expectRevert(abi.encodeWithSelector(BidderVault.NotApproved.selector, address(quote)));
        _raw(operator, address(quote), 1e6);
    }

    function test_perBid_exactBoundary() public {
        vm.expectRevert(abi.encodeWithSelector(BidderVault.OverPerBid.selector, 100e6 + 1));
        _raw(operator, address(auction), 100e6 - BOND + 1);
        _raw(operator, address(auction), 100e6 - BOND); // the limit itself is allowed
        assertEq(vault.budgetUsed(), 100e6);
    }

    function test_daily_exactBoundary() public {
        BidderVault.Policy memory p = _policy();
        p.dailyLimit = 120e6;
        _setPolicy(p, _one(auction));
        _vaultBidPt(_plaintext(1, 0), 95e6);
        vm.expectRevert(abi.encodeWithSelector(BidderVault.OverDaily.selector, 100e6, 20e6 + 1));
        _raw(operator, address(auction), 15e6 + 1);
        _vaultBidPt(_plaintext(1, 0), 15e6); // exactly the rest of the day
        assertEq(vault.spentOn(block.timestamp / 1 days), 120e6);
    }

    function test_daily_survivesPolicyChangeAndRevoke() public {
        _vaultBidPt(_plaintext(1, 0), 95e6);
        _vaultBidPt(_plaintext(1, 0), 95e6);
        _revoke();
        _setPolicy(_policy(), _one(auction));
        vm.expectRevert(abi.encodeWithSelector(BidderVault.OverDaily.selector, 200e6, 100e6));
        _raw(operator, address(auction), 95e6);
    }

    function test_daily_nextDayIsFresh() public {
        SealedAuction.Config memory c = _config();
        c.endTime = uint64(block.timestamp + 5 days);
        c.releaseDeadline = c.endTime + 1 hours;
        auction = _create(c);
        BidderVault.Policy memory p = _policy();
        p.expiresAt = uint64(block.timestamp + 5 days);
        p.dailyLimit = 100e6;
        _setPolicy(p, _one(auction));
        _vaultBidPt(_plaintext(1, 0), 95e6);
        vm.expectRevert(abi.encodeWithSelector(BidderVault.OverDaily.selector, 100e6, 6e6));
        _raw(operator, address(auction), 1e6);
        vm.warp((block.timestamp / 1 days + 1) * 1 days); // the next UTC midnight
        _vaultBidPt(_plaintext(1, 0), 95e6);
    }

    function test_budget_exactBoundary() public {
        BidderVault.Policy memory p = _policy();
        p.budget = 50e6;
        _setPolicy(p, _one(auction));
        vm.expectRevert(abi.encodeWithSelector(BidderVault.OverBudget.selector, 0, 50e6 + 1));
        _raw(operator, address(auction), 45e6 + 1);
        _vaultBidPt(_plaintext(1, 0), 45e6);
    }

    /// A new policy starts its own budget and bid count (only the day's spending carries over).
    function test_newPolicyResetsBudgetAndCount() public {
        BidderVault.Policy memory p = _policy();
        p.maxBids = 1;
        p.budget = 60e6;
        _setPolicy(p, _one(auction));
        _vaultBidPt(_plaintext(1, 0), 45e6);
        _setPolicy(p, _one(auction));
        assertEq(vault.bidsUsed(), 0);
        assertEq(vault.budgetUsed(), 0);
        _vaultBidPt(_plaintext(1, 0), 55e6);
        assertEq(vault.budgetUsed(), 60e6);
    }

    /// A refund does not give budget back: the limits are gross.
    function test_budget_isGross() public {
        uint256 id = _vaultBidPt(_plaintext(1, 0), 95e6);
        _close(auction);
        vm.warp(uint256(auction.config().releaseDeadline) + 3 days + 1);
        auction.failOnTimeout();
        auction.claim(id);
        assertEq(quote.balanceOf(address(vault)), 300e6);
        assertEq(vault.budgetUsed(), 100e6);
    }

    function test_maxBids() public {
        BidderVault.Policy memory p = _policy();
        p.maxBids = 1;
        _setPolicy(p, _one(auction));
        _vaultBid(1e18, 0);
        vm.expectRevert(BidderVault.TooManyBids.selector);
        _raw(operator, address(auction), 1e6);
    }

    function test_expiry_exactBoundary() public {
        BidderVault.Policy memory p = _policy();
        p.expiresAt = uint64(block.timestamp + 30 minutes);
        _setPolicy(p, _one(auction));
        vm.warp(p.expiresAt);
        vm.expectRevert(BidderVault.PolicyExpired.selector);
        _raw(operator, address(auction), 1e6);
        vm.warp(p.expiresAt - 1);
        _vaultBid(1e18, 0);
    }

    function test_hugeEscrow() public {
        vm.expectRevert(abi.encodeWithSelector(BidderVault.OverPerBid.selector, type(uint256).max));
        _raw(operator, address(auction), type(uint256).max);
    }

    function test_replayedBid_refusedBySeq() public {
        Sealed memory z = _seal(address(auction), address(vault), 0, _plaintext(1e18, 0), 2, 1);
        uint256 e = auction.escrowFor(1e18, 0);
        vm.startPrank(operator);
        vault.bid(address(auction), 0, z.ct, z.keyHash, z.shareHashes, z.envelopes, e);
        vm.expectRevert(abi.encodeWithSelector(SealedAuction.BadSeq.selector, 1));
        vault.bid(address(auction), 0, z.ct, z.keyHash, z.shareHashes, z.envelopes, e);
        vm.stopPrank();
    }

    /// The operator is not the owner: none of the owner's functions follow from `msg.sender`.
    function test_operatorCannotMoveMoney() public {
        uint256 dl = block.timestamp + 1 hours;
        vm.startPrank(operator);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.sweep(quote, 1, dl, new bytes(4627));
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.revoke(dl, new bytes(4627));
        vm.expectRevert(BidderVault.TooEarly.selector);
        vault.sweepAfterExit(quote);
        vm.stopPrank();
    }

    function test_junkBid_costsAtMostTheBond() public {
        uint256 id = _vaultBidPt(bytes32(type(uint256).max), 95e6); // malformed: bond burned, escrow back
        _close(auction);
        _release(auction, 1);
        _release(auction, 2);
        _release(auction, 3);
        _openAll(auction);
        auction.finalize();
        auction.claim(id);
        assertEq(quote.balanceOf(address(vault)), 300e6 - BOND);
    }

    /// Residual, stated in THREAT_MODEL.md: a stolen key can overpay inside an approved auction, up to the limits.
    function test_RESIDUAL_overpay() public {
        _vaultBid(18e18, 7); // 18 at 4.50 = 81 fUSD
        _vaultBidPt(_plaintext(18e18, 7), 81e6);
        _bid(auction, issuer, 64e18, 7); // a colluding issuer fills the rest at the top tick
        _close(auction);
        _release(auction, 1);
        _release(auction, 2);
        _release(auction, 3);
        _openAll(auction);
        auction.finalize();
        auction.claim(0);
        auction.claim(1);
        assertEq(auction.clearingPrice(), 4_500_000);
        assertEq(quote.balanceOf(address(vault)), 300e6 - 162e6); // 162 for what the reserve prices at 36
        assertEq(sale.balanceOf(address(vault)), 36e18); // but the tokens are the vault's
        assertEq(quote.balanceOf(thief) + sale.balanceOf(thief), 0);
    }

    // ------------------------------------------------------------------ fuzz

    /// Whatever the operator sends: quote leaves the vault only into the approved auction, inside every limit.
    function testFuzz_outflowOnlyToApproved(uint256 e1, uint256 e2, uint256 e3, bool junk) public {
        uint256[3] memory es = [e1, e2, e3];
        uint256 v0 = quote.balanceOf(address(vault));
        for (uint256 i; i < 3; ++i) {
            uint256 e = i == 2 ? es[i] : bound(es[i], 0, 400e6);
            uint32 seq = auction.bidCountOf(address(vault));
            bytes32 pt = junk ? bytes32(type(uint256).max) : _plaintext(1, 0);
            Sealed memory z = _seal(address(auction), address(vault), seq, pt, 2, i + 1);
            vm.prank(operator);
            try vault.bid(address(auction), seq, z.ct, z.keyHash, z.shareHashes, z.envelopes, e) {} catch {}
        }
        uint256 out = v0 - quote.balanceOf(address(vault));
        assertEq(out, quote.balanceOf(address(auction)));
        assertEq(out, vault.budgetUsed());
        assertLe(out, 250e6);
        assertEq(quote.allowance(address(vault), address(auction)), 0);
    }

    /// No caller but the operator, and no signature but the owner's, gets anything done.
    function testFuzz_strangers(address who, uint256 escrow, bytes32 garbage) public {
        vm.assume(who != operator);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = new bytes(4627);
        sig[0] = garbage[0];
        vm.expectRevert(BidderVault.NotOperator.selector);
        _raw(who, address(auction), escrow);
        vm.startPrank(who);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.sweep(quote, escrow, dl, sig);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.revoke(dl, sig);
        vm.expectRevert(BidderVault.TooEarly.selector);
        vault.sweepAfterExit(quote);
        vm.stopPrank();
    }

    function test_gas() public {
        uint128 qty = 1e18;
        uint256 esc = auction.escrowFor(qty, 0);
        Sealed memory z = _seal(address(auction), address(vault), 0, _plaintext(qty, 0), 2, 1);
        vm.prank(operator);
        uint256 g = gasleft();
        vault.bid(address(auction), 0, z.ct, z.keyHash, z.shareHashes, z.envelopes, esc);
        g -= gasleft();
        emit log_named_uint("vault.bid execution gas (first)", g);
        assertLt(g, 800_000); // what the agent provisions (DEFAULT_COMMIT_GAS)
    }
}
