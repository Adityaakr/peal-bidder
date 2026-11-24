// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SealedAuction} from "peal-sealed-auction/SealedAuction.sol";
import {BidderVault} from "../src/BidderVault.sol";

/// The hashes the owner's command line signs, fixed on both sides: test/vault.test.ts computes the same.
contract VectorsTest is Test {
    function test_policyArgsHash() public pure {
        BidderVault.Policy memory p = BidderVault.Policy(
            0x00000000000000000000000000000000000000A1, 1_800_000_000, 3, 100_000_000, 200_000_000, 300_000_000
        );
        BidderVault.Approval[] memory l = new BidderVault.Approval[](2);
        l[0] = BidderVault.Approval(0x1111111111111111111111111111111111111111, keccak256("a"));
        l[1] = BidderVault.Approval(0x2222222222222222222222222222222222222222, keccak256("b"));
        assertEq(
            keccak256(abi.encode(p, l)), 0xfcc6a6f8fe655d7df56d361d9a6fa4464c4d5bdddc410b2be80d404b770d7694, "policy"
        );
    }

    function test_configHash() public pure {
        SealedAuction.Config memory c = SealedAuction.Config({
            issuer: 0x7777777777777777777777777777777777777777,
            saleToken: 0x8888888888888888888888888888888888888888,
            quoteToken: 0x97143B771D34ddb9130b807b135Ae675A5a963CA,
            totalSupply: 100e18,
            saleDecimals: 18,
            reservePrice: 1_000_000,
            tickSize: 500_000,
            numTicks: 48,
            startTime: 1_000,
            endTime: 2_000_000_000,
            releaseDeadline: 2_000_100_000,
            minBidQuantity: 1e18,
            maxQuantityPerAddress: 0,
            maxBids: 32,
            bidBond: 1_000_000,
            protocolFeeBps: 100,
            feeRecipient: 0x9999999999999999999999999999999999999999,
            committeeSetId: bytes32(uint256(0xab)),
            metadataHash: bytes32(uint256(0xcd))
        });
        assertEq(keccak256(abi.encode(c)), 0xf11d57d94760e2424c893998985bdb4eb572566dbe7cddf0466f6ccc5c5f4f36, "config");
    }
}
