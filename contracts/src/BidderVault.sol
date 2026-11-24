// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PqAuth} from "qore-pq-kit/PqAuth.sol";

import {ISealedAuction, ISealedAuctionFactory} from "./interfaces/ISealedAuction.sol";

/// @title BidderVault
/// @notice Holds Peal Bidder's budget and places its bids. NOT AUDITED: testnet only.
///
/// The bidder of every bid is this contract, so a bid moves nothing from the owner's account and
/// the agent's spending rule need not list any token the account holds.
///
/// - `operator` may call `bid` and nothing else: only in auctions on the owner's signed list, and
///   within the per-bid, per-day, budget, count and expiry limits. On the smart-account lane the
///   operator is the owner's own 0x address, which is what the agent's linked key acts as, so
///   `msg.sender == owner` must authorise nothing but a bid. On the EVM lane it is the agent's account.
/// - Setting the policy, revoking it and withdrawing need a fresh ML-DSA-87 signature by the owner
///   account's registered key (`PqAuth`). Anyone may relay it; the sender authorises nothing.
/// - Withdrawals pay the owner's account, whoever sends them.
/// - Refunds and winnings come back through the auction's own permissionless `claim`, which pays the
///   bidder, so the vault needs no claim function.
/// - If the precompiles are ever switched off, `sweepAfterExit` still pays everything to the owner,
///   14 days after the policy's expiry.
///
/// What it does not stop: whoever holds the operator's key can, inside the limits, overpay in an
/// approved auction (the vault cannot read a sealed price), burn bonds with junk bids, and lock the
/// budget until those auctions settle.
contract BidderVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PqAuth for PqAuth.Signer;

    struct Policy {
        address operator;
        uint64 expiresAt;
        uint32 maxBids;
        uint128 maxPerBid; // escrow + bond
        uint128 dailyLimit; // per UTC day, gross: refunds do not give it back
        uint128 budget; // gross, over the policy's life
    }

    /// @notice An auction the owner approves, with the hash of its whole configuration.
    struct Approval {
        address auction;
        bytes32 configHash;
    }

    bytes32 public constant SET_POLICY = keccak256("BidderVault.setPolicy");
    bytes32 public constant REVOKE = keccak256("BidderVault.revoke");
    bytes32 public constant SWEEP = keccak256("BidderVault.sweep");
    /// @notice The furthest in the future an owner signature's deadline may be.
    uint256 public constant MAX_TTL = 1 hours;
    uint256 public constant MAX_POLICY_LIFE = 30 days;
    uint256 public constant EXIT_DELAY = 14 days;
    uint256 public constant MAX_AUCTIONS = 16;

    IERC20 public immutable quote;
    ISealedAuctionFactory public immutable factory;
    uint256 public immutable createdAt;

    PqAuth.Signer public owner;
    Policy public policy;
    /// @notice Goes up with every `setPolicy` and `revoke`; approvals belong to one epoch.
    uint256 public epoch;
    uint32 public bidsUsed;
    uint128 public budgetUsed;
    /// @notice Escrow and bonds committed on a UTC day. Never reset, not even by a new policy.
    mapping(uint256 day => uint256) public spentOn;

    address[] internal _auctions;
    mapping(uint256 epoch => mapping(address auction => bool)) internal _approved;
    mapping(address auction => uint256) public bondOf;

    event PolicySet(uint256 indexed epoch, Policy policy, Approval[] approvals);
    event Revoked(uint256 indexed epoch);
    event BidPlaced(address indexed auction, uint256 indexed bidId, uint32 seq, uint256 total);
    event Swept(address indexed token, uint256 amount);

    error NotOperator();
    error PolicyExpired();
    error NotApproved(address auction);
    error NotVenueAuction(address auction);
    error ConfigMismatch(address auction, bytes32 actual);
    error WrongQuote(address auction);
    error OverPerBid(uint256 total);
    error OverDaily(uint256 spent, uint256 total);
    error OverBudget(uint256 used, uint256 total);
    error TooManyBids();
    error UnexpectedOutflow(uint256 got, uint256 expected);
    error BadPolicy(string what);
    error TooEarly();

    /// @param owner_ must already have an ML-DSA-87 key registered with a proven possession
    constructor(address owner_, IERC20 quote_, ISealedAuctionFactory factory_) {
        if (address(quote_).code.length == 0 || address(factory_).code.length == 0) revert BadPolicy("no code");
        owner.init(owner_);
        quote = quote_;
        factory = factory_;
        createdAt = block.timestamp;
    }

    // ------------------------------------------------------------------ the owner, by ML-DSA-87 signature

    /// @notice Replace the operator, the limits and the approved auctions. The day's spending carries over.
    function setPolicy(Policy calldata p, Approval[] calldata approvals, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        owner.authorize(SET_POLICY, keccak256(abi.encode(p, approvals)), deadline, MAX_TTL, signature);
        if (p.operator == address(0)) revert BadPolicy("operator");
        if (p.expiresAt <= block.timestamp || p.expiresAt > block.timestamp + MAX_POLICY_LIFE) {
            revert BadPolicy("expiresAt");
        }
        if (p.maxBids == 0 || p.maxPerBid == 0 || p.dailyLimit == 0 || p.budget == 0) revert BadPolicy("zero limit");
        if (approvals.length == 0 || approvals.length > MAX_AUCTIONS) revert BadPolicy("auctions");

        uint256 e = ++epoch;
        policy = p;
        bidsUsed = 0;
        budgetUsed = 0;
        delete _auctions;
        for (uint256 i; i < approvals.length; ++i) {
            _approve(e, approvals[i]);
        }
        emit PolicySet(e, p, approvals);
    }

    function _approve(uint256 e, Approval calldata a) internal {
        if (!factory.isAuction(a.auction)) revert NotVenueAuction(a.auction);
        ISealedAuction.Config memory c = ISealedAuction(a.auction).config();
        bytes32 actual = keccak256(abi.encode(c));
        if (actual != a.configHash) revert ConfigMismatch(a.auction, actual);
        if (c.quoteToken != address(quote)) revert WrongQuote(a.auction);
        // A sale token that refuses this contract (PEAL-B does) would make `claim` revert and lock
        // the refund with it, so ask it now. It can still change its mind later: approve known tokens.
        IERC20(c.saleToken).safeTransfer(address(this), 0);
        bondOf[a.auction] = c.bidBond;
        _approved[e][a.auction] = true;
        _auctions.push(a.auction);
    }

    /// @notice Stop all bidding now, and start the exit clock if it has not started.
    function revoke(uint256 deadline, bytes calldata signature) external nonReentrant {
        owner.authorize(REVOKE, bytes32(0), deadline, MAX_TTL, signature);
        uint256 e = ++epoch;
        policy.operator = address(0);
        // Seconds since 1970 fit in uint64.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (policy.expiresAt > block.timestamp) policy.expiresAt = uint64(block.timestamp);
        delete _auctions;
        emit Revoked(e);
    }

    /// @notice Withdraw to the owner's account, whoever sends the transaction.
    function sweep(IERC20 token, uint256 amount, uint256 deadline, bytes calldata signature) external nonReentrant {
        owner.authorize(SWEEP, keccak256(abi.encode(token, amount)), deadline, MAX_TTL, signature);
        token.safeTransfer(owner.account, amount);
        emit Swept(address(token), amount);
    }

    // ------------------------------------------------------------------ anyone

    /// @notice The exit that needs no precompile: everything to the owner's account, long after the
    ///         policy's expiry (or the deployment, when there never was a policy).
    function sweepAfterExit(IERC20 token) external nonReentrant {
        if (block.timestamp < exitOpensAt()) revert TooEarly();
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(owner.account, amount);
        emit Swept(address(token), amount);
    }

    // ------------------------------------------------------------------ the operator

    /// @notice Place a sealed bid from this vault's money. The seal must bind this contract as the bidder.
    /// @dev The committee's reader decodes this function's calldata for the envelopes: on the
    ///      smart-account lane the auction's logs do not exist. Keep the signature.
    function bid(
        address auction,
        uint32 seq,
        bytes32 ct,
        bytes32 keyHash,
        bytes32[] calldata shareHashes,
        bytes[] calldata envelopes,
        uint256 escrow
    ) external nonReentrant returns (uint256 bidId) {
        uint256 total = _charge(auction, escrow);

        uint256 before = quote.balanceOf(address(this));
        quote.forceApprove(auction, total);
        bidId = ISealedAuction(auction).commitBid(seq, ct, keyHash, shareHashes, envelopes, escrow);
        quote.forceApprove(auction, 0);
        uint256 afterwards = quote.balanceOf(address(this));
        if (afterwards + total != before) revert UnexpectedOutflow(before - afterwards, total);
        emit BidPlaced(auction, bidId, seq, total);
    }

    /// @dev Every limit, checked and counted before anything moves.
    function _charge(address auction, uint256 escrow) internal returns (uint256 total) {
        Policy memory p = policy;
        if (msg.sender != p.operator) revert NotOperator();
        if (block.timestamp >= p.expiresAt) revert PolicyExpired();
        if (!approved(auction)) revert NotApproved(auction);
        if (bidsUsed >= p.maxBids) revert TooManyBids();
        // Bounds the sum below, so it cannot wrap: a bond is quote units the owner signed for.
        if (escrow > p.maxPerBid) revert OverPerBid(escrow);
        total = escrow + bondOf[auction];
        if (total > p.maxPerBid) revert OverPerBid(total);
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOn[day];
        if (spent + total > p.dailyLimit) revert OverDaily(spent, total);
        uint256 used = budgetUsed;
        if (used + total > p.budget) revert OverBudget(used, total);

        spentOn[day] = spent + total;
        // used + total <= p.budget, which is a uint128.
        // forge-lint: disable-next-line(unsafe-typecast)
        budgetUsed = uint128(used + total);
        ++bidsUsed;
    }

    // ------------------------------------------------------------------ views

    function approved(address auction) public view returns (bool) {
        return _approved[epoch][auction];
    }

    /// @notice The auctions the current policy approves.
    function approvedAuctions() external view returns (address[] memory) {
        return _auctions;
    }

    /// @notice When `sweepAfterExit` opens.
    function exitOpensAt() public view returns (uint256) {
        uint256 from = policy.expiresAt > createdAt ? policy.expiresAt : createdAt;
        return from + EXIT_DELAY;
    }

    /// @notice What is left under the policy now: today's spending, the budget and the bid count (0 once expired or revoked).
    function remaining() external view returns (uint256 today, uint256 budget, uint256 bids) {
        Policy memory p = policy;
        if (p.operator == address(0) || block.timestamp >= p.expiresAt) return (0, 0, 0);
        uint256 spent = spentOn[block.timestamp / 1 days];
        today = p.dailyLimit > spent ? p.dailyLimit - spent : 0;
        budget = p.budget - budgetUsed;
        bids = p.maxBids - bidsUsed;
    }
}
