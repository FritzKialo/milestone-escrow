"use client";

import { useState } from "react";
import { hardhat } from "viem/chains";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { notification } from "~~/utils/scaffold-eth";

const RPC = "http://127.0.0.1:8545";

const rpc = async (method: string, params: unknown[]) => {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
};

const OPTIONS: [string, number][] = [
  ["+1 hour", 3600],
  ["+1 day", 86400],
  ["+3 days", 3 * 86400],
  ["+8 days", 8 * 86400],
];

// Local demo helper. Renders nothing on any network except Hardhat.
export const SkipTime = () => {
  const { targetNetwork } = useTargetNetwork();
  const [busy, setBusy] = useState(false);

  if (targetNetwork.id !== hardhat.id) return null;

  const skip = async (label: string, seconds: number) => {
    setBusy(true);
    try {
      await rpc("evm_increaseTime", [seconds]);
      await rpc("evm_mine", []);
      notification.success(`Local chain moved forward ${label.replace("+", "")}. Countdowns update in a few seconds.`);
    } catch (e) {
      console.error(e);
      notification.error("Could not move the local chain clock. Is yarn chain running?");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-dashed border-warning p-3 mb-4 flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">Local demo only: skip chain time</span>
      {OPTIONS.map(([label, secs]) => (
        <button key={label} className="btn btn-xs btn-warning" disabled={busy} onClick={() => skip(label, secs)}>
          {label}
        </button>
      ))}
      <span className="text-xs opacity-70">
        It moves every agreement on this chain and cannot be undone. Restart yarn chain to reset.
      </span>
    </div>
  );
};
