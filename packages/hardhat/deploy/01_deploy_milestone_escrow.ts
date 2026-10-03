import { artifacts, deployScript } from "../rocketh/deploy.js";

export default deployScript(
  async ({ deploy, get, namedAccounts }) => {
    const { deployer } = namedAccounts;

    const mockUSDC = get("MockUSDC");

    await deploy("MilestoneEscrow", {
      account: deployer,
      artifact: artifacts.MilestoneEscrow,
      args: [mockUSDC.address],
    });
  },
  { tags: ["MilestoneEscrow"], dependencies: ["MockUSDC"] },
);
