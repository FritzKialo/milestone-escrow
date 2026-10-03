// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MilestoneEscrow
/// @notice Holds a client's payment and releases it to a freelancer one milestone at a time.
/// @dev Unaudited. Testnet use only. There is no owner, pause or rescue function.
contract MilestoneEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    ///////////////
    /// Errors ////
    ///////////////

    error NotClient();
    error NotFreelancer();
    error NotArbiter();
    error InvalidParties();
    error InvalidMilestones();
    error InvalidReviewPeriod();
    error WrongAgreementStatus();
    error WrongMilestoneStatus();
    error ReviewPeriodOver();
    error ReviewPeriodNotOver();
    error DeadlineNotPassed();
    error AmountExceedsMilestone();
    error ArbiterTimeoutNotReached();
    error ArbiterTimeoutPassed();

    ///////////////
    /// Types /////
    ///////////////

    enum AgreementStatus {
        Created,
        Active,
        Cancelled,
        Completed
    }

    enum MilestoneStatus {
        Pending,
        Submitted,
        Disputed,
        Released,
        Refunded,
        Resolved
    }

    struct Milestone {
        string description;
        uint256 amount; // in token units (6 decimals for MockUSDC)
        uint64 deadline; // freelancer should submit by this time
        uint64 submittedAt; // 0 until submitted
        uint64 disputedAt; // 0 until disputed
        MilestoneStatus status;
    }

    struct Agreement {
        address client;
        address freelancer;
        address arbiter;
        uint64 reviewPeriod; // seconds the client has to approve or dispute
        AgreementStatus status;
        uint256 totalAmount;
        uint256 settledCount; // milestones that reached a final state
        string title;
    }

    ///////////////
    /// State /////
    ///////////////

    IERC20 public immutable token;
    uint256 public agreementCount;

    mapping(uint256 => Agreement) private agreements;
    mapping(uint256 => Milestone[]) private milestones;

    uint256 public constant MAX_MILESTONES = 20;
    uint64 public constant MIN_REVIEW_PERIOD = 1 hours;
    uint64 public constant MAX_REVIEW_PERIOD = 30 days;
    /// @notice How long the arbiter has to resolve a dispute before anyone can trigger a 50/50 split.
    uint64 public constant ARBITER_TIMEOUT = 7 days;

    ///////////////
    /// Events ////
    ///////////////

    event AgreementCreated(
        uint256 id,
        address indexed client,
        address indexed freelancer,
        address indexed arbiter,
        uint256 totalAmount
    );
    event AgreementAccepted(uint256 indexed id);
    event AgreementCancelled(uint256 indexed id, uint256 refunded);
    event AgreementDeclined(uint256 indexed id, uint256 refunded);
    event AgreementCompleted(uint256 indexed id);
    event MilestoneSubmitted(uint256 indexed id, uint256 indexed index, string note);
    event MilestoneReleased(uint256 indexed id, uint256 indexed index, uint256 amount, bool byTimeout);
    event MilestoneDisputed(uint256 indexed id, uint256 indexed index, string reason);
    event DisputeResolved(uint256 indexed id, uint256 indexed index, uint256 toFreelancer, uint256 toClient);
    event DisputeTimedOut(uint256 indexed id, uint256 indexed index);
    event MilestoneRefunded(uint256 indexed id, uint256 indexed index, uint256 amount);

    constructor(IERC20 token_) {
        token = token_;
    }

    ///////////////////
    /// Create/accept /
    ///////////////////

    /// @notice Create and fund an agreement. The caller becomes the client.
    /// @dev Requires an ERC-20 allowance covering the total. Reverts on any invalid input.
    /// @param freelancer Address that will do the work
    /// @param arbiter Address that settles disputes
    /// @param reviewPeriod Seconds the client has to approve or dispute a submission
    /// @param title Human-readable agreement title
    /// @param descriptions One description per milestone
    /// @param amounts One amount per milestone, in token units
    /// @param deadlines One submission deadline per milestone (unix seconds)
    /// @return id The new agreement id
    function createAgreement(
        address freelancer,
        address arbiter,
        uint64 reviewPeriod,
        string calldata title,
        string[] calldata descriptions,
        uint256[] calldata amounts,
        uint64[] calldata deadlines
    ) external nonReentrant returns (uint256 id) {
        if (freelancer == address(0) || arbiter == address(0)) revert InvalidParties();
        if (msg.sender == freelancer || msg.sender == arbiter || freelancer == arbiter) revert InvalidParties();

        uint256 n = descriptions.length;
        if (n == 0 || n > MAX_MILESTONES || amounts.length != n || deadlines.length != n) {
            revert InvalidMilestones();
        }
        if (reviewPeriod < MIN_REVIEW_PERIOD || reviewPeriod > MAX_REVIEW_PERIOD) revert InvalidReviewPeriod();

        id = ++agreementCount;

        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            if (amounts[i] == 0 || deadlines[i] <= block.timestamp) revert InvalidMilestones();
            total += amounts[i];
            milestones[id].push(
                Milestone({
                    description: descriptions[i],
                    amount: amounts[i],
                    deadline: deadlines[i],
                    submittedAt: 0,
                    disputedAt: 0,
                    status: MilestoneStatus.Pending
                })
            );
        }

        agreements[id] = Agreement({
            client: msg.sender,
            freelancer: freelancer,
            arbiter: arbiter,
            reviewPeriod: reviewPeriod,
            status: AgreementStatus.Created,
            totalAmount: total,
            settledCount: 0,
            title: title
        });

        token.safeTransferFrom(msg.sender, address(this), total);

        emit AgreementCreated(id, msg.sender, freelancer, arbiter, total);
    }

    /// @notice Freelancer accepts the terms. The agreement becomes Active.
    /// @param id Agreement id
    function acceptAgreement(uint256 id) external {
        Agreement storage a = agreements[id];
        if (msg.sender != a.freelancer) revert NotFreelancer();
        if (a.status != AgreementStatus.Created) revert WrongAgreementStatus();

        a.status = AgreementStatus.Active;
        emit AgreementAccepted(id);
    }

    /// @notice Freelancer declines before accepting. The client is refunded in full.
    /// @param id Agreement id
    function declineAgreement(uint256 id) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.freelancer) revert NotFreelancer();
        if (a.status != AgreementStatus.Created) revert WrongAgreementStatus();

        a.status = AgreementStatus.Cancelled;
        uint256 refund = a.totalAmount;

        token.safeTransfer(a.client, refund);
        emit AgreementDeclined(id, refund);
    }

    /// @notice Client cancels before acceptance and gets the full total back.
    /// @param id Agreement id
    function cancelAgreement(uint256 id) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.client) revert NotClient();
        if (a.status != AgreementStatus.Created) revert WrongAgreementStatus();

        a.status = AgreementStatus.Cancelled;
        uint256 refund = a.totalAmount;

        token.safeTransfer(a.client, refund);
        emit AgreementCancelled(id, refund);
    }

    ///////////////////
    /// Milestones ////
    ///////////////////

    /// @notice Freelancer submits a milestone. Allowed after the deadline if not yet refunded.
    /// @param id Agreement id
    /// @param index Milestone index
    /// @param note Link or note about the work (emitted only, not stored)
    function submitMilestone(uint256 id, uint256 index, string calldata note) external {
        Agreement storage a = agreements[id];
        if (msg.sender != a.freelancer) revert NotFreelancer();
        if (a.status != AgreementStatus.Active) revert WrongAgreementStatus();

        Milestone storage m = milestones[id][index];
        if (m.status != MilestoneStatus.Pending) revert WrongMilestoneStatus();

        m.status = MilestoneStatus.Submitted;
        m.submittedAt = uint64(block.timestamp);

        emit MilestoneSubmitted(id, index, note);
    }

    /// @notice Client approves a submitted milestone and pays the freelancer.
    /// @param id Agreement id
    /// @param index Milestone index
    function approveMilestone(uint256 id, uint256 index) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.client) revert NotClient();

        Milestone storage m = milestones[id][index];
        if (m.status != MilestoneStatus.Submitted) revert WrongMilestoneStatus();

        _release(id, index, a, m, false);
    }

    /// @notice Freelancer claims payment once the review period has passed without a response.
    /// @param id Agreement id
    /// @param index Milestone index
    function claimAfterTimeout(uint256 id, uint256 index) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.freelancer) revert NotFreelancer();

        Milestone storage m = milestones[id][index];
        if (m.status != MilestoneStatus.Submitted) revert WrongMilestoneStatus();
        if (block.timestamp <= uint256(m.submittedAt) + a.reviewPeriod) revert ReviewPeriodNotOver();

        _release(id, index, a, m, true);
    }

    /// @notice Client disputes a submitted milestone while the review period is running.
    /// @param id Agreement id
    /// @param index Milestone index
    /// @param reason Why the work is disputed (emitted only, not stored)
    function disputeMilestone(uint256 id, uint256 index, string calldata reason) external {
        Agreement storage a = agreements[id];
        if (msg.sender != a.client) revert NotClient();

        Milestone storage m = milestones[id][index];
        if (m.status != MilestoneStatus.Submitted) revert WrongMilestoneStatus();
        if (block.timestamp > uint256(m.submittedAt) + a.reviewPeriod) revert ReviewPeriodOver();

        m.status = MilestoneStatus.Disputed;
        m.disputedAt = uint64(block.timestamp);
        emit MilestoneDisputed(id, index, reason);
    }

    /// @notice Arbiter splits a disputed milestone between the two sides.
    /// @dev Only possible while block.timestamp <= disputedAt + ARBITER_TIMEOUT. After that,
    ///      resolveDisputeAfterTimeout takes over, so the two paths never overlap.
    /// @param id Agreement id
    /// @param index Milestone index
    /// @param freelancerAmount Amount paid to the freelancer; the rest goes to the client
    function resolveDispute(uint256 id, uint256 index, uint256 freelancerAmount) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.arbiter) revert NotArbiter();

        Milestone storage m = milestones[id][index];
        if (m.status != MilestoneStatus.Disputed) revert WrongMilestoneStatus();
        if (block.timestamp > uint256(m.disputedAt) + ARBITER_TIMEOUT) revert ArbiterTimeoutPassed();
        if (freelancerAmount > m.amount) revert AmountExceedsMilestone();

        uint256 toClient = m.amount - freelancerAmount;

        // Effects before interactions
        m.status = MilestoneStatus.Resolved;
        _settle(id);

        if (freelancerAmount > 0) token.safeTransfer(a.freelancer, freelancerAmount);
        if (toClient > 0) token.safeTransfer(a.client, toClient);

        emit DisputeResolved(id, index, freelancerAmount, toClient);
    }

    /// @notice If the arbiter stays silent, anyone can split the disputed milestone 50/50.
    /// @dev Requires block.timestamp > disputedAt + ARBITER_TIMEOUT. An odd leftover unit goes to the client.
    /// @param id Agreement id
    /// @param index Milestone index
    function resolveDisputeAfterTimeout(uint256 id, uint256 index) external nonReentrant {
        Agreement storage a = agreements[id];
        Milestone storage m = milestones[id][index];
        if (m.status != MilestoneStatus.Disputed) revert WrongMilestoneStatus();
        if (block.timestamp <= uint256(m.disputedAt) + ARBITER_TIMEOUT) revert ArbiterTimeoutNotReached();

        uint256 toFreelancer = m.amount / 2;
        uint256 toClient = m.amount - toFreelancer;

        // Effects before interactions
        m.status = MilestoneStatus.Resolved;
        _settle(id);

        if (toFreelancer > 0) token.safeTransfer(a.freelancer, toFreelancer);
        if (toClient > 0) token.safeTransfer(a.client, toClient);

        emit DisputeResolved(id, index, toFreelancer, toClient);
        emit DisputeTimedOut(id, index);
    }

    /// @notice Client reclaims a milestone the freelancer never submitted by its deadline.
    /// @param id Agreement id
    /// @param index Milestone index
    function refundMilestone(uint256 id, uint256 index) external nonReentrant {
        Agreement storage a = agreements[id];
        if (msg.sender != a.client) revert NotClient();
        if (a.status != AgreementStatus.Active) revert WrongAgreementStatus();

        Milestone storage m = milestones[id][index];
        if (m.status != MilestoneStatus.Pending) revert WrongMilestoneStatus();
        if (block.timestamp <= m.deadline) revert DeadlineNotPassed();

        m.status = MilestoneStatus.Refunded;
        _settle(id);

        token.safeTransfer(a.client, m.amount);
        emit MilestoneRefunded(id, index, m.amount);
    }

    ///////////////
    /// Views /////
    ///////////////

    /// @notice Read an agreement.
    /// @param id Agreement id
    function getAgreement(uint256 id) external view returns (Agreement memory) {
        return agreements[id];
    }

    /// @notice Read all milestones of an agreement.
    /// @param id Agreement id
    function getMilestones(uint256 id) external view returns (Milestone[] memory) {
        return milestones[id];
    }

    ///////////////
    /// Internal //
    ///////////////

    function _release(uint256 id, uint256 index, Agreement storage a, Milestone storage m, bool byTimeout) private {
        m.status = MilestoneStatus.Released;
        _settle(id);

        token.safeTransfer(a.freelancer, m.amount);
        emit MilestoneReleased(id, index, m.amount, byTimeout);
    }

    function _settle(uint256 id) private {
        Agreement storage a = agreements[id];
        a.settledCount += 1;
        if (a.settledCount == milestones[id].length) {
            a.status = AgreementStatus.Completed;
            emit AgreementCompleted(id);
        }
    }
}