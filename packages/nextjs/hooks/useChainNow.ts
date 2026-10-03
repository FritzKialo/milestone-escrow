"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";

// Current time as the chain sees it (unix seconds), 0 until first read.
// Using chain time keeps countdowns correct after the local chain's clock is skipped forward.
export const useChainNow = () => {
  const client = usePublicClient();
  const [now, setNow] = useState(0);

  useEffect(() => {
    let offset = 0;
    let alive = true;

    const tick = () => {
      if (alive) setNow(Math.floor(Date.now() / 1000) + offset);
    };

    const sync = async () => {
      if (!client) return;
      try {
        let block;
        try {
          block = await client.getBlock({ blockTag: "pending" });
        } catch {
          block = await client.getBlock();
        }
        offset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
        tick();
      } catch {
        // keep the previous offset
      }
    };

    sync();
    tick();
    const a = setInterval(tick, 1000);
    const b = setInterval(sync, 5000);
    return () => {
      alive = false;
      clearInterval(a);
      clearInterval(b);
    };
  }, [client]);

  return now;
};
