/* eslint-disable @typescript-eslint/no-deprecated */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { formatUnits, parseUnits } from "viem";
import { useAccount } from "wagmi";
import { useScaffoldEventHistory, useScaffoldReadContract, useScaffoldWriteContract } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

const FROM_BLOCK = 0n;
const AGREEMENT_STATUS = ["Created", "Active", "Cancelled", "Completed"];
const MILESTONE_STATUS = ["Pending", "Submitted", "Disputed", "Released", "Refunded", "Resolved"];
const BADGE = ["badge-warning", "badge-info", "badge-error", "badge-success", "badge-neutral", "badge-secondary"];

// Seconds -> "2 days 4 hours"
const duration = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"} ${h} hour${h === 1 ? "" : "s"}`;
  if (h > 0) return `${h} hour${h === 1 ? "" : "s"} ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} sec`;
};

const ActivityLog = ({ id }: { id: bigint }) => {
  const base = { contractName: "MilestoneEscrow" as const, fromBlock: FROM_BLOCK, filters: { id }, watch: true };

  const accepted = useScaffoldEventHistory({ ...base, eventName: "AgreementAccepted" });
  const cancelled = useScaffoldEventHistory({ ...base, eventName: "AgreementCancelled" });
  const completed = useScaffoldEventHistory({ ...base, eventName: "AgreementCompleted" });
  const submitted = useScaffoldEventHistory({ ...base, eventName: "MilestoneSubmitted" });
  const released = useScaffoldEventHistory({ ...base, eventName: "MilestoneReleased" });
  const disputed = useScaffoldEventHistory({ ...base, eventName: "MilestoneDisputed" });
  const resolved = useScaffoldEventHistory({ ...base, eventName: "DisputeResolved" });
  const refunded = useScaffoldEventHistory({ ...base, eventName: "MilestoneRefunded" });

  type Entry = { block: number; log: number; text: string };
  const entries: Entry[] = [];
  const push = (e: { blockNumber?: bigint | null; logIndex?: number | null }, text: string) =>
    entries.push({ block: Number(e.blockNumber ?? 0), log: Number(e.logIndex ?? 0), text });

  accepted.data?.forEach(e => push(e, "Freelancer accepted the agreement"));
  cancelled.data?.forEach(e =>
    push(e, `Client cancelled and was refunded ${formatUnits(e.args.refunded ?? 0n, 6)} mUSDC`),
  );
  completed.data?.forEach(e => push(e, "Agreement completed"));
  submitted.data?.forEach(e =>
    push(e, `Milestone ${Number(e.args.index) + 1} submitted${e.args.note ? `: ${e.args.note}` : ""}`),
  );
  released.data?.forEach(e =>
    push(
      e,
      `Milestone ${Number(e.args.index) + 1} paid ${formatUnits(e.args.amount ?? 0n, 6)} mUSDC${
        e.args.byTimeout ? " (claimed after timeout)" : " (approved)"
      }`,
    ),
  );
  disputed.data?.forEach(e =>
    push(e, `Milestone ${Number(e.args.index) + 1} disputed${e.args.reason ? `: ${e.args.reason}` : ""}`),
  );
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
            <li key={i}>{e.text}</li>
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
  const me = (address ?? "").toLowerCase();

  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const [busy, setBusy] = useState(false);
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
    try {
      await fn();
      await Promise.all([refetchAgreement(), refetchMilestones()]);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (id === 0n) return <p className="text-center pt-10">Invalid agreement id.</p>;
  if (!agreement || !milestones) return <p className="text-center pt-10">Loading...</p>;
  if (!exists) return <p className="text-center pt-10">Agreement #{idStr} does not exist.</p>;

  const active = Number(agreement.status) === 1;
  const created = Number(agreement.status) === 0;
  const reviewPeriod = Number(agreement.reviewPeriod);

  const statusLine = (m: (typeof milestones)[number]) => {
    const st = Number(m.status);
    const deadline = Number(m.deadline);
    const reviewEnds = Number(m.submittedAt) + reviewPeriod;
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
    if (st === 2) return "In dispute. Waiting for the arbiter to split the amount.";
    if (st === 3) return "Paid to the freelancer.";
    if (st === 4) return "Returned to the client.";
    return "Settled by the arbiter.";
  };

  const tx = (functionName: string, args: unknown[], ok: string) =>
    run(async () => {
      await writeContractAsync({ functionName, args } as any);
      notification.success(ok);
    });

  return (
    <div className="flex items-center flex-col grow pt-10 pb-10">
      <div className="px-5 w-full max-w-4xl">
        <h1 className="text-center text-4xl font-bold mb-1">{agreement.title}</h1>
        <p className="text-center opacity-70 mt-0">
          Agreement #{idStr} · {AGREEMENT_STATUS[Number(agreement.status)]} · Total{" "}
          {formatUnits(agreement.totalAmount, 6)} mUSDC · Review period {duration(reviewPeriod)}
        </p>

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
            <p className="m-0 text-sm opacity-70">Your address has no role here, so this page is read-only.</p>
          )}

          {created && isFreelancer && (
            <button
              className="btn btn-primary mt-2 self-start"
              disabled={busy}
              onClick={() => tx("acceptAgreement", [id], "Agreement accepted")}
            >
              Accept agreement
            </button>
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
            const reviewRunning = st === 1 && now <= reviewEnds;
            const reviewOver = st === 1 && now > reviewEnds;
            const split = splits[i] ?? "";
            let splitUnits = 0n;
            try {
              splitUnits = split.trim() === "" ? 0n : parseUnits(split, 6);
            } catch {
              splitUnits = 0n;
            }
            const splitInvalid = splitUnits > m.amount;

            return (
              <div key={i} className="bg-base-100 border border-base-300 p-5 flex flex-col gap-2">
                <div className="flex justify-between items-center flex-wrap gap-2">
                  <span className="font-bold">
                    {i + 1}. {m.description}
                  </span>
                  <span className="flex items-center gap-3">
                    <span>{formatUnits(m.amount, 6)} mUSDC</span>
                    <span className={`badge ${BADGE[st]}`}>{MILESTONE_STATUS[st]}</span>
                  </span>
                </div>
                <p className="m-0 text-sm opacity-80">{statusLine(m)}</p>

                {/* Freelancer: submit */}
                {isFreelancer && active && st === 0 && (
                  <div className="flex gap-2 flex-wrap">
                    <input
                      className="input input-bordered grow"
                      placeholder="Link or note about the work"
                      value={notes[i] ?? ""}
                      onChange={e => setNotes({ ...notes, [i]: e.target.value })}
                    />
                    <button
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => tx("submitMilestone", [id, BigInt(i), notes[i] ?? ""], "Milestone submitted")}
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
                          value={notes[i] ?? ""}
                          onChange={e => setNotes({ ...notes, [i]: e.target.value })}
                        />
                        <button
                          className="btn btn-error"
                          disabled={busy}
                          onClick={() => tx("disputeMilestone", [id, BigInt(i), notes[i] ?? ""], "Milestone disputed")}
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
                {isClient && active && st === 0 && now > Number(m.deadline) && (
                  <button
                    className="btn btn-outline self-start"
                    disabled={busy}
                    onClick={() => tx("refundMilestone", [id, BigInt(i)], "Milestone refunded")}
                  >
                    Refund milestone
                  </button>
                )}

                {/* Arbiter: resolve */}
                {isArbiter && st === 2 && (
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
                        Client&apos;s share: {splitInvalid ? "n/a" : formatUnits(m.amount - splitUnits, 6)} mUSDC
                      </span>
                      <button
                        className="btn btn-primary"
                        disabled={busy || splitInvalid || split.trim() === ""}
                        onClick={() => tx("resolveDispute", [id, BigInt(i), splitUnits], "Dispute resolved")}
                      >
                        Resolve
                      </button>
                    </div>
                    {splitInvalid && (
                      <span className="text-error text-sm">The share cannot exceed {formatUnits(m.amount, 6)}.</span>
                    )}
                  </div>
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
