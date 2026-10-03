/* eslint-disable @typescript-eslint/no-deprecated */
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { formatUnits, parseUnits } from "viem";
import { useAccount } from "wagmi";
import { SkipTime } from "~~/components/SkipTime";
import {
  useScaffoldEventHistory,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-eth";
import { useChainNow } from "~~/hooks/useChainNow";
import {
  AGREEMENT_STATUS,
  ARBITER_TIMEOUT,
  FROM_BLOCK,
  MILESTONE_BADGE,
  MILESTONE_STATUS,
  duration,
  explorerTxUrl,
  friendlyError,
  isSafeUrl,
} from "~~/utils/escrow";
import { notification } from "~~/utils/scaffold-eth";

// "12.5" -> 12500000n, or null when empty or not a valid number
const parseAmount = (value: string): bigint | null => {
  if (value.trim() === "") return null;
  try {
    return parseUnits(value.trim(), 6);
  } catch {
    return null;
  }
};

const ActivityLog = ({ id }: { id: bigint }) => {
  const base = { contractName: "MilestoneEscrow" as const, fromBlock: FROM_BLOCK, filters: { id }, watch: true };

  const accepted = useScaffoldEventHistory({ ...base, eventName: "AgreementAccepted" });
  const cancelled = useScaffoldEventHistory({ ...base, eventName: "AgreementCancelled" });
  const declined = useScaffoldEventHistory({ ...base, eventName: "AgreementDeclined" });
  const completed = useScaffoldEventHistory({ ...base, eventName: "AgreementCompleted" });
  const submitted = useScaffoldEventHistory({ ...base, eventName: "MilestoneSubmitted" });
  const released = useScaffoldEventHistory({ ...base, eventName: "MilestoneReleased" });
  const disputed = useScaffoldEventHistory({ ...base, eventName: "MilestoneDisputed" });
  const resolved = useScaffoldEventHistory({ ...base, eventName: "DisputeResolved" });
  const refunded = useScaffoldEventHistory({ ...base, eventName: "MilestoneRefunded" });

  type Entry = { block: number; log: number; text: string; note?: string };
  const entries: Entry[] = [];
  const push = (e: { blockNumber?: bigint | null; logIndex?: number | null }, text: string, note?: string) =>
    entries.push({ block: Number(e.blockNumber ?? 0), log: Number(e.logIndex ?? 0), text, note });

  accepted.data?.forEach(e => push(e, "Freelancer accepted the agreement"));
  cancelled.data?.forEach(e =>
    push(e, `Client cancelled and was refunded ${formatUnits(e.args.refunded ?? 0n, 6)} mUSDC`),
  );
  declined.data?.forEach(e =>
    push(e, `Freelancer declined. Client refunded ${formatUnits(e.args.refunded ?? 0n, 6)} mUSDC`),
  );
  completed.data?.forEach(e => push(e, "Agreement completed"));
  submitted.data?.forEach(e => push(e, `Milestone ${Number(e.args.index) + 1} submitted`, e.args.note || undefined));
  released.data?.forEach(e =>
    push(
      e,
      `Milestone ${Number(e.args.index) + 1} paid ${formatUnits(e.args.amount ?? 0n, 6)} mUSDC${
        e.args.byTimeout ? " (claimed after timeout)" : " (approved)"
      }`,
    ),
  );
  disputed.data?.forEach(e => push(e, `Milestone ${Number(e.args.index) + 1} disputed`, e.args.reason || undefined));
  resolved.data?.forEach(e =>
    push(
      e,
      `Milestone ${Number(e.args.index) + 1} resolved: ${formatUnits(e.args.toFreelancer ?? 0n, 6)} to freelancer, ${formatUnits(
        e.args.toClient ?? 0n,
        6,
      )} to client`,
    ),
  );
  refunded.data?.forEach(e =>
    push(e, `Milestone ${Number(e.args.index) + 1} refunded ${formatUnits(e.args.amount ?? 0n, 6)} mUSDC to client`),
  );

  entries.sort((a, b) => b.block - a.block || b.log - a.log);

  return (
    <div className="bg-base-100 border border-base-300 p-6 mt-6">
      <h2 className="text-xl font-bold mt-0">Activity log</h2>
      {entries.length === 0 ? (
        <p className="opacity-70 m-0">Nothing has happened yet.</p>
      ) : (
        <ul className="m-0 pl-5">
          {entries.map((e, i) => (
            <li key={i}>
              {e.text}
              {e.note && (
                <>
                  :{" "}
                  {isSafeUrl(e.note) ? (
                    <a href={e.note} target="_blank" rel="noopener noreferrer" className="link break-all">
                      {e.note}
                    </a>
                  ) : (
                    <span className="break-all">{e.note}</span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const AgreementDetail: NextPage = () => {
  const params = useParams<{ id: string }>();
  const idStr = params?.id ?? "0";
  const id = BigInt(/^\d+$/.test(idStr) ? idStr : "0");

  const { address } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const me = (address ?? "").toLowerCase();

  // Chain time, 0 until it has been read
  const now = useChainNow();
  const ready = now > 0;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [splits, setSplits] = useState<Record<number, string>>({});

  const { data: agreement, refetch: refetchAgreement } = useScaffoldReadContract({
    contractName: "MilestoneEscrow",
    functionName: "getAgreement",
    args: [id],
  });
  const { data: milestones, refetch: refetchMilestones } = useScaffoldReadContract({
    contractName: "MilestoneEscrow",
    functionName: "getMilestones",
    args: [id],
  });
  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "MilestoneEscrow" });

  const exists = agreement && agreement.client !== "0x0000000000000000000000000000000000000000";
  const isClient = !!agreement && agreement.client.toLowerCase() === me;
  const isFreelancer = !!agreement && agreement.freelancer.toLowerCase() === me;
  const isArbiter = !!agreement && agreement.arbiter.toLowerCase() === me;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await Promise.all([refetchAgreement(), refetchMilestones()]);
    } catch (e) {
      console.error(e);
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  if (id === 0n) return <p className="text-center pt-10">Invalid agreement id.</p>;
  if (!agreement || !milestones) return <p className="text-center pt-10">Loading...</p>;
  if (!exists) return <p className="text-center pt-10">Agreement #{idStr} does not exist.</p>;

  const active = Number(agreement.status) === 1;
  const created = Number(agreement.status) === 0;
  const cancelled = Number(agreement.status) === 2;
  const reviewPeriod = Number(agreement.reviewPeriod);

  const locked = cancelled ? 0n : milestones.reduce((sum, m) => (Number(m.status) <= 2 ? sum + m.amount : sum), 0n);
  const settled = Number(agreement.settledCount);

  const statusLine = (m: (typeof milestones)[number]) => {
    const st = Number(m.status);
    const deadline = Number(m.deadline);
    const reviewEnds = Number(m.submittedAt) + reviewPeriod;
    const arbiterEnds = Number(m.disputedAt) + ARBITER_TIMEOUT;
    if (st === 0) {
      if (!active) return "Waiting for the freelancer to accept the agreement.";
      return now > deadline
        ? `Deadline passed ${duration(now - deadline)} ago. The freelancer can still submit until the client refunds.`
        : `Freelancer has ${duration(deadline - now)} left to submit.`;
    }
    if (st === 1)
      return now <= reviewEnds
        ? `Client has ${duration(reviewEnds - now)} left to review.`
        : "Review period over. The freelancer can claim payment, or the client can still approve.";
    if (st === 2)
      return now <= arbiterEnds
        ? `In dispute. The arbiter has ${duration(arbiterEnds - now)} left. After that, anyone can split it 50/50.`
        : "The arbiter did not respond in time. Anyone can now split this milestone 50/50.";
    if (st === 3) return "Paid to the freelancer.";
    if (st === 4) return "Returned to the client.";
    return "Settled.";
  };

  const tx = (functionName: string, args: unknown[], ok: string) =>
    run(async () => {
      const hash = (await writeContractAsync({ functionName, args } as any)) as string | undefined;
      const url = explorerTxUrl(targetNetwork.id, hash);
      notification.success(
        url ? (
          <span>
            {ok}{" "}
            <a href={url} target="_blank" rel="noopener noreferrer" className="link">
              View on Etherscan
            </a>
          </span>
        ) : (
          ok
        ),
      );
    });

  return (
    <div className="flex items-center flex-col grow pt-10 pb-10">
      <div className="px-5 w-full max-w-4xl">
        <SkipTime />

        <h1 className="text-center text-4xl font-bold mb-1">{agreement.title}</h1>
        <p className="text-center opacity-70 mt-0">
          Agreement #{idStr} · {AGREEMENT_STATUS[Number(agreement.status)]} · Total{" "}
          {formatUnits(agreement.totalAmount, 6)} mUSDC · Review period {duration(reviewPeriod)}
        </p>

        <div className="mb-4">
          <progress
            className="progress progress-primary w-full"
            value={settled}
            max={milestones.length || 1}
          ></progress>
          <div className="flex justify-between text-sm opacity-80">
            <span>
              {settled} of {milestones.length} milestones settled
            </span>
            <span>{formatUnits(locked, 6)} mUSDC still locked in escrow</span>
          </div>
        </div>

        {error && (
          <div role="alert" className="alert alert-error mb-4">
            <span>{error}</span>
          </div>
        )}
        {busy && (
          <p className="text-sm opacity-70 mt-0">Waiting for your wallet and for the transaction to be mined...</p>
        )}

        <div className="bg-base-100 border border-base-300 p-6 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="w-24 font-medium">Client</span>
            <Address address={agreement.client} />
            {isClient && <span className="badge badge-primary">You</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 font-medium">Freelancer</span>
            <Address address={agreement.freelancer} />
            {isFreelancer && <span className="badge badge-primary">You</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 font-medium">Arbiter</span>
            <Address address={agreement.arbiter} />
            {isArbiter && <span className="badge badge-primary">You</span>}
          </div>
          {address && !isClient && !isFreelancer && !isArbiter && (
            <p className="m-0 text-sm opacity-70">Your address has no role here, so you can only view this page.</p>
          )}

          {created && isFreelancer && (
            <div className="flex gap-2 mt-2">
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => tx("acceptAgreement", [id], "Agreement accepted")}
              >
                Accept agreement
              </button>
              <button
                className="btn btn-outline"
                disabled={busy}
                onClick={() => tx("declineAgreement", [id], "Agreement declined. The client was refunded.")}
              >
                Decline and refund client
              </button>
            </div>
          )}
          {created && isClient && (
            <button
              className="btn btn-outline mt-2 self-start"
              disabled={busy}
              onClick={() => tx("cancelAgreement", [id], "Cancelled and refunded")}
            >
              Cancel and refund
            </button>
          )}
        </div>

        <h2 className="text-2xl font-bold mt-8">Milestones</h2>
        <div className="flex flex-col gap-4">
          {milestones.map((m, i) => {
            const st = Number(m.status);
            const reviewEnds = Number(m.submittedAt) + reviewPeriod;
            const reviewRunning = ready && st === 1 && now <= reviewEnds;
            const reviewOver = ready && st === 1 && now > reviewEnds;
            const deadlinePassed = ready && now > Number(m.deadline);
            const arbiterTimedOut = ready && st === 2 && now > Number(m.disputedAt) + ARBITER_TIMEOUT;

            const noteOrReason = notes[i] ?? "";
            const split = splits[i] ?? "";
            const parsedSplit = parseAmount(split);
            const splitUnits = parsedSplit ?? 0n;
            const splitNotNumber = split.trim() !== "" && parsedSplit === null;
            const splitTooBig = splitUnits > m.amount;

            return (
              <div key={i} className="bg-base-100 border border-base-300 p-5 flex flex-col gap-2">
                <div className="flex justify-between items-center flex-wrap gap-2">
                  <span className="font-bold">
                    {i + 1}. {m.description}
                  </span>
                  <span className="flex items-center gap-3">
                    <span>{formatUnits(m.amount, 6)} mUSDC</span>
                    <span className={`badge ${MILESTONE_BADGE[st]}`}>{MILESTONE_STATUS[st]}</span>
                  </span>
                </div>
                {ready && <p className="m-0 text-sm opacity-80">{statusLine(m)}</p>}

                {/* Freelancer: submit */}
                {isFreelancer && active && st === 0 && (
                  <div className="flex gap-2 flex-wrap">
                    <input
                      className="input input-bordered grow"
                      placeholder="Link to the work (https://...)"
                      value={noteOrReason}
                      onChange={e => setNotes({ ...notes, [i]: e.target.value })}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => tx("submitMilestone", [id, BigInt(i), noteOrReason.trim()], "Milestone submitted")}
                    >
                      Submit
                    </button>
                  </div>
                )}

                {/* Client: approve / dispute */}
                {isClient && st === 1 && (
                  <div className="flex gap-2 flex-wrap">
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => tx("approveMilestone", [id, BigInt(i)], "Milestone approved and paid")}
                    >
                      Approve
                    </button>
                    {reviewRunning && (
                      <>
                        <input
                          className="input input-bordered grow"
                          placeholder="Reason for the dispute"
                          value={noteOrReason}
                          onChange={e => setNotes({ ...notes, [i]: e.target.value })}
                        />
                        <button
                          className="btn btn-error"
                          disabled={busy || noteOrReason.trim() === ""}
                          onClick={() =>
                            tx("disputeMilestone", [id, BigInt(i), noteOrReason.trim()], "Milestone disputed")
                          }
                        >
                          Dispute
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* Freelancer: claim after timeout */}
                {isFreelancer && reviewOver && (
                  <button
                    className="btn btn-secondary self-start"
                    disabled={busy}
                    onClick={() => tx("claimAfterTimeout", [id, BigInt(i)], "Payment claimed")}
                  >
                    Claim payment
                  </button>
                )}

                {/* Client: refund after missed deadline */}
                {isClient && active && st === 0 && deadlinePassed && (
                  <button
                    className="btn btn-outline self-start"
                    disabled={busy}
                    onClick={() => tx("refundMilestone", [id, BigInt(i)], "Milestone refunded")}
                  >
                    Refund milestone
                  </button>
                )}

                {/* Arbiter: resolve (only while the arbiter's 7 days are running) */}
                {isArbiter && st === 2 && ready && !arbiterTimedOut && (
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-2 items-center flex-wrap">
                      <input
                        className="input input-bordered"
                        inputMode="decimal"
                        placeholder="Freelancer's share (mUSDC)"
                        value={split}
                        onChange={e => setSplits({ ...splits, [i]: e.target.value })}
                      />
                      <span className="text-sm">
                        Client&apos;s share:{" "}
                        {parsedSplit === null || splitTooBig ? "n/a" : formatUnits(m.amount - splitUnits, 6)} mUSDC
                      </span>
                      <button
                        className="btn btn-primary"
                        disabled={busy || parsedSplit === null || splitTooBig}
                        onClick={() => tx("resolveDispute", [id, BigInt(i), splitUnits], "Dispute resolved")}
                      >
                        Resolve
                      </button>
                    </div>
                    {splitNotNumber && (
                      <span className="text-error text-sm">Enter a number, for example 30 or 12.5.</span>
                    )}
                    {splitTooBig && (
                      <span className="text-error text-sm">The share cannot exceed {formatUnits(m.amount, 6)}.</span>
                    )}
                  </div>
                )}

                {/* Anyone connected: 50/50 split after the arbiter's timeout */}
                {address && arbiterTimedOut && (
                  <button
                    className="btn btn-warning self-start"
                    disabled={busy}
                    onClick={() => tx("resolveDisputeAfterTimeout", [id, BigInt(i)], "Split 50/50 and paid out")}
                  >
                    Split 50/50 (arbiter timed out)
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <ActivityLog id={id} />
      </div>
    </div>
  );
};

export default AgreementDetail;
