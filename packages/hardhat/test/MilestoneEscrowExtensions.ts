import { network } from "hardhat";
import { expect } from "chai";

describe("Milestone Escrow extensions", function () {
  let ethers: any;

  const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
  const DAY = 24 * 60 * 60;
  const REVIEW = 2 * DAY;
  const TIMEOUT = 7 * DAY;

  const S = { Pending: 0, Submitted: 1, Disputed: 2, Released: 3, Refunded: 4, Resolved: 5 };
  const A = { Created: 0, Active: 1, Cancelled: 2, Completed: 3 };

  let usdc: any;
  let escrow: any;
  let escrowAddress: string;
  let client: any, freelancer: any, arbiter: any, outsider: any;

  before(async function () {
    const conn = await network.create();
    ethers = conn.ethers;
  });

  async function now() {
    const block = await ethers.provider.getBlock("latest");
    return Number(block.timestamp);
  }

  async function increase(seconds: number) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function setNextTimestamp(ts: number) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [ts]);
  }

  beforeEach(async function () {
    [, client, freelancer, arbiter, outsider] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockUSDC");
    usdc = await Token.deploy();
    const Escrow = await ethers.getContractFactory("MilestoneEscrow");
    escrow = await Escrow.deploy(await usdc.getAddress());
    escrowAddress = await escrow.getAddress();

    await usdc.mint(client.address, USDC(10_000));
    await usdc.connect(client).approve(escrowAddress, ethers.MaxUint256);
  });

  async function create(overrides: any = {}) {
    const t = await now();
    const p = {
      freelancer: freelancer.address,
      arbiter: arbiter.address,
      reviewPeriod: REVIEW,
      title: "Website build",
      descriptions: ["Design", "Build", "Launch"],
      amounts: [USDC(100), USDC(200), USDC(300)],
      deadlines: [t + 30 * DAY, t + 40 * DAY, t + 50 * DAY],
      ...overrides,
    };
    await escrow
      .connect(client)
      .createAgreement(p.freelancer, p.arbiter, p.reviewPeriod, p.title, p.descriptions, p.amounts, p.deadlines);
    return await escrow.agreementCount();
  }

  async function createActive(overrides: any = {}) {
    const id = await create(overrides);
    await escrow.connect(freelancer).acceptAgreement(id);
    return id;
  }

  async function createActiveSingle(amount: bigint) {
    const t = await now();
    return createActive({ descriptions: ["only"], amounts: [amount], deadlines: [t + 60 * DAY] });
  }

  async function disputeMilestone(id: bigint, index: number) {
    await escrow.connect(freelancer).submitMilestone(id, index, "work");
    await escrow.connect(client).disputeMilestone(id, index, "bad");
    return Number((await escrow.getMilestones(id))[index].disputedAt);
  }

  async function checkInvariant(ids: bigint[]) {
    let expected = 0n;
    for (const id of ids) {
      const a = await escrow.getAgreement(id);
      if (Number(a.status) === A.Cancelled) continue;
      for (const m of await escrow.getMilestones(id)) {
        const st = Number(m.status);
        if (st === S.Pending || st === S.Submitted || st === S.Disputed) expected += m.amount;
      }
    }
    expect(await usdc.balanceOf(escrowAddress)).to.equal(expected);
  }

  // ---------------------------------------------------------------- Decline
  describe("Decline", function () {
    it("only the freelancer can decline", async function () {
      const id = await create();
      for (const s of [client, arbiter, outsider]) {
        await expect(escrow.connect(s).declineAgreement(id)).to.be.revertedWithCustomError(escrow, "NotFreelancer");
      }
    });

    it("refunds the full total and cancels the agreement", async function () {
      const id = await create();
      await expect(escrow.connect(freelancer).declineAgreement(id))
        .to.emit(escrow, "AgreementDeclined")
        .withArgs(id, USDC(600));
      expect(await usdc.balanceOf(client.address)).to.equal(USDC(10_000));
      expect(await usdc.balanceOf(escrowAddress)).to.equal(0n);
      expect(Number((await escrow.getAgreement(id)).status)).to.equal(A.Cancelled);
    });

    it("reverts after acceptance", async function () {
      const id = await createActive();
      await expect(escrow.connect(freelancer).declineAgreement(id)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
    });

    it("a declined agreement cannot be accepted, cancelled, declined again or used", async function () {
      const id = await create();
      await escrow.connect(freelancer).declineAgreement(id);
      await expect(escrow.connect(freelancer).acceptAgreement(id)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
      await expect(escrow.connect(client).cancelAgreement(id)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
      await expect(escrow.connect(freelancer).declineAgreement(id)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
      await expect(escrow.connect(freelancer).submitMilestone(id, 0, "x")).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
    });

    it("the invariant holds when one of two agreements is declined", async function () {
      const a = await create();
      const b = await create();
      await checkInvariant([a, b]);
      await escrow.connect(freelancer).declineAgreement(a);
      await checkInvariant([a, b]);
      expect(await usdc.balanceOf(escrowAddress)).to.equal(USDC(600));
    });
  });

  // ---------------------------------------------------------- Arbiter timeout
  describe("Arbiter timeout", function () {
    it("records disputedAt as the dispute block timestamp", async function () {
      const id = await createActive();
      const d = await disputeMilestone(id, 0);
      const block = await ethers.provider.getBlock("latest");
      expect(d).to.equal(Number(block.timestamp));
    });

    it("reverts before and at the boundary, then splits 50/50 one second after, for anyone", async function () {
      const id = await createActive();
      const d = await disputeMilestone(id, 0);

      await setNextTimestamp(d + TIMEOUT - 1);
      await expect(escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "ArbiterTimeoutNotReached",
      );

      await setNextTimestamp(d + TIMEOUT);
      await expect(escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "ArbiterTimeoutNotReached",
      );

      const clientBefore = await usdc.balanceOf(client.address);
      await setNextTimestamp(d + TIMEOUT + 1);
      const tx = escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0);
      await expect(tx).to.emit(escrow, "DisputeResolved").withArgs(id, 0, USDC(50), USDC(50));
      await expect(tx).to.emit(escrow, "DisputeTimedOut").withArgs(id, 0);

      expect(await usdc.balanceOf(freelancer.address)).to.equal(USDC(50));
      expect((await usdc.balanceOf(client.address)) - clientBefore).to.equal(USDC(50));
      expect(Number((await escrow.getMilestones(id))[0].status)).to.equal(S.Resolved);
    });

    it("an odd amount leaves the extra unit with the client", async function () {
      const id = await createActiveSingle(101n);
      const d = await disputeMilestone(id, 0);
      const clientBefore = await usdc.balanceOf(client.address);
      await setNextTimestamp(d + TIMEOUT + 1);
      await escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0);
      expect(await usdc.balanceOf(freelancer.address)).to.equal(50n);
      expect((await usdc.balanceOf(client.address)) - clientBefore).to.equal(51n);
    });

    it("the arbiter can resolve at the boundary second but not one second later", async function () {
      const id = await createActive();
      const d0 = await disputeMilestone(id, 0);
      const d1 = await disputeMilestone(id, 1);

      await setNextTimestamp(d0 + TIMEOUT);
      await escrow.connect(arbiter).resolveDispute(id, 0, USDC(10));
      expect(Number((await escrow.getMilestones(id))[0].status)).to.equal(S.Resolved);

      await setNextTimestamp(d1 + TIMEOUT + 1);
      await expect(escrow.connect(arbiter).resolveDispute(id, 1, USDC(10))).to.be.revertedWithCustomError(
        escrow,
        "ArbiterTimeoutPassed",
      );

      await setNextTimestamp(d1 + TIMEOUT + 2);
      await escrow.connect(outsider).resolveDisputeAfterTimeout(id, 1);
      expect(Number((await escrow.getMilestones(id))[1].status)).to.equal(S.Resolved);
    });

    it("reverts when the milestone is not Disputed", async function () {
      const id = await createActive();
      await expect(escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await increase(TIMEOUT + 10);
      await expect(escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("cannot settle a milestone twice in any order", async function () {
      // Timeout first: both the timeout path and the arbiter path then revert
      const id = await createActive();
      const d0 = await disputeMilestone(id, 0);
      await setNextTimestamp(d0 + TIMEOUT + 1);
      await escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0);
      await expect(escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
      await expect(escrow.connect(arbiter).resolveDispute(id, 0, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );

      // Arbiter first, on a fresh dispute whose clock has not passed yet
      const id2 = await createActive();
      const e0 = await disputeMilestone(id2, 0);
      await setNextTimestamp(e0 + 5);
      await escrow.connect(arbiter).resolveDispute(id2, 0, USDC(100));
      await increase(TIMEOUT + 10);
      await expect(escrow.connect(outsider).resolveDisputeAfterTimeout(id2, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("completes the agreement when the timed-out milestone is the last one", async function () {
      const id = await createActiveSingle(USDC(100));
      const d = await disputeMilestone(id, 0);
      await setNextTimestamp(d + TIMEOUT + 1);
      await expect(escrow.connect(outsider).resolveDisputeAfterTimeout(id, 0))
        .to.emit(escrow, "AgreementCompleted")
        .withArgs(id);
      expect(Number((await escrow.getAgreement(id)).status)).to.equal(A.Completed);
      expect(await usdc.balanceOf(escrowAddress)).to.equal(0n);
    });

    it("the invariant holds across a timeout resolution", async function () {
      const a = await createActive();
      const b = await createActive();
      await checkInvariant([a, b]);
      const d = await disputeMilestone(a, 0);
      await checkInvariant([a, b]);
      await setNextTimestamp(d + TIMEOUT + 1);
      await escrow.connect(outsider).resolveDisputeAfterTimeout(a, 0);
      await checkInvariant([a, b]);
      expect(Number((await escrow.getMilestones(b))[0].status)).to.equal(S.Pending);
    });
  });
});
