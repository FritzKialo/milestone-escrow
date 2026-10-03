import { artifacts, deployScript } from "../rocketh/deploy.js";

export default deployScript(
  async ({ deploy, namedAccounts }) => {
    const { deployer } = namedAccounts;

    await deploy("MockUSDC", {
      account: deployer,
      artifact: artifacts.MockUSDC,
      args: [],
    });
  },
  { tags: ["MockUSDC"] },
);
