// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title ISealedAuction
/// @notice The part of Peal Sealed Auction the vault calls. The struct must stay identical to
///         `SealedAuction.Config`; the tests run against the real contract, so a drift fails them.
interface ISealedAuction {
    struct Config {
        address issuer;
        address saleToken;
        address quoteToken;
        uint256 totalSupply;
        uint8 saleDecimals;
        uint256 reservePrice;
        uint256 tickSize;
        uint16 numTicks;
        uint64 startTime;
        uint64 endTime;
        uint64 releaseDeadline;
        uint256 minBidQuantity;
        uint256 maxQuantityPerAddress;
        uint32 maxBids;
        uint256 bidBond;
        uint16 protocolFeeBps;
        address feeRecipient;
        bytes32 committeeSetId;
        bytes32 metadataHash;
    }

    function config() external view returns (Config memory);

    function commitBid(
        uint32 seq,
        bytes32 ct,
        bytes32 keyHash,
        bytes32[] calldata shareHashes,
        bytes[] calldata envelopes,
        uint256 escrow
    ) external returns (uint256 bidId);
}

interface ISealedAuctionFactory {
    function isAuction(address auction) external view returns (bool);
}
