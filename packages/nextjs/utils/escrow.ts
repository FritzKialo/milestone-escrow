// First block to search for events. Use 0n locally.
// Before Sepolia, set this to the block your MilestoneEscrow was deployed in,
// otherwise the event search scans the whole chain and public RPCs will refuse it.
export const FROM_BLOCK = 0n;

export const AGREEMENT_STATUS = ["Created", "Active", "Cancelled", "Completed"];
export const MILESTONE_STATUS = ["Pending", "Submitted", "Disputed", "Released", "Refunded", "Resolved"];
export const MILESTONE_BADGE = [
  "badge-warning",
  "badge-info",
  "badge-error",
  "badge-success",
  "badge-neutral",
  "badge-secondary",
];

// Seconds -> "2 days 4 hours"
export const duration = (secs: number) => {
  const s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} day${d === 1 ? "" : "s"} ${h} hour${h === 1 ? "" : "s"}`;
  if (h > 0) return `${h} hour${h === 1 ? "" : "s"} ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} sec`;
};

// Only https links are shown as clickable. Everything else is plain text.
export const isSafeUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

// Contract custom error name -> plain-language message
const ERROR_MESSAGES: Record<string, string> = {
  NotClient: "Only the client of this agreement can do that.",
  NotFreelancer: "Only the freelancer of this agreement can do that.",
  NotArbiter: "Only the arbiter of this agreement can do that.",
  InvalidParties: "The client, freelancer and arbiter must be three different addresses.",
  InvalidMilestones: "The milestones are not valid. Check the amounts, deadlines and count.",
  InvalidReviewPeriod: "The review period must be between 1 hour and 30 days.",
  WrongAgreementStatus: "That is not possible at the agreement's current stage.",
  WrongMilestoneStatus: "That milestone has already moved on, or is not ready for this action. Refresh the page.",
  ReviewPeriodOver: "The review period is over, so this milestone can no longer be disputed.",
  ReviewPeriodNotOver: "The review period is still running, so the payment cannot be claimed yet.",
  DeadlineNotPassed: "The deadline for this milestone has not passed yet.",
  AmountExceedsMilestone: "The freelancer's share cannot be more than the milestone amount.",
  ERC20InsufficientAllowance: "The escrow is not yet allowed to move your mUSDC. Approve it first.",
  ERC20InsufficientBalance: "You do not have enough mUSDC.",
};

export const friendlyError = (e: unknown): string => {
  const parts: string[] = [];
  let cur: any = e;
  for (let depth = 0; cur && depth < 6; depth++) {
    parts.push(String(cur.message ?? ""), String(cur.shortMessage ?? ""), String(cur.data?.errorName ?? ""));
    cur = cur.cause;
  }
  const text = parts.join(" ");

  for (const [name, message] of Object.entries(ERROR_MESSAGES)) {
    if (text.includes(name)) return message;
  }
  if (/user rejected|denied transaction|rejected the request/i.test(text)) {
    return "You cancelled the request in your wallet.";
  }
  if (/insufficient funds/i.test(text)) {
    return "Your wallet does not have enough ETH to pay for gas.";
  }
  return "The transaction failed. Check the browser console for details.";
};
