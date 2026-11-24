// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {AuctionBase} from "peal-sealed-auction-test/utils/AuctionBase.sol";
import {SealedAuction} from "peal-sealed-auction/SealedAuction.sol";
import {BidderVault} from "../src/BidderVault.sol";
import {ISealedAuctionFactory} from "../src/interfaces/ISealedAuction.sol";

/// A vault in front of the REAL SealedAuction, with the owner's key behind the kit's precompile mocks.
abstract contract VaultBase is AuctionBase {
    BidderVault internal vault;
    SealedAuction internal auction;
    address internal owner = makeAddr("owner");
    bytes32 internal ownerSecret = keccak256("owner");
    /// Smart-account lane: the linked key acts as the owner's own 0x address.
    address internal operator = owner;
    address internal thief = makeAddr("thief");

    function setUp() public virtual override {
        super.setUp();
        registerPqKey(owner, ownerSecret);
        vault = new BidderVault(owner, quote, ISealedAuctionFactory(address(factory)));
        auction = _create(_config());
        quote.mint(address(vault), 300e6);
        _setPolicy(_policy(), _one(auction));
    }

    function _policy() internal view returns (BidderVault.Policy memory) {
        return BidderVault.Policy({
            operator: operator,
            expiresAt: uint64(block.timestamp + 1 days),
            maxBids: 4,
            maxPerBid: 100e6,
            dailyLimit: 250e6,
            budget: 300e6
        });
    }

    function _approval(SealedAuction a) internal view returns (BidderVault.Approval memory) {
        return BidderVault.Approval(address(a), keccak256(abi.encode(a.config())));
    }

    function _one(SealedAuction a) internal view returns (BidderVault.Approval[] memory l) {
        l = new BidderVault.Approval[](1);
        l[0] = _approval(a);
    }

    function _nonce() internal view returns (uint64 n) {
        (, n) = vault.owner();
    }

    function _sig(bytes32 action, bytes32 argsHash, uint256 deadline) internal view returns (bytes memory) {
        return pqSign(ownerSecret, pqMessage(address(vault), owner, action, _nonce(), deadline, argsHash));
    }

    function _policySig(BidderVault.Policy memory p, BidderVault.Approval[] memory l, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sig(vault.SET_POLICY(), keccak256(abi.encode(p, l)), deadline);
    }

    function _setPolicy(BidderVault.Policy memory p, BidderVault.Approval[] memory l) internal {
        uint256 deadline = block.timestamp + 1 hours;
        vault.setPolicy(p, l, deadline, _policySig(p, l, deadline));
    }

    function _revoke() internal {
        uint256 deadline = block.timestamp + 1 hours;
        vault.revoke(deadline, _sig(vault.REVOKE(), bytes32(0), deadline));
    }

    function _sweepSig(address token, uint256 amount, uint256 deadline) internal view returns (bytes memory) {
        return _sig(vault.SWEEP(), keccak256(abi.encode(token, amount)), deadline);
    }

    function _vaultBid(uint128 qty, uint16 tick) internal returns (uint256) {
        return _vaultBidPt(_plaintext(qty, tick), auction.escrowFor(qty, tick));
    }

    function _vaultBidPt(bytes32 pt, uint256 escrow) internal returns (uint256 id) {
        uint32 seq = auction.bidCountOf(address(vault));
        Sealed memory z = _seal(address(auction), address(vault), seq, pt, 2, uint256(keccak256(abi.encode(seq, "v"))));
        vm.prank(operator);
        id = vault.bid(address(auction), seq, z.ct, z.keyHash, z.shareHashes, z.envelopes, escrow);
        dealt[address(auction)][id] = z.shares;
    }

    /// A bid call with junk inside, for the refusals that come before the auction is reached.
    function _raw(address who, address a, uint256 escrow) internal {
        Sealed memory z = _seal(address(auction), address(vault), 0, _plaintext(1, 0), 2, 1);
        vm.prank(who);
        vault.bid(a, 0, z.ct, z.keyHash, z.shareHashes, z.envelopes, escrow);
    }
}
