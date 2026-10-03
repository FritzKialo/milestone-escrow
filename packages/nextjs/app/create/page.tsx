"use client";

import { useState } from "react";
import { AddressInput } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { formatUnits, isAddress, parseUnits } from "viem";
import { useAccount } from "wagmi";
import {
  useDeployedContractInfo,
  useScaffoldReadContract,
  useScaffoldWriteContract,
  useTargetNetwork,
} from "~~/hooks/scaffold-eth";
import { explorerTxUrl } from "~~/utils/escrow";
import { notification } from "~~/utils/scaffold-eth";

const MAX_MILESTONES = 20;

type Row = { description: string; amount: string; days: string };

const emptyRow = (): Row => ({ description: "", amount: "", days: "7" });

const TEMPLATES: { name: string; split: number[] }[] = [
  { name: "Single payment", split: [100] },
  { name: "50 / 50", split: [50, 50] },
  { name: "30 / 40 / 30", split: [30, 40, 30] },
  { name: "4 x 25", split: [25, 25, 25, 25] },
];

// Parse a decimal string into 6-decimal token units, or 0n if it is not a valid number
const toUnits = (value: string): bigint => {
  try {
    return value.trim() === "" ? 0n : parseUnits(value, 6);
  } catch {
    return 0n;
  }
};

const Create: NextPage = () => {
  const { address: connectedAddress } = useAccount();
  const { targetNetwork } = useTargetNetwork();

  const [title, setTitle] = useState("");
  const [freelancer, setFreelancer] = useState("");
  const [arbiter, setArbiter] = useState("");
  const [reviewHours, setReviewHours] = useState("48");
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [templateTotal, setTemplateTotal] = useState("300");
  const [busy, setBusy] = useState<"" | "approve" | "create">("");

  const { data: escrowInfo } = useDeployedContractInfo({ contractName: "MilestoneEscrow" });
  const escrowAddress = escrowInfo?.address;

  const { data: allowance, refetch: refetchAllowance } = useScaffoldReadContract({
    contractName: "MockUSDC",
    functionName: "allowance",
    args: [connectedAddress, escrowAddress],
  });

  const { data: balance } = useScaffoldReadContract({
    contractName: "MockUSDC",
    functionName: "balanceOf",
    args: [connectedAddress],
  });

  const { writeContractAsync: writeToken } = useScaffoldWriteContract({ contractName: "MockUSDC" });
  const { writeContractAsync: writeEscrow } = useScaffoldWriteContract({ contractName: "MilestoneEscrow" });

  const total = rows.reduce((sum, r) => sum + toUnits(r.amount), 0n);
  const needsApproval = allowance !== undefined && allowance < total;

  const hours = Number(reviewHours);
  const lower = (a: string) => a.toLowerCase();

  // First problem found, shown under the form
  let problem = "";
  if (!connectedAddress) problem = "Connect your wallet.";
  else if (title.trim() === "") problem = "Enter a title.";
  else if (!isAddress(freelancer)) problem = "Enter a valid freelancer address.";
  else if (!isAddress(arbiter)) problem = "Enter a valid arbiter address.";
  else if (lower(freelancer) === lower(arbiter)) problem = "Freelancer and arbiter must be different.";
  else if (lower(freelancer) === lower(connectedAddress) || lower(arbiter) === lower(connectedAddress))
    problem = "You are the client, so use two other addresses for the freelancer and arbiter.";
  else if (!(hours >= 1 && hours <= 720)) problem = "Review period must be between 1 hour and 30 days (720 hours).";
  else if (rows.some(r => r.description.trim() === "")) problem = "Every milestone needs a description.";
  else if (rows.some(r => toUnits(r.amount) === 0n)) problem = "Every milestone needs an amount above zero.";
  else if (rows.some(r => !(Number(r.days) > 0))) problem = "Every deadline must be at least a fraction of a day away.";
  else if (balance !== undefined && balance < total)
    problem = "Your mUSDC balance is below the total. Use the faucet on Home.";

  const updateRow = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const applyTemplate = (split: number[]) => {
    const all = toUnits(templateTotal);
    if (all === 0n) {
      notification.error("Enter a template total above zero first.");
      return;
    }
    let used = 0n;
    setRows(
      split.map((pct, i) => {
        const amount = i === split.length - 1 ? all - used : (all * BigInt(pct)) / 100n;
        used += amount;
        return { description: `Milestone ${i + 1}`, amount: formatUnits(amount, 6), days: String(7 * (i + 1)) };
      }),
    );
  };

  const handleApprove = async () => {
    if (!escrowAddress) return;
    setBusy("approve");
    try {
      await writeToken({ functionName: "approve", args: [escrowAddress, total] });
      await refetchAllowance();
    } catch (e) {
      console.error("Approve failed:", e);
    } finally {
      setBusy("");
    }
  };

  const handleCreate = async () => {
    setBusy("create");
    try {
      const now = Math.floor(Date.now() / 1000);
      const hash = await writeEscrow({
        functionName: "createAgreement",
        args: [
          freelancer as `0x${string}`,
          arbiter as `0x${string}`,
          BigInt(Math.round(hours * 3600)),
          title.trim(),
          rows.map(r => r.description.trim()),
          rows.map(r => toUnits(r.amount)),
          rows.map(r => BigInt(now + Math.round(Number(r.days) * 86400))),
        ],
      });
      await refetchAllowance();
      const url = explorerTxUrl(targetNetwork.id, hash);
      notification.success(
        url ? (
          <span>
            Agreement created and funded.{" "}
            <a href={url} target="_blank" rel="noopener noreferrer" className="link">
              View on Etherscan
            </a>
          </span>
        ) : (
          "Agreement created and funded. Find it under My agreements."
        ),
      );
      setTitle("");
      setFreelancer("");
      setArbiter("");
      setRows([emptyRow()]);
    } catch (e) {
      console.error("Create failed:", e);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="flex items-center flex-col grow pt-10 pb-10">
      <div className="px-5 w-full max-w-3xl">
        <h1 className="text-center text-4xl font-bold mb-2">Create an agreement</h1>
        <p className="text-center opacity-70 mt-0">
          You become the client. The full total is locked in escrow when you create it.
        </p>

        <div className="flex flex-col gap-4 bg-base-100 border border-base-300 p-6">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Title</span>
            <input
              className="input input-bordered w-full"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Website build"
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="font-medium">Freelancer address</span>
            <AddressInput value={freelancer} onChange={v => setFreelancer(v)} placeholder="0x..." />
          </div>

          <div className="flex flex-col gap-1">
            <span className="font-medium">Arbiter address</span>
            <AddressInput value={arbiter} onChange={v => setArbiter(v)} placeholder="0x..." />
          </div>

          <label className="flex flex-col gap-1">
            <span className="font-medium">Review period (hours the client has to respond to a submission)</span>
            <input
              className="input input-bordered w-full"
              type="number"
              min="1"
              max="720"
              value={reviewHours}
              onChange={e => setReviewHours(e.target.value)}
            />
          </label>

          <h2 className="text-xl font-bold mt-2 mb-0">Milestones</h2>

          <div className="flex flex-wrap items-end gap-2 border border-base-300 p-3">
            <label className="flex flex-col gap-1">
              <span className="text-sm">Quick split of a total (mUSDC)</span>
              <input
                className="input input-bordered input-sm w-32"
                inputMode="decimal"
                value={templateTotal}
                onChange={e => setTemplateTotal(e.target.value)}
              />
            </label>
            {TEMPLATES.map(t => (
              <button
                key={t.name}
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => applyTemplate(t.split)}
              >
                {t.name}
              </button>
            ))}
          </div>

          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-end">
              <label className="col-span-12 md:col-span-5 flex flex-col gap-1">
                <span className="text-sm">Description</span>
                <input
                  className="input input-bordered w-full"
                  value={r.description}
                  onChange={e => updateRow(i, { description: e.target.value })}
                  placeholder={`Milestone ${i + 1}`}
                />
              </label>
              <label className="col-span-6 md:col-span-3 flex flex-col gap-1">
                <span className="text-sm">Amount (mUSDC)</span>
                <input
                  className="input input-bordered w-full"
                  inputMode="decimal"
                  value={r.amount}
                  onChange={e => updateRow(i, { amount: e.target.value })}
                  placeholder="100"
                />
              </label>
              <label className="col-span-6 md:col-span-3 flex flex-col gap-1">
                <span className="text-sm">Deadline (days from now)</span>
                <input
                  className="input input-bordered w-full"
                  type="number"
                  min="0.01"
                  step="any"
                  value={r.days}
                  onChange={e => updateRow(i, { days: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="col-span-12 md:col-span-1 btn btn-ghost"
                disabled={rows.length === 1}
                onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
                aria-label={`Remove milestone ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}

          <button
            type="button"
            className="btn btn-outline self-start"
            disabled={rows.length >= MAX_MILESTONES}
            onClick={() => setRows([...rows, emptyRow()])}
          >
            Add milestone ({rows.length}/{MAX_MILESTONES})
          </button>

          <div className="flex justify-between items-center border-t border-base-300 pt-4">
            <span className="font-medium">Total locked in escrow</span>
            <span className="text-xl font-bold">{formatUnits(total, 6)} mUSDC</span>
          </div>

          {problem && <p className="text-error m-0">{problem}</p>}

          <div className="flex gap-3">
            {needsApproval ? (
              <button
                className="btn btn-secondary grow"
                onClick={handleApprove}
                disabled={Boolean(problem) || busy !== ""}
              >
                {busy === "approve" ? "Approving..." : `Step 1 of 2: Approve ${formatUnits(total, 6)} mUSDC`}
              </button>
            ) : (
              <button
                className="btn btn-primary grow"
                onClick={handleCreate}
                disabled={Boolean(problem) || busy !== ""}
              >
                {busy === "create" ? "Creating..." : "Create and fund agreement"}
              </button>
            )}
          </div>
          <p className="text-sm opacity-70 m-0">
            The button switches to Create once the escrow is allowed to move your mUSDC.
          </p>
        </div>
      </div>
    </div>
  );
};

export default Create;
