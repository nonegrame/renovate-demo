module.exports = {
  platform: "github",

  repositories: [
    "nonegrame/renovate-demo"
  ],

  onboarding: false,
  requireConfig: "ignored",

  enabledManagers: ["dockerfile"],

  pinDigests: true,

  automerge: false,

  packageRules: [
    {
      matchDatasources: ["docker"],
      matchPackageNames: ["python"],
      matchCurrentValue: "/^3\\.14-slim-trixie$/",
      pinDigests: true
    }
  ]
};