module.exports = {
  platform: "github",

  repositories: ["nonegrame/renovate-demo"],

  onboarding: false,
  requireConfig: "ignored",

  enabledManagers: ["dockerfile"],
  pinDigests: true,
  automerge: false,

  packageRules: [
    {
      // 只允許指定的 Image
      matchDatasources: ["docker"],
      matchPackageNames: [
        "!asia.gcr.io/verycoolproject-dcf97/python"
      ],
      enabled: false
    },
    {
      // 禁止版本 Tag 升級，但保留 Digest 更新
      matchDatasources: ["docker"],
      matchPackageNames: [
        "asia.gcr.io/verycoolproject-dcf97/python"
      ],
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