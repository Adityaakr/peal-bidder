// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqAuth} from "qore-pq-kit/PqAuth.sol";
import {MockERC20} from "peal-sealed-auction-test/mocks/MockERC20.sol";
import {SealedAuction} from "peal-sealed-auction/SealedAuction.sol";
import {BidderVault} from "../src/BidderVault.sol";
import {ISealedAuctionFactory} from "../src/interfaces/ISealedAuction.sol";
import {GatedToken} from "./Hostile.sol";
import {VaultBase} from "./VaultBase.sol";

contract BidderVaultOwnerTest is VaultBase {
    // ------------------------------------------------------------------ owner control is ML-DSA-87 only

    function test_ownerClassicalKeyAloneIsNothing() public {
        BidderVault.Policy memory p = _policy();
        p.operator = thief;
        BidderVault.Approval[] memory l = _one(auction);
        uint256 dl = block.timestamp + 1 hours;
        vm.startPrank(owner);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.setPolicy(p, l, dl, new bytes(4627));
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PqBadSignatureLength.selector, 65));
        vault.setPolicy(p, l, dl, new bytes(65));
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.sweep(quote, 1, dl, new bytes(4627));
        vm.expectRevert(BidderVault.TooEarly.selector);
        vault.sweepAfterExit(quote);
        vm.stopPrank();
    }

    function test_sweep_anyoneRelays_paysOwner_noReplay_noEdit() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _sweepSig(address(quote), 1e6, dl);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.sweep(quote, 2e6, dl, s);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.sweep(sale, 1e6, dl, s);
        vm.prank(thief);
        vault.sweep(quote, 1e6, dl, s);
        assertEq(quote.balanceOf(owner), 1e6);
        assertEq(quote.balanceOf(thief), 0);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.sweep(quote, 1e6, dl, s);
    }

    /// A signature for one action, or one vault, is nothing for another.
    function test_signatureIsBoundToActionAndVault() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory revokeSig = _sig(vault.REVOKE(), keccak256(abi.encode(address(quote), uint256(1e6))), dl);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.sweep(quote, 1e6, dl, revokeSig);
        BidderVault other = new BidderVault(owner, quote, ISealedAuctionFactory(address(factory)));
        quote.mint(address(other), 1e6);
        bytes memory s = _sweepSig(address(quote), 1e6, dl); // signed for `vault`, nonce 1
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        other.sweep(quote, 1e6, dl, s);
    }

    function test_signatureDeadline() public {
        uint256 dl = block.timestamp + 1 hours + 1;
        bytes memory s = _sweepSig(address(quote), 1e6, dl);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PqDeadlineTooFar.selector, dl, dl - 1));
        vault.sweep(quote, 1e6, dl, s);
        dl = block.timestamp + 1 hours;
        s = _sweepSig(address(quote), 1e6, dl);
        vm.warp(dl + 1);
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PqExpired.selector, dl, dl + 1));
        vault.sweep(quote, 1e6, dl, s);
    }

    /// Rotating the registered key takes the vault with it; the old key stops working at once.
    function test_ownerKeyRotation() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory old = _sweepSig(address(quote), 1e6, dl);
        registerPqKey(owner, keccak256("rotated"));
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.sweep(quote, 1e6, dl, old);
        ownerSecret = keccak256("rotated");
        vault.sweep(quote, 1e6, dl, _sweepSig(address(quote), 1e6, dl));
    }

    function test_revoke() public {
        _revoke();
        vm.expectRevert(BidderVault.NotOperator.selector);
        _raw(operator, address(auction), 1e6);
        assertFalse(vault.approved(address(auction)));
        assertEq(vault.approvedAuctions().length, 0);
        assertEq(vault.exitOpensAt(), block.timestamp + 14 days);
        (uint256 today, uint256 budget, uint256 bids) = vault.remaining();
        assertEq(today + budget + bids, 0);
        // address(0) is the operator now, and still cannot bid
        vm.expectRevert(BidderVault.PolicyExpired.selector);
        _raw(address(0), address(auction), 1e6);
    }

    function test_revoke_doesNotPostponeTheExit() public {
        (, uint64 expires,,,,) = vault.policy(); // not block.timestamp: via-IR would read it again after the warp
        vm.warp(uint256(expires) + 3 days);
        _revoke();
        assertEq(vault.exitOpensAt(), expires + 14 days);
    }

    function test_newPolicyDropsOldApprovals() public {
        SealedAuction other = _create(_config());
        _setPolicy(_policy(), _one(other));
        assertFalse(vault.approved(address(auction)));
        assertEq(vault.approvedAuctions().length, 1);
        assertEq(vault.approvedAuctions()[0], address(other));
        vm.expectRevert(abi.encodeWithSelector(BidderVault.NotApproved.selector, address(auction)));
        _raw(operator, address(auction), 1e6);
    }

    // ------------------------------------------------------------------ policies that are refused

    function _expectPolicyRevert(BidderVault.Policy memory p, BidderVault.Approval[] memory l, bytes memory err)
        internal
    {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _policySig(p, l, dl);
        vm.expectRevert(err);
        vault.setPolicy(p, l, dl, s);
    }

    function test_policyRefusesGatedSaleToken() public {
        GatedToken g = new GatedToken();
        SealedAuction.Config memory c = _config();
        c.saleToken = address(g);
        g.mint(issuer, c.totalSupply);
        vm.startPrank(issuer);
        g.approve(address(factory), c.totalSupply);
        address a = factory.createAuction(c, "Buyback", "PEAL-T for fUSD");
        vm.stopPrank();
        g.setRefused(address(vault));
        _expectPolicyRevert(_policy(), _one(SealedAuction(a)), "NotEligible");
    }

    function test_policyRefusesNonVenueAuction() public {
        BidderVault.Approval[] memory l = new BidderVault.Approval[](1);
        l[0] = BidderVault.Approval(thief, bytes32(0));
        _expectPolicyRevert(_policy(), l, abi.encodeWithSelector(BidderVault.NotVenueAuction.selector, thief));
        // The implementation itself is not one of the factory's auctions either.
        l[0].auction = factory.implementation();
        _expectPolicyRevert(
            _policy(), l, abi.encodeWithSelector(BidderVault.NotVenueAuction.selector, factory.implementation())
        );
    }

    function test_policyRefusesOtherConfig() public {
        BidderVault.Approval[] memory l = _one(auction);
        bytes32 actual = l[0].configHash;
        l[0].configHash = keccak256("what the owner thought it signed for");
        _expectPolicyRevert(
            _policy(), l, abi.encodeWithSelector(BidderVault.ConfigMismatch.selector, address(auction), actual)
        );
    }

    function test_policyRefusesBadValues() public {
        BidderVault.Approval[] memory l = _one(auction);
        BidderVault.Policy memory p = _policy();
        p.operator = address(0);
        _expectPolicyRevert(p, l, abi.encodeWithSelector(BidderVault.BadPolicy.selector, "operator"));
        p = _policy();
        p.expiresAt = uint64(block.timestamp);
        _expectPolicyRevert(p, l, abi.encodeWithSelector(BidderVault.BadPolicy.selector, "expiresAt"));
        p.expiresAt = uint64(block.timestamp + 30 days + 1);
        _expectPolicyRevert(p, l, abi.encodeWithSelector(BidderVault.BadPolicy.selector, "expiresAt"));
        for (uint256 i; i < 4; ++i) {
            p = _policy();
            if (i == 0) p.maxBids = 0;
            else if (i == 1) p.maxPerBid = 0;
            else if (i == 2) p.dailyLimit = 0;
            else p.budget = 0;
            _expectPolicyRevert(p, l, abi.encodeWithSelector(BidderVault.BadPolicy.selector, "zero limit"));
        }
        _expectPolicyRevert(
            _policy(), new BidderVault.Approval[](0), abi.encodeWithSelector(BidderVault.BadPolicy.selector, "auctions")
        );
        _expectPolicyRevert(
            _policy(),
            new BidderVault.Approval[](17),
            abi.encodeWithSelector(BidderVault.BadPolicy.selector, "auctions")
        );
    }

    function test_policyTakesLimitValues() public {
        BidderVault.Policy memory p = _policy();
        p.expiresAt = uint64(block.timestamp + 30 days);
        BidderVault.Approval[] memory l = new BidderVault.Approval[](16);
        for (uint256 i; i < 16; ++i) {
            l[i] = _approval(_create(_config()));
        }
        _setPolicy(p, l);
        assertEq(vault.approvedAuctions().length, 16);
    }

    // ------------------------------------------------------------------ exit

    function test_exitWithoutPrecompiles() public {
        vm.etch(PqAuth.PQC_VERIFY, "");
        vm.etch(PqAuth.PQC_KEY_STATUS, "");
        uint256 dl = block.timestamp + 1 hours;
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PqPrecompileUnavailable.selector, PqAuth.PQC_KEY_STATUS));
        vault.sweep(quote, 1, dl, new bytes(4627));
        vm.warp(block.timestamp + 15 days - 1);
        vm.expectRevert(BidderVault.TooEarly.selector);
        vault.sweepAfterExit(quote);
        vm.warp(block.timestamp + 1);
        vm.prank(thief);
        vault.sweepAfterExit(quote);
        assertEq(quote.balanceOf(owner), 300e6);
    }

    /// Money sent before any policy is not stuck if the precompiles go away.
    function test_exitBeforeAnyPolicy() public {
        BidderVault v = new BidderVault(owner, quote, ISealedAuctionFactory(address(factory)));
        quote.mint(address(v), 5e6);
        vm.expectRevert(BidderVault.TooEarly.selector);
        v.sweepAfterExit(quote);
        vm.warp(block.timestamp + 14 days);
        v.sweepAfterExit(quote);
        assertEq(quote.balanceOf(owner), 5e6);
    }

    // ------------------------------------------------------------------ deployment

    function test_constructor() public {
        ISealedAuctionFactory f = ISealedAuctionFactory(address(factory));
        address noKey = makeAddr("noKey");
        vm.expectRevert(abi.encodeWithSelector(PqAuth.PqKeyUnusable.selector, noKey, false, 0, false, 0));
        new BidderVault(noKey, quote, f);
        vm.expectRevert(abi.encodeWithSelector(BidderVault.BadPolicy.selector, "no code"));
        new BidderVault(owner, MockERC20(thief), f);
        vm.expectRevert(abi.encodeWithSelector(BidderVault.BadPolicy.selector, "no code"));
        new BidderVault(owner, quote, ISealedAuctionFactory(thief));
    }

    /// Plain QOR cannot be locked in here by mistake.
    function test_refusesNativeValue() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
    }

    /// The committee's reader decodes this selector from MsgExecuteEVM calldata: it must not change.
    function test_bidSelectorIsPinned() public pure {
        assertEq(BidderVault.bid.selector, bytes4(0xfc4c422a));
        assertEq(
            BidderVault.bid.selector, bytes4(keccak256("bid(address,uint32,bytes32,bytes32,bytes32[],bytes[],uint256)"))
        );
    }

    function test_configHashMatchesTheAuctionsOwnStruct() public view {
        SealedAuction.Config memory c = auction.config();
        assertEq(abi.encode(c).length, 19 * 32);
    }

    /// The signed policy is exactly the one applied: any edited field fails the signature.
    function testFuzz_editedPolicyRefused(uint8 field, uint128 delta) public {
        delta = uint128(bound(delta, 1, 1e6));
        BidderVault.Policy memory p = _policy();
        BidderVault.Approval[] memory l = _one(auction);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory s = _policySig(p, l, dl);
        field = field % 7;
        if (field == 0) p.operator = thief;
        else if (field == 1) p.expiresAt += uint64(delta);
        else if (field == 2) p.maxBids += uint32(delta);
        else if (field == 3) p.maxPerBid += delta;
        else if (field == 4) p.dailyLimit += delta;
        else if (field == 5) p.budget += delta;
        else l[0].configHash = bytes32(uint256(l[0].configHash) ^ delta);
        vm.expectRevert(PqAuth.PqSignatureInvalid.selector);
        vault.setPolicy(p, l, dl, s);
    }
}
