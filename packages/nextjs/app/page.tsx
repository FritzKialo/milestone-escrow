"use client";

import { useState } from "react";
import Link from "next/link";
import { Address } from "@scaffold-ui/components";
import type { NextPage } from "next";
import { formatUnits, parseUnits } from "viem";
import { useAccount } from "wagmi";
import { useScaffoldReadContract, useScaffoldWriteContract, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

const roles = [
  {
    name: "Client",
    text: "Creates and funds the agreement. Approves work, disputes it, or reclaims money for missed deadlines.",
  },
  {
    name: "Freelancer",
    text: "Accepts the terms, submits each milestone and gets paid on approval or after the review period.",
  },
  {
    name: "Arbiter",
    text: "Named by the client and confirmed when the freelancer accepts. Splits a disputed milestone fairly.",
  },
];

const Home: NextPage = () => {
  const { address: connectedAddress } = useAccount();
  const { targetNetwork } = useTargetNetwork();
  const [minting, setMinting] = useState(false);

  const { data: balance, refetch } = useScaffoldReadContract({
    contractName: "MockUSDC",
    functionName: "balanceOf",
    args: [connectedAddress],
  });

  const { writeContractAsync } = useScaffoldWriteContract({ contractName: "MockUSDC" });

  const handleMint = async () => {
    if (!connectedAddress) return;
    setMinting(true);
    try {
      await writeContractAsync({
        functionName: "mint",
        args: [connectedAddress, parseUnits("1000", 6)],
      });
      await refetch();
      notification.success("Minted 1,000 test mUSDC");
    } catch (e) {
      console.error("Mint failed:", e);
    } finally {
      setMinting(false);
    }
  };

  return (
    <div className="flex items-center flex-col grow pt-10">
      <div className="px-5 max-w-3xl">
        <h1 className="text-center">
          <span className="block text-2xl mb-2">Trustless payments for freelance work</span>
          <span className="block text-4xl font-bold">Milestone Escrow</span>
        </h1>

        <p className="text-center text-lg mt-6">
          The client locks the full payment up front. The freelancer is paid one milestone at a time, when work is
          approved, when the review period runs out, or when an arbiter both sides accepted settles a dispute. Neither
          side has to trust the other.
        </p>

        <div className="flex justify-center items-center space-x-2 flex-col mt-6">
          <p className="my-2 font-medium">Connected Address:</p>
          <Address address={connectedAddress} chain={targetNetwork} />
        </div>

        <p className="text-center text-sm opacity-70 mt-2">
          Testnet only. This contract is unaudited and must not hold real money.
        </p>
      </div>

      <div className="grow bg-base-300 w-full mt-12 px-8 py-12">
        <div className="flex justify-center items-stretch gap-8 flex-col md:flex-row">
          {roles.map(role => (
            <div
              key={role.name}
              className="flex flex-col bg-base-100 border border-base-300 px-8 py-8 text-center items-center max-w-xs"
            >
              <h3 className="text-xl font-bold mb-2">{role.name}</h3>
              <p className="m-0">{role.text}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center gap-3 mt-12">
          <p className="m-0 font-medium">
            Your test mUSDC balance: {balance !== undefined ? formatUnits(balance, 6) : "..."}
          </p>
          <button className="btn btn-secondary" onClick={handleMint} disabled={!connectedAddress || minting}>
            {minting ? "Minting..." : "Get test mUSDC (1,000)"}
          </button>
          <div className="flex gap-4 mt-4">
            <Link href="/create" className="btn btn-primary">
              Create an agreement
            </Link>
            <Link href="/agreements" className="btn btn-outline">
              My agreements
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
