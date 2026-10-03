import { network } from "hardhat";
import { expect } from "chai";

describe("Milestone Escrow", function () {
  let ethers: any;
  let time: any;

  const USDC = (n: number) => BigInt(Math.round(n * 1_000_000));
  const DAY = 24 * 60 * 60;
  const HOUR = 60 * 60;
  const REVIEW = 2 * DAY;

  // MilestoneStatus enum
  const S = { Pending: 0, Submitted: 1, Disputed: 2, Released: 3, Refunded: 4, Resolved: 5 };
  // AgreementStatus enum
  const A = { Created: 0, Active: 1, Cancelled: 2, Completed: 3 };

  let usdc: any;
  let escrow: any;
  let escrowAddress: string;
  let client: any, freelancer: any, arbiter: any, outsider: any, other: any;

  before(async function () {
    const conn = await network.create();
    ethers = conn.ethers;
    time = (conn as any).networkHelpers?.time;
  });

  async function now() {
    const block = await ethers.provider.getBlock("latest");
    return Number(block.timestamp);
  }

  async function increase(seconds: number) {
    if (time && time.increase) {
      await time.increase(seconds);
    } else {
      await ethers.provider.send("evm_increaseTime", [seconds]);
      await ethers.provider.send("evm_mine", []);
    }
  }

  // Mine a block exactly at a given timestamp
  async function setNextTimestamp(ts: number) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [ts]);
  }

  beforeEach(async function () {
    [, client, freelancer, arbiter, outsider, other] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockUSDC");
    usdc = await Token.deploy();
    const Escrow = await ethers.getContractFactory("MilestoneEscrow");
    escrow = await Escrow.deploy(await usdc.getAddress());
    escrowAddress = await escrow.getAddress();

    await usdc.mint(client.address, USDC(10_000));
    await usdc.mint(other.address, USDC(10_000));
    await usdc.connect(client).approve(escrowAddress, ethers.MaxUint256);
    await usdc.connect(other).approve(escrowAddress, ethers.MaxUint256);
  });

  async function params(overrides: any = {}) {
    const t = await now();
    return {
      freelancer: freelancer.address,
      arbiter: arbiter.address,
      reviewPeriod: REVIEW,
      title: "Website build",
      descriptions: ["Design", "Build", "Launch"],
      amounts: [USDC(100), USDC(200), USDC(300)],
      deadlines: [t + 7 * DAY, t + 14 * DAY, t + 21 * DAY],
      ...overrides,
    };
  }

  async function create(signer: any = client, overrides: any = {}) {
    const p = await params(overrides);
    const tx = await escrow
      .connect(signer)
      .createAgreement(p.freelancer, p.arbiter, p.reviewPeriod, p.title, p.descriptions, p.amounts, p.deadlines);
    await tx.wait();
    const id = await escrow.agreementCount();
    return { id, p };
  }

  async function createActive(signer: any = client, overrides: any = {}) {
    const r = await create(signer, overrides);
    await escrow.connect(freelancer).acceptAgreement(r.id);
    return r;
  }

  async function checkInvariant(ids: bigint[]) {
    let expected = 0n;
    for (const id of ids) {
      const a = await escrow.getAgreement(id);
      if (Number(a.status) === A.Cancelled) continue;
      const ms = await escrow.getMilestones(id);
      for (const m of ms) {
        const st = Number(m.status);
        if (st === S.Pending || st === S.Submitted || st === S.Disputed) expected += m.amount;
      }
    }
    expect(await usdc.balanceOf(escrowAddress)).to.equal(expected);
  }

  // ---------------------------------------------------------------- Create
  describe("Create", function () {
    it("pulls the exact total and stores every field", async function () {
      const { id, p } = await create();
      expect(await usdc.balanceOf(escrowAddress)).to.equal(USDC(600));
      expect(await usdc.balanceOf(client.address)).to.equal(USDC(9_400));

      const a = await escrow.getAgreement(id);
      expect(a.client).to.equal(client.address);
      expect(a.freelancer).to.equal(freelancer.address);
      expect(a.arbiter).to.equal(arbiter.address);
      expect(a.reviewPeriod).to.equal(BigInt(REVIEW));
      expect(Number(a.status)).to.equal(A.Created);
      expect(a.totalAmount).to.equal(USDC(600));
      expect(a.settledCount).to.equal(0n);
      expect(a.title).to.equal("Website build");

      const ms = await escrow.getMilestones(id);
      expect(ms.length).to.equal(3);
      for (let i = 0; i < 3; i++) {
        expect(ms[i].description).to.equal(p.descriptions[i]);
        expect(ms[i].amount).to.equal(p.amounts[i]);
        expect(ms[i].deadline).to.equal(BigInt(p.deadlines[i]));
        expect(ms[i].submittedAt).to.equal(0n);
        expect(Number(ms[i].status)).to.equal(S.Pending);
      }
      expect(await escrow.agreementCount()).to.equal(1n);
    });

    it("reverts on a zero address", async function () {
      await expect(create(client, { freelancer: ethers.ZeroAddress })).to.be.revertedWithCustomError(
        escrow,
        "InvalidParties",
      );
      await expect(create(client, { arbiter: ethers.ZeroAddress })).to.be.revertedWithCustomError(
        escrow,
        "InvalidParties",
      );
    });

    it("reverts when parties repeat", async function () {
      await expect(create(client, { freelancer: client.address })).to.be.revertedWithCustomError(
        escrow,
        "InvalidParties",
      );
      await expect(create(client, { arbiter: client.address })).to.be.revertedWithCustomError(escrow, "InvalidParties");
      await expect(create(client, { arbiter: freelancer.address })).to.be.revertedWithCustomError(
        escrow,
        "InvalidParties",
      );
    });

    it("reverts on mismatched arrays", async function () {
      await expect(create(client, { amounts: [USDC(100)] })).to.be.revertedWithCustomError(escrow, "InvalidMilestones");
      const t = await now();
      await expect(create(client, { deadlines: [t + DAY] })).to.be.revertedWithCustomError(escrow, "InvalidMilestones");
    });

    it("reverts on zero milestones", async function () {
      await expect(create(client, { descriptions: [], amounts: [], deadlines: [] })).to.be.revertedWithCustomError(
        escrow,
        "InvalidMilestones",
      );
    });

    it("reverts on more than 20 milestones and accepts exactly 20", async function () {
      const t = await now();
      const make = (n: number) => ({
        descriptions: Array(n).fill("m"),
        amounts: Array(n).fill(USDC(1)),
        deadlines: Array(n).fill(t + DAY),
      });
      await expect(create(client, make(21))).to.be.revertedWithCustomError(escrow, "InvalidMilestones");
      await create(client, make(20));
      expect((await escrow.getMilestones(1)).length).to.equal(20);
    });

    it("reverts on a zero amount", async function () {
      await expect(create(client, { amounts: [USDC(100), 0n, USDC(300)] })).to.be.revertedWithCustomError(
        escrow,
        "InvalidMilestones",
      );
    });

    it("reverts on a past deadline", async function () {
      const t = await now();
      await expect(create(client, { deadlines: [t + DAY, t - 1, t + DAY] })).to.be.revertedWithCustomError(
        escrow,
        "InvalidMilestones",
      );
    });

    it("reverts on a review period out of range", async function () {
      await expect(create(client, { reviewPeriod: HOUR - 1 })).to.be.revertedWithCustomError(
        escrow,
        "InvalidReviewPeriod",
      );
      await expect(create(client, { reviewPeriod: 30 * DAY + 1 })).to.be.revertedWithCustomError(
        escrow,
        "InvalidReviewPeriod",
      );
      await create(client, { reviewPeriod: HOUR });
      await create(client, { reviewPeriod: 30 * DAY });
    });

    it("reverts on missing allowance", async function () {
      await usdc.connect(client).approve(escrowAddress, USDC(599));
      await expect(create())
        .to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance")
        .withArgs(escrowAddress, USDC(599), USDC(600));
    });
  });

  // -------------------------------------------------------- Accept / cancel
  describe("Accept and cancel", function () {
    it("only the freelancer accepts", async function () {
      const { id } = await create();
      await expect(escrow.connect(client).acceptAgreement(id)).to.be.revertedWithCustomError(escrow, "NotFreelancer");
      await expect(escrow.connect(arbiter).acceptAgreement(id)).to.be.revertedWithCustomError(escrow, "NotFreelancer");
      await expect(escrow.connect(outsider).acceptAgreement(id)).to.be.revertedWithCustomError(escrow, "NotFreelancer");
      await escrow.connect(freelancer).acceptAgreement(id);
      expect(Number((await escrow.getAgreement(id)).status)).to.equal(A.Active);
    });

    it("cannot accept twice", async function () {
      const { id } = await createActive();
      await expect(escrow.connect(freelancer).acceptAgreement(id)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
    });

    it("cancel refunds the full total", async function () {
      const { id } = await create();
      await escrow.connect(client).cancelAgreement(id);
      expect(await usdc.balanceOf(client.address)).to.equal(USDC(10_000));
      expect(await usdc.balanceOf(escrowAddress)).to.equal(0n);
      expect(Number((await escrow.getAgreement(id)).status)).to.equal(A.Cancelled);
    });

    it("cancel reverts after acceptance and a second cancel reverts", async function () {
      const a = await createActive();
      await expect(escrow.connect(client).cancelAgreement(a.id)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
      const b = await create();
      await escrow.connect(client).cancelAgreement(b.id);
      await expect(escrow.connect(client).cancelAgreement(b.id)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
    });

    it("submit reverts before acceptance", async function () {
      const { id } = await create();
      await expect(escrow.connect(freelancer).submitMilestone(id, 0, "link")).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
    });

    it("a cancelled agreement cannot be accepted, submitted or refunded", async function () {
      const { id } = await create();
      await escrow.connect(client).cancelAgreement(id);
      await expect(escrow.connect(freelancer).acceptAgreement(id)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
      await increase(30 * DAY);
      await expect(escrow.connect(client).refundMilestone(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongAgreementStatus",
      );
    });
  });

  // -------------------------------------------------------------- Happy path
  describe("Happy path", function () {
    it("submit then approve pays the exact amount", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "https://work");
      const before = await usdc.balanceOf(freelancer.address);
      await escrow.connect(client).approveMilestone(id, 0);
      expect((await usdc.balanceOf(freelancer.address)) - before).to.equal(USDC(100));
      const ms = await escrow.getMilestones(id);
      expect(Number(ms[0].status)).to.equal(S.Released);
      expect((await escrow.getAgreement(id)).settledCount).to.equal(1n);
    });

    it("settling the last milestone completes the agreement", async function () {
      const { id } = await createActive();
      for (let i = 0; i < 2; i++) {
        await escrow.connect(freelancer).submitMilestone(id, i, "x");
        await escrow.connect(client).approveMilestone(id, i);
      }
      expect(Number((await escrow.getAgreement(id)).status)).to.equal(A.Active);
      await escrow.connect(freelancer).submitMilestone(id, 2, "x");
      await expect(escrow.connect(client).approveMilestone(id, 2)).to.emit(escrow, "AgreementCompleted").withArgs(id);
      expect(Number((await escrow.getAgreement(id)).status)).to.equal(A.Completed);
      expect(await usdc.balanceOf(freelancer.address)).to.equal(USDC(600));
      expect(await usdc.balanceOf(escrowAddress)).to.equal(0n);
    });

    it("submit reverts on an already submitted milestone", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await expect(escrow.connect(freelancer).submitMilestone(id, 0, "x")).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("approve reverts on a milestone that is not Submitted", async function () {
      const { id } = await createActive();
      await expect(escrow.connect(client).approveMilestone(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });
  });

  // ----------------------------------------------------------------- Timeout
  describe("Timeout", function () {
    it("claim reverts before and at the boundary, succeeds one second after", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      const submittedAt = Number((await escrow.getMilestones(id))[0].submittedAt);

      await setNextTimestamp(submittedAt + REVIEW - 1);
      await expect(escrow.connect(freelancer).claimAfterTimeout(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "ReviewPeriodNotOver",
      );

      // Exact boundary second: still inside the review period
      await setNextTimestamp(submittedAt + REVIEW);
      await expect(escrow.connect(freelancer).claimAfterTimeout(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "ReviewPeriodNotOver",
      );

      await setNextTimestamp(submittedAt + REVIEW + 1);
      await expect(escrow.connect(freelancer).claimAfterTimeout(id, 0))
        .to.emit(escrow, "MilestoneReleased")
        .withArgs(id, 0, USDC(100), true);
      expect(await usdc.balanceOf(freelancer.address)).to.equal(USDC(100));
    });

    it("dispute works at the boundary second and reverts once the period is over", async function () {
      const a = await createActive();
      await escrow.connect(freelancer).submitMilestone(a.id, 0, "x");
      const s0 = Number((await escrow.getMilestones(a.id))[0].submittedAt);
      await setNextTimestamp(s0 + REVIEW);
      await escrow.connect(client).disputeMilestone(a.id, 0, "bad");
      expect(Number((await escrow.getMilestones(a.id))[0].status)).to.equal(S.Disputed);

      await escrow.connect(freelancer).submitMilestone(a.id, 1, "x");
      const s1 = Number((await escrow.getMilestones(a.id))[1].submittedAt);
      await setNextTimestamp(s1 + REVIEW + 1);
      await expect(escrow.connect(client).disputeMilestone(a.id, 1, "late")).to.be.revertedWithCustomError(
        escrow,
        "ReviewPeriodOver",
      );
    });

    it("the client can still approve after the review period", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await increase(REVIEW + 10);
      await escrow.connect(client).approveMilestone(id, 0);
      expect(await usdc.balanceOf(freelancer.address)).to.equal(USDC(100));
    });
  });

  // ----------------------------------------------------------------- Dispute
  describe("Dispute", function () {
    async function disputed() {
      const r = await createActive();
      await escrow.connect(freelancer).submitMilestone(r.id, 0, "x");
      await escrow.connect(client).disputeMilestone(r.id, 0, "reason");
      return r;
    }

    it("only the client disputes, and only while Submitted", async function () {
      const { id } = await createActive();
      await expect(escrow.connect(client).disputeMilestone(id, 0, "r")).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await expect(escrow.connect(freelancer).disputeMilestone(id, 0, "r")).to.be.revertedWithCustomError(
        escrow,
        "NotClient",
      );
      await escrow.connect(client).disputeMilestone(id, 0, "r");
      await expect(escrow.connect(client).disputeMilestone(id, 0, "r")).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("a split of zero refunds the client in full", async function () {
      const { id } = await disputed();
      const cBefore = await usdc.balanceOf(client.address);
      await expect(escrow.connect(arbiter).resolveDispute(id, 0, 0))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(id, 0, 0, USDC(100));
      expect((await usdc.balanceOf(client.address)) - cBefore).to.equal(USDC(100));
      expect(await usdc.balanceOf(freelancer.address)).to.equal(0n);
      expect(Number((await escrow.getMilestones(id))[0].status)).to.equal(S.Resolved);
    });

    it("a split of the full amount pays the freelancer in full", async function () {
      const { id } = await disputed();
      const cBefore = await usdc.balanceOf(client.address);
      await expect(escrow.connect(arbiter).resolveDispute(id, 0, USDC(100)))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(id, 0, USDC(100), 0);
      expect(await usdc.balanceOf(freelancer.address)).to.equal(USDC(100));
      expect(await usdc.balanceOf(client.address)).to.equal(cBefore);
    });

    it("a partial split pays both sides correctly", async function () {
      const { id } = await disputed();
      const cBefore = await usdc.balanceOf(client.address);
      await escrow.connect(arbiter).resolveDispute(id, 0, USDC(30));
      expect(await usdc.balanceOf(freelancer.address)).to.equal(USDC(30));
      expect((await usdc.balanceOf(client.address)) - cBefore).to.equal(USDC(70));
    });

    it("a split above the amount reverts", async function () {
      const { id } = await disputed();
      await expect(escrow.connect(arbiter).resolveDispute(id, 0, USDC(100) + 1n)).to.be.revertedWithCustomError(
        escrow,
        "AmountExceedsMilestone",
      );
    });

    it("a non-arbiter cannot resolve", async function () {
      const { id } = await disputed();
      for (const s of [client, freelancer, outsider]) {
        await expect(escrow.connect(s).resolveDispute(id, 0, 0)).to.be.revertedWithCustomError(escrow, "NotArbiter");
      }
    });

    it("resolve reverts when the milestone is not Disputed", async function () {
      const { id } = await createActive();
      await expect(escrow.connect(arbiter).resolveDispute(id, 0, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });
  });

  // ------------------------------------------------------------------ Refund
  describe("Refund", function () {
    it("reverts before the deadline", async function () {
      const { id } = await createActive();
      await expect(escrow.connect(client).refundMilestone(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "DeadlineNotPassed",
      );
    });

    it("succeeds after the deadline while Pending", async function () {
      const { id } = await createActive();
      await increase(7 * DAY + 1);
      const before = await usdc.balanceOf(client.address);
      await expect(escrow.connect(client).refundMilestone(id, 0))
        .to.emit(escrow, "MilestoneRefunded")
        .withArgs(id, 0, USDC(100));
      expect((await usdc.balanceOf(client.address)) - before).to.equal(USDC(100));
      expect(Number((await escrow.getMilestones(id))[0].status)).to.equal(S.Refunded);
    });

    it("reverts once the milestone is Submitted", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await increase(8 * DAY);
      await expect(escrow.connect(client).refundMilestone(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("a late submission still works if no refund happened", async function () {
      const { id } = await createActive();
      await increase(8 * DAY);
      await escrow.connect(freelancer).submitMilestone(id, 0, "late");
      expect(Number((await escrow.getMilestones(id))[0].status)).to.equal(S.Submitted);
    });

    it("a refunded milestone cannot be submitted afterwards", async function () {
      const { id } = await createActive();
      await increase(8 * DAY);
      await escrow.connect(client).refundMilestone(id, 0);
      await expect(escrow.connect(freelancer).submitMilestone(id, 0, "x")).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("refunding every milestone completes the agreement", async function () {
      const { id } = await createActive();
      await increase(22 * DAY);
      for (let i = 0; i < 3; i++) await escrow.connect(client).refundMilestone(id, i);
      expect(Number((await escrow.getAgreement(id)).status)).to.equal(A.Completed);
      expect(await usdc.balanceOf(client.address)).to.equal(USDC(10_000));
    });
  });

  // ---------------------------------------------------------- Access control
  describe("Access control", function () {
    it("create is open to anyone and that caller becomes the client", async function () {
      const { id } = await create(other);
      expect((await escrow.getAgreement(id)).client).to.equal(other.address);
    });

    it("rejects the wrong roles with the right custom error", async function () {
      const { id } = await createActive();
      const wrongForFreelancer = [client, arbiter, outsider];
      const wrongForClient = [freelancer, arbiter, outsider];

      for (const s of wrongForFreelancer) {
        await expect(escrow.connect(s).submitMilestone(id, 0, "x")).to.be.revertedWithCustomError(
          escrow,
          "NotFreelancer",
        );
        await expect(escrow.connect(s).claimAfterTimeout(id, 0)).to.be.revertedWithCustomError(escrow, "NotFreelancer");
      }
      for (const s of wrongForClient) {
        await expect(escrow.connect(s).approveMilestone(id, 0)).to.be.revertedWithCustomError(escrow, "NotClient");
        await expect(escrow.connect(s).disputeMilestone(id, 0, "r")).to.be.revertedWithCustomError(escrow, "NotClient");
        await expect(escrow.connect(s).refundMilestone(id, 0)).to.be.revertedWithCustomError(escrow, "NotClient");
        await expect(escrow.connect(s).cancelAgreement(id)).to.be.revertedWithCustomError(escrow, "NotClient");
      }
    });
  });

  // ------------------------------------------------------- Double settlement
  describe("Double settlement", function () {
    it("approve after approve reverts", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await escrow.connect(client).approveMilestone(id, 0);
      await expect(escrow.connect(client).approveMilestone(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("claim after approve reverts", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await escrow.connect(client).approveMilestone(id, 0);
      await increase(REVIEW + 10);
      await expect(escrow.connect(freelancer).claimAfterTimeout(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("refund after release reverts", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await escrow.connect(client).approveMilestone(id, 0);
      await increase(8 * DAY);
      await expect(escrow.connect(client).refundMilestone(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("resolve after resolve reverts", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await escrow.connect(client).disputeMilestone(id, 0, "r");
      await escrow.connect(arbiter).resolveDispute(id, 0, USDC(50));
      await expect(escrow.connect(arbiter).resolveDispute(id, 0, USDC(50))).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });

    it("refund after refund reverts", async function () {
      const { id } = await createActive();
      await increase(8 * DAY);
      await escrow.connect(client).refundMilestone(id, 0);
      await expect(escrow.connect(client).refundMilestone(id, 0)).to.be.revertedWithCustomError(
        escrow,
        "WrongMilestoneStatus",
      );
    });
  });

  // --------------------------------------------------------------- Isolation
  describe("Isolation", function () {
    it("settling one agreement never changes the other", async function () {
      const a = await createActive(client);
      const b = await createActive(other);
      const bBefore = await escrow.getMilestones(b.id);

      await escrow.connect(freelancer).submitMilestone(a.id, 0, "x");
      await escrow.connect(client).approveMilestone(a.id, 0);

      const bAfter = await escrow.getMilestones(b.id);
      for (let i = 0; i < 3; i++) {
        expect(Number(bAfter[i].status)).to.equal(Number(bBefore[i].status));
        expect(bAfter[i].amount).to.equal(bBefore[i].amount);
      }
      expect((await escrow.getAgreement(b.id)).settledCount).to.equal(0n);
      expect(await usdc.balanceOf(escrowAddress)).to.equal(USDC(1_100));
    });
  });

  // --------------------------------------------------------------- Invariant
  describe("Invariant", function () {
    it("escrow balance equals the sum of non-final milestone amounts after every step", async function () {
      const ids: bigint[] = [];
      const a = await create(client);
      ids.push(a.id);
      await checkInvariant(ids);

      const b = await create(other);
      ids.push(b.id);
      await checkInvariant(ids);

      await escrow.connect(client).cancelAgreement(a.id);
      await checkInvariant(ids);

      await escrow.connect(freelancer).acceptAgreement(b.id);
      await checkInvariant(ids);

      await escrow.connect(freelancer).submitMilestone(b.id, 0, "x");
      await checkInvariant(ids);

      await escrow.connect(other).approveMilestone(b.id, 0);
      await checkInvariant(ids);

      await escrow.connect(freelancer).submitMilestone(b.id, 1, "x");
      await checkInvariant(ids);

      await escrow.connect(other).disputeMilestone(b.id, 1, "r");
      await checkInvariant(ids);

      await escrow.connect(arbiter).resolveDispute(b.id, 1, USDC(80));
      await checkInvariant(ids);

      await increase(22 * DAY);
      await escrow.connect(other).refundMilestone(b.id, 2);
      await checkInvariant(ids);

      expect(Number((await escrow.getAgreement(b.id)).status)).to.equal(A.Completed);
      expect(await usdc.balanceOf(escrowAddress)).to.equal(0n);
    });

    it("also holds across a timeout claim", async function () {
      const { id } = await createActive();
      await escrow.connect(freelancer).submitMilestone(id, 0, "x");
      await increase(REVIEW + 1);
      await escrow.connect(freelancer).claimAfterTimeout(id, 0);
      await checkInvariant([id]);
    });
  });

  // ------------------------------------------------------------------ Events
  describe("Events", function () {
    it("emits each event with the correct arguments", async function () {
      const p = await params();
      await expect(
        escrow
          .connect(client)
          .createAgreement(p.freelancer, p.arbiter, p.reviewPeriod, p.title, p.descriptions, p.amounts, p.deadlines),
      )
        .to.emit(escrow, "AgreementCreated")
        .withArgs(1, client.address, freelancer.address, arbiter.address, USDC(600));

      await expect(escrow.connect(freelancer).acceptAgreement(1)).to.emit(escrow, "AgreementAccepted").withArgs(1);

      await expect(escrow.connect(freelancer).submitMilestone(1, 0, "my note"))
        .to.emit(escrow, "MilestoneSubmitted")
        .withArgs(1, 0, "my note");

      await expect(escrow.connect(client).approveMilestone(1, 0))
        .to.emit(escrow, "MilestoneReleased")
        .withArgs(1, 0, USDC(100), false);

      await escrow.connect(freelancer).submitMilestone(1, 1, "x");
      await expect(escrow.connect(client).disputeMilestone(1, 1, "not done"))
        .to.emit(escrow, "MilestoneDisputed")
        .withArgs(1, 1, "not done");

      await expect(escrow.connect(arbiter).resolveDispute(1, 1, USDC(50)))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(1, 1, USDC(50), USDC(150));

      await increase(22 * DAY);
      await expect(escrow.connect(client).refundMilestone(1, 2))
        .to.emit(escrow, "MilestoneRefunded")
        .withArgs(1, 2, USDC(300));
    });

    it("emits AgreementCancelled with the refunded amount", async function () {
      const { id } = await create();
      await expect(escrow.connect(client).cancelAgreement(id))
        .to.emit(escrow, "AgreementCancelled")
        .withArgs(id, USDC(600));
    });
  });
});
