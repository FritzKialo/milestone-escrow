/* eslint-disable @typescript-eslint/no-deprecated */
"use client";

import { useState } from "react";
import Link from "next/link";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { formatUnits } from "viem";
import { useAccount } from "wagmi";
import { useScaffoldEventHistory, useScaffoldReadContract } from "~~/hooks/scaffold-eth";

type Tab = "client" | "freelancer" | "arbiter";

const AGREEMENT_STATUS = ["Created", "Active", "Cancelled", "Completed"];

// Start of the event search. Use 0n locally; before Sepolia, set this to the deployment block.
const FROM_BLOCK = 0n;

const AgreementRow = ({
  id,
  client,
  freelancer,
  arbiter,
  total,
}: {
  id: bigint;
  client: string;
  freelancer: string;
  arbiter: string;
  total: bigint;
}) => {
  const { data: agreement } = useScaffoldReadContract({
    contractName: "MilestoneEscrow",
    functionName: "getAgreement",
    args: [id],
  });

  return (
    <tr>
      <td>#{id.toString()}</td>
      <td>{agreement?.title ?? "..."}</td>
      <td>{agreement ? AGREEMENT_STATUS[Number(agreement.status)] : "..."}</td>
      <td>{formatUnits(total, 6)} mUSDC</td>
      <td>
        <div className="flex flex-col gap-1">
          <Address address={client as `0x${string}`} />
          <Address address={freelancer as `0x${string}`} />
          <Address address={arbiter as `0x${string}`} />
        </div>
      </td>
      <td>
        <Link href={`/agreements/${id.toString()}`} className="btn btn-sm btn-primary">
          Open
        </Link>
      </td>
    </tr>
  );
};

const Agreements: NextPage = () => {
  const { address } = useAccount();
  const [tab, setTab] = useState<Tab>("client");
  const me = address as `0x${string}`;

  const asClient = useScaffoldEventHistory({
    contractName: "MilestoneEscrow",
    eventName: "AgreementCreated",
    fromBlock: FROM_BLOCK,
    filters: { client: me },
    watch: true,
    enabled: !!address,
  });
  const asFreelancer = useScaffoldEventHistory({
    contractName: "MilestoneEscrow",
    eventName: "AgreementCreated",
    fromBlock: FROM_BLOCK,
    filters: { freelancer: me },
    watch: true,
    enabled: !!address,
  });
  const asArbiter = useScaffoldEventHistory({
    contractName: "MilestoneEscrow",
    eventName: "AgreementCreated",
    fromBlock: FROM_BLOCK,
    filters: { arbiter: me },
    watch: true,
    enabled: !!address,
  });

  const current = tab === "client" ? asClient : tab === "freelancer" ? asFreelancer : asArbiter;
  const events = current.data ?? [];

  return (
    <div className="flex items-center flex-col grow pt-10 pb-10">
      <div className="px-5 w-full max-w-5xl">
        <h1 className="text-center text-4xl font-bold mb-6">My agreements</h1>

        {!address ? (
          <p className="text-center">Connect your wallet to see your agreements.</p>
        ) : (
          <>
            <div role="tablist" className="tabs tabs-boxed justify-center mb-6">
              {(["client", "freelancer", "arbiter"] as Tab[]).map(t => (
                <button key={t} role="tab" className={`tab ${tab === t ? "tab-active" : ""}`} onClick={() => setTab(t)}>
                  As {t}
                </button>
              ))}
            </div>

            {current.isLoading ? (
              <div className="flex justify-center">
                <span className="loading loading-spinner loading-lg"></span>
              </div>
            ) : events.length === 0 ? (
              <p className="text-center opacity-70">No agreements where you are the {tab}.</p>
            ) : (
              <div className="overflow-x-auto shadow-lg">
                <table className="table table-zebra w-full">
                  <thead>
                    <tr>
                      <th className="bg-primary">ID</th>
                      <th className="bg-primary">Title</th>
                      <th className="bg-primary">Status</th>
                      <th className="bg-primary">Total</th>
                      <th className="bg-primary">Client / Freelancer / Arbiter</th>
                      <th className="bg-primary"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map(e => (
                      <AgreementRow
                        key={`${e.blockNumber}-${e.logIndex}`}
                        id={e.args.id as bigint}
                        client={e.args.client as string}
                        freelancer={e.args.freelancer as string}
                        arbiter={e.args.arbiter as string}
                        total={e.args.totalAmount as bigint}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default Agreements;
