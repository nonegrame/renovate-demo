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

      // 禁止升級版本或更換 Tag
      matchUpdateTypes: [
        "major",
        "minor",
        "patch",
        "replacement"
      ],
      enabled: false
    }
  ]
};