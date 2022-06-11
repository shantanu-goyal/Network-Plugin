module.exports = {
  audits: [
    {
      path: "lighthouse-plugin-network/audits/network.js",
    },
  ],
  category: {
    title: "Network",
    description: "Logs all network request",
    auditRefs: [{ id: "third-party-summary", weight: 1 }],
  },
};
