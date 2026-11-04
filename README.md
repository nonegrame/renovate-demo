# Renovate + GitHub Actions + Google Artifact Registry

使用 **GitHub Actions 自架 Renovate**，定期檢查 Google Artifact Registry 的 Docker Base Image。當**同一個 Tag** 指向新的 SHA256 Digest 時，Renovate 自動建立 Pull Request；不自動升級 Python 等 Runtime 的版本 Tag。

> 本文件是可重複部署的範本，**部署指令使用環境變數，不要求固定的 GCP Project ID、Project Number、GitHub 使用者名稱或 Repository 名稱**。文中的實際路徑僅用於說明目前環境；設定前請將環境變數換成你自己的值。

## 目標架構

```text
Artifact Registry
  └─ python:3.14 ──> sha256:BBB   (可移動的 Tag)
           │
           ▼
GitHub Actions（每日或手動觸發）
  ├─ OIDC → Google Workload Identity Federation → 短效 GCP Access Token
  └─ Renovate
       ├─ 解析指定 GitHub Repo 的 Dockerfile
       ├─ 查詢 Registry 的 Tag / Digest
       └─ Digest 不同 → 建立 PR
                 └─ 各專案測試 / 合併 / 重新 Build / Deploy
```

例如：

```diff
-FROM asia.gcr.io/<GCP_PROJECT_ID>/python:3.14@sha256:<OLD_DIGEST>
+FROM asia.gcr.io/<GCP_PROJECT_ID>/python:3.14@sha256:<NEW_DIGEST>
```

`3.14` 不變，僅更新 Digest。首次使用時可以先只寫 `:3.14`，讓 Renovate 建立 **Pin Digest PR**。

### Base Image 由誰更新？

**Renovate 只查詢 Registry、修改 Dockerfile 並建立 PR，不會建置 Base Image，也不會自動將上游 Python Image 同步到私人 Registry。** Base Image 必須由你或另一條 CI 發布：

```text
取得新版上游 Image / 自行建置 Base Image
  → 掃描與驗證
  → Push 到私人 Artifact Registry 的同一個 Tag
  → Renovate 偵測 Digest 改變
  → 建立 Dockerfile 更新 PR
```

以你目前的 `asia.gcr.io/verycoolproject-dcf97/python` 為例，這是 **Image 路徑**；如果 Dockerfile 追蹤 `:3.14`，發布時也必須推送到 `asia.gcr.io/verycoolproject-dcf97/python:3.14`。只推送 `:latest`、`:3.15` 或其他 Tag，不會改變 `:3.14` 的 Digest。

以第 1 節的環境變數表示，發布指令為（`<LOCAL_IMAGE_V2>` 請替換為已完成驗證的本機新版 Image）：

```bash
gcloud auth configure-docker "$REGISTRY_HOST"
docker tag <LOCAL_IMAGE_V2> "${BASE_IMAGE}:${BASE_TAG}"
docker push "${BASE_IMAGE}:${BASE_TAG}"
```

- 以上是**發布者**執行的指令，需要目標 Repository 的寫入權限，例如 `roles/artifactregistry.writer`；不要將寫入權限授予 Renovate 的唯讀 Service Account。
- 新 Image 的內容 / Manifest 必須不同，Digest 才會改變；重推完全相同的 Image 不會製造更新。
- 若未指定 Tag，Docker 預設使用 `latest`，不等於更新 `3.14`。
- 正式環境的 Tag 更新會影響所有追蹤者；第 7 節使用獨立測試 Image 驗收，避免為測試改動正式 Tag。

## 事前條件

- 已安裝並登入 Google Cloud CLI (`gcloud`)；執行帳號具備建立 Service Account、WIF 與 IAM 綁定所需權限。
- 已有可讀取的 Artifact Registry Docker Image；**Tag 必須能移動到新版 Digest**（若啟用 Immutable Tags，請改採版本 Tag 更新策略）。
- 一個 GitHub Repo 用來執行 Renovate；本 SOP 先處理該 Repo 自己的 Dockerfile。
- GitHub Repo 預設分支（例如 `main` 或 `master`）已確認。
- 如果使用 `asia.gcr.io` 等 `gcr.io` 網域，先確認它已由 **Artifact Registry** 承載，而非依賴舊 Container Registry 的權限模式。

## 1. 設定本機變數

在終端機依實際環境修改：

```bash
export GCP_PROJECT_ID="<YOUR_GCP_PROJECT_ID>"
export GITHUB_OWNER="<YOUR_GITHUB_OWNER_OR_ORG>" # 例如 nonegrame
export GITHUB_REPO="<YOUR_RENOVATE_RUNNER_REPO>" # 例如 renovate-demo
export GITHUB_BRANCH="<DEFAULT_BRANCH>"       # 例如 main / master

# Artifact Registry 的 Repository 資訊
# 使用 gcr.io 相容網域時的例子：
export AR_REPOSITORY="asia.gcr.io"
export AR_LOCATION="asia"
export REGISTRY_HOST="asia.gcr.io"
export BASE_IMAGE="${REGISTRY_HOST}/${GCP_PROJECT_ID}/python"
export BASE_TAG="3.14"

# 如使用標準 Artifact Registry 網域（*.pkg.dev），改成：
# export AR_REPOSITORY="<ARTIFACT_REGISTRY_REPOSITORY>"
# export AR_LOCATION="<REGION>"                # 例如 asia-east1
# export REGISTRY_HOST="${AR_LOCATION}-docker.pkg.dev"
# export BASE_IMAGE="${REGISTRY_HOST}/${GCP_PROJECT_ID}/${AR_REPOSITORY}/python"

export SA_NAME="renovate-reader"
export SA_EMAIL="${SA_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
export WIF_POOL_ID="github-renovate"
export WIF_PROVIDER_ID="github"

export PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
```

確認 Artifact Registry Repository 存在：

```bash
gcloud artifacts repositories describe "$AR_REPOSITORY" \
  --project="$GCP_PROJECT_ID" \
  --location="$AR_LOCATION"
```

> `asia.gcr.io` 的 Artifact Registry Repository 通常為 `asia.gcr.io`、location 為 `asia`；**不是** `asia-east1`。`*.pkg.dev` 則依其實際 Repository 與 Region 設定。

## 2. 啟用必要的 GCP API

```bash
gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  artifactregistry.googleapis.com \
  --project="$GCP_PROJECT_ID"
```

## 3. 建立唯讀 Service Account

```bash
gcloud iam service-accounts create "$SA_NAME" \
  --project="$GCP_PROJECT_ID" \
  --display-name="Renovate Registry Reader"
```

如果已建立，同名建立指令會失敗；此時直接沿用現有帳號。

只對**指定的 Artifact Registry Repository** 授予讀取權限：

```bash
gcloud artifacts repositories add-iam-policy-binding "$AR_REPOSITORY" \
  --project="$GCP_PROJECT_ID" \
  --location="$AR_LOCATION" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/artifactregistry.reader"
```

## 4. 建立 Workload Identity Federation（WIF）

這讓 GitHub Actions 以 OIDC 取得短效憑證，**不必保存 Service Account JSON Key**。

### 4.1 建立 Pool

```bash
gcloud iam workload-identity-pools create "$WIF_POOL_ID" \
  --project="$GCP_PROJECT_ID" \
  --location=global \
  --display-name="GitHub Renovate"
```

### 4.2 建立 GitHub OIDC Provider

只允許指定 GitHub Repo 的預設分支：

```bash
gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" \
  --project="$GCP_PROJECT_ID" \
  --location=global \
  --workload-identity-pool="$WIF_POOL_ID" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${GITHUB_OWNER}/${GITHUB_REPO}' && assertion.ref=='refs/heads/${GITHUB_BRANCH}'"
```

### 4.3 授權 GitHub 身分使用 Service Account

```bash
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$GCP_PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/attribute.repository/${GITHUB_OWNER}/${GITHUB_REPO}"
```

> IAM 授權與 OIDC Provider 條件是不同層次：前者允許指定 GitHub Repo 使用 Service Account；後者額外限制特定分支。建立後可能需要短暫時間傳播。

### 4.4 驗證

```bash
gcloud iam workload-identity-pools describe "$WIF_POOL_ID" \
  --project="$GCP_PROJECT_ID" --location=global \
  --format='value(state)'

gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" \
  --project="$GCP_PROJECT_ID" --location=global \
  --workload-identity-pool="$WIF_POOL_ID" \
  --format='value(state)'
```

兩者都應為 `ACTIVE`。

## 5. 設定 GitHub Repository Variables

在 Renovate Runner Repo 的 **Settings → Secrets and variables → Actions → Variables** 建立：

| Variable | 值 | 用途 |
|---|---|---|
| `GCP_WIF_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL_ID>/providers/<PROVIDER_ID>` | WIF Provider 完整資源名稱 |
| `GCP_SERVICE_ACCOUNT` | `renovate-reader@<GCP_PROJECT_ID>.iam.gserviceaccount.com` | GCP Service Account Email |
| `REGISTRY_HOST` | 例如 `asia.gcr.io`、`asia-east1-docker.pkg.dev` | Renovate 的 Docker Registry 認證 Host |
| `BASE_IMAGE` | 例如 `asia.gcr.io/<GCP_PROJECT_ID>/python` | Renovate 只追蹤的 Image，不包含 Tag / Digest |

直接輸出前兩個值以便複製：

```bash
echo "GCP_WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL_ID}/providers/${WIF_PROVIDER_ID}"
echo "GCP_SERVICE_ACCOUNT=${SA_EMAIL}"
echo "REGISTRY_HOST=${REGISTRY_HOST}"
echo "BASE_IMAGE=${BASE_IMAGE}"
```

這些是**資源識別值**，可放 Repository Variables。`GITHUB_TOKEN` 是 GitHub Actions 內建 Token，不必自行建立 Secret。

同時確認 **Settings → Actions → General → Workflow permissions** 允許 workflow 寫入、建立 Pull Request；若受到 Organization 政策限制，需要請管理員協助。

## 6. Repository 檔案

```text
renovate-runner/
├── Dockerfile
├── renovate-config.js
└── .github/
    └── workflows/
        └── renovate.yml
```

### 6.1 `Dockerfile`

用**實際 Image 路徑**替換範例中的佔位符：

```dockerfile
FROM asia.gcr.io/<GCP_PROJECT_ID>/python:3.14

WORKDIR /app
CMD ["python", "--version"]
```

第一次先不填 Digest，測試 Renovate 是否會自動建立 pinning PR；合併後會變成 `FROM ...:3.14@sha256:<DIGEST>`。

### 6.2 `renovate-config.js`

用環境變數從 GitHub Actions 傳入目標 Repo 與 Image，**不把 Project ID 或 Repo 寫死在設定檔中**。

```javascript
const repository = process.env.RENOVATE_TARGET_REPO;
const image = process.env.RENOVATE_BASE_IMAGE;

if (!repository || !image) {
  throw new Error("Missing RENOVATE_TARGET_REPO or RENOVATE_BASE_IMAGE");
}

module.exports = {
  platform: "github",
  repositories: [repository],

  onboarding: false,
  requireConfig: "ignored",
  enabledManagers: ["dockerfile"],
  pinDigests: true,
  automerge: false,

  packageRules: [
    {
      // 預設不更新其他 Docker Images
      matchDatasources: ["docker"],
      enabled: false
    },
    {
      // 只啟用指定 Base Image
      matchDatasources: ["docker"],
      matchPackageNames: [image],
      enabled: true
    },
    {
      // 禁止更換 Tag / Runtime 版本，只保留 Digest / Pin Digest
      matchDatasources: ["docker"],
      matchPackageNames: [image],
      matchUpdateTypes: ["major", "minor", "patch", "replacement"],
      enabled: false
    }
  ]
};
```

**規則說明：** `pinDigests` 是固定 Digest，不代表禁止版本升級；因此額外停用 `major`、`minor`、`patch`、`replacement`。實際上仍須在測試 Repo 驗證新的 Tag 分類是否符合預期。

### 6.3 `.github/workflows/renovate.yml`

```yaml
name: Renovate

on:
  workflow_dispatch:
  schedule:
    - cron: "0 1 * * *"  # UTC 01:00，台灣時間約 09:00

permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write

jobs:
  renovate:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Authenticate to GCP
        id: auth
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}
          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}
          token_format: access_token

      - name: Run Renovate
        uses: renovatebot/github-action@v46.3.10
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          configurationFile: renovate-config.js
        env:
          LOG_LEVEL: info
          RENOVATE_TARGET_REPO: ${{ github.repository }}
          RENOVATE_BASE_IMAGE: ${{ vars.BASE_IMAGE }}
          RENOVATE_HOST_RULES: >-
            [
              {
                "hostType": "docker",
                "matchHost": "${{ vars.REGISTRY_HOST }}",
                "username": "oauth2accesstoken",
                "password": "${{ steps.auth.outputs.access_token }}"
              }
            ]
```

GitHub Actions 會先以 WIF 取得 GCP Access Token，再把它交給 Renovate 查詢指定 Docker Registry。`secrets.GITHUB_TOKEN` 用來操作目前的 GitHub Repo。

> 正式環境建議將第三方 Actions 固定到已審核的 Commit SHA，並定期更新。示例使用已驗證過的版本標籤以保持易讀。

## 7. 首次執行與驗證

在 GitHub → **Actions → Renovate → Run workflow** 手動執行。

預期結果：

1. `Authenticate to GCP` 成功。
2. `Renovate` 找到 Dockerfile 中指定的 Base Image。
3. 如果 Dockerfile 尚未指定 Digest，會建立 **Pin Digest PR**。
4. 合併後，下次沒有 Digest 變化就不應重複建立 PR。
5. 當 Registry 上同一 Tag 指向新 Digest，才建立真正的 **Digest Update PR**。

```diff
-FROM <REGISTRY>/<IMAGE>:3.14@sha256:<OLD_DIGEST>
+FROM <REGISTRY>/<IMAGE>:3.14@sha256:<NEW_DIGEST>
```

注意：首次建立 Pin Digest PR **不代表 Image 剛發布新版**，只是開始固定目前的 Digest。

### 7.1 準備獨立測試 Image

以下指令由具有 Registry 寫入權限的發布者在本機執行，需已安裝 Docker 並設定第 1 節變數。**不修改正式的 `${BASE_IMAGE}:${BASE_TAG}`**，而是在相同 Artifact Registry Repository 下建立 `python-renovate-test`：

```bash
export TEST_IMAGE="${BASE_IMAGE}-renovate-test"
export TEST_DIR="$(mktemp -d)"

gcloud auth configure-docker "$REGISTRY_HOST"

cat > "${TEST_DIR}/Dockerfile" <<'EOF'
ARG BASE_REF
FROM ${BASE_REF}
ARG TEST_REV
LABEL renovate.test.revision="${TEST_REV}"
EOF

docker build \
  --build-arg BASE_REF="${BASE_IMAGE}:${BASE_TAG}" \
  --build-arg TEST_REV=1 \
  -t "${TEST_IMAGE}:3.14" "$TEST_DIR"
docker push "${TEST_IMAGE}:3.14"
```

這個測試 Image 只在現有 Base Image 上加入測試 Label；後續更改 Label 即可製造不同 Digest，不必改動 Python 本身。

在**測試用 GitHub Repo** 完成第 5、6 節，並調整：

- Repository Variable `BASE_IMAGE` 設為 `$TEST_IMAGE` 的實際值，可用 `echo "$TEST_IMAGE"` 查看。
- Dockerfile 的 `FROM` 改為該測試 Image 的 `:3.14`，一開始不加 Digest。
- 確認實際 `renovate-config.js` 與 Workflow 已採用第 6 節的環境變數版本；若仍寫死 Image 路徑，只改 Variable 不會生效。
- 若測試 Repo 與原本不同，請為它另行設定 WIF Provider 條件及 Service Account 的身分綁定；原本限定單一 Repo 的授權不會自動涵蓋測試 Repo。
- 測試 Image 位於相同 Artifact Registry Repository，既有的 Repository Reader 權限可涵蓋它；Repository 必須允許移動 Tag。

### 7.2 驗證 Pin Digest 與無變更時的行為

1. 將測試設定與 Dockerfile 提交到測試 Repo 的預設分支。
2. 手動執行 Renovate，確認建立 Pin Digest PR，且只加入 `@sha256:...`，`:3.14` 不變。
3. 合併 PR，再次執行 Renovate；未推送新版時，不應再建立 Digest 更新 PR。

可由發布者查詢 Registry 的 Digest，與 PR 中的值比對：

```bash
gcloud artifacts docker images describe "${TEST_IMAGE}:3.14" \
  --project="$GCP_PROJECT_ID" \
  --format='value(image_summary.digest)'
```

> 此查詢使用本機發布者的身分，只用來比對 Digest，不代表 Renovate Service Account 的讀取權限已通過驗證。Renovate 實際查詢成功並建立 PR 才涵蓋該路徑。

### 7.3 驗證同一個 Tag 的 Digest 更新

沿用 7.1 的環境變數與測試目錄，將 Label 改成第二版並推送到**同一個 `:3.14` Tag**：

```bash
docker build \
  --build-arg BASE_REF="${BASE_IMAGE}:${BASE_TAG}" \
  --build-arg TEST_REV=2 \
  -t "${TEST_IMAGE}:3.14" "$TEST_DIR"
docker push "${TEST_IMAGE}:3.14"

gcloud artifacts docker images describe "${TEST_IMAGE}:3.14" \
  --project="$GCP_PROJECT_ID" \
  --format='value(image_summary.digest)'
```

1. 確認查到的 Digest 與 7.2 不同。
2. 再次執行 Renovate；應建立 Digest Update PR，只有 `@sha256:...` 改變，`:3.14` 不變。
3. 合併後再次執行；若 Registry 沒有再變動，不應重複建立更新 PR。

### 7.4 驗證不升級 Tag、不更新其他 Image

先將第二版測試 Image 額外標記為 `3.15`，只用來測試 Renovate 的版本過濾；**這不代表 Image 裡的 Python 已變成 3.15**：

```bash
docker tag "${TEST_IMAGE}:3.14" "${TEST_IMAGE}:3.15"
docker push "${TEST_IMAGE}:3.15"
```

- 再次執行 Renovate，不應出現 `3.14 → 3.15` 的 PR。
- 在測試 Dockerfile 另加一個非目標 Image 的 stage，例如 `FROM python:3.14 AS unrelated`；提交後執行 Renovate，該 stage 不應被加入 Digest 或升級 Tag。
- 驗收完成後，正式 Repo 保持原本的 `BASE_IMAGE` 與 Dockerfile 路徑；不要把測試 Image 當成正式 Base Image 部署。

| 驗收項目 | 預期結果 |
|---|---|
| 首次只有 `:3.14` | 建立 Pin Digest PR |
| 合併後重跑，Tag 的 Digest 未變 | 不建立新的更新 PR |
| 相同 `:3.14` 推送不同內容 | 建立 Digest Update PR，Tag 不變 |
| 額外發布 `:3.15` | 不建立 Tag 升級 PR |
| Dockerfile 加入非目標 Image | 不更新該 Image |

## 8. 常見錯誤排除

| 現象 | 可能原因 | 檢查方向 |
|---|---|---|
| `invalid_target` | WIF Pool / Provider 不存在、停用或 Project Number 不符 | `gcloud iam workload-identity-pools ... describe` |
| `unauthorized_client` | OIDC 的 Repo / Branch 條件不符 | Provider 的 `attribute-condition`、GitHub 執行分支 |
| `iam.serviceAccounts.getAccessToken denied` | GitHub 身分不能模擬 Service Account | `roles/iam.workloadIdentityUser` 綁定 |
| Registry 回應 `403` | Service Account 權限不足 | 指定 Artifact Registry Repository 的 Reader 權限 |
| `manifest unknown` | Image 或 Tag 不存在 | Dockerfile 的 Image 路徑、Tag |
| Renovate 建 Branch 卻沒有 PR | GitHub Actions PR 權限被禁止 | Workflow permissions、Debug Log |
| Renovate 提議升級 Runtime 版本 | 沒有限制 Tag 更新類型 | `matchUpdateTypes` 規則 |
| Workflow 成功但沒有 PR | Digest 沒變、設定不匹配，或已有更新 Branch / PR | `LOG_LEVEL: debug` 確認解析、查詢與跳過原因 |

必要時把 Workflow 中的 `LOG_LEVEL: info` 暫時改成 `debug`，排除問題後再還原。

## 9. 擴展到多個 GitHub Repositories

採用**各 Repo 自行執行 Renovate、自行建立 PR** 的方式，不設中央 Runner，也不需要跨 Repo 寫入權限：

```text
Artifact Registry：python:3.14 → 新 Digest
  ├─ Repo A 的 Actions → Renovate → Repo A 的 PR
  ├─ Repo B 的 Actions → Renovate → Repo B 的 PR
  └─ Repo C 的 Actions → Renovate → Repo C 的 PR
```

這裡的「抓最新」是查詢**各 Repo Dockerfile 既有 Tag 的最新 Digest**，不是將 `3.14` 升級成 `3.15`，也不是改用 `latest`。

每個 Repo 的設定步驟：

1. 放入第 6 節的 `renovate-config.js` 與 `.github/workflows/renovate.yml`，並設定自己的 Dockerfile。
2. 依第 5 節設定 `GCP_WIF_PROVIDER`、`GCP_SERVICE_ACCOUNT`、`REGISTRY_HOST`、`BASE_IMAGE`，以及 Actions 建立 PR 的權限。
3. 依第 4 節為該 Repo 建立 WIF Provider 與 Service Account 身分綁定，限制該 Repo 及其預設分支。可共用 WIF Pool，但每個 Provider 使用不同 ID；不要直接沿用只允許原 Repo 的 Provider。
4. Workflow 保持 `RENOVATE_TARGET_REPO: ${{ github.repository }}`，`repositories` 只包含當前 Repo，使用該 Repo 內建的 `GITHUB_TOKEN` 建立 PR。
5. 依第 7 節完成驗收，再啟用日常排程；多個 Repo 可錯開排程時間。

若多個 Repo 讀取相同 Artifact Registry Repository，可共用唯讀 Service Account，但必須逐一加入各 Repo 的身分綁定；若需要獨立稽核或撤銷權限，則每個 Repo 使用自己的 Service Account。

注意：

- **PR 的 CI 觸發限制仍然存在。** 內建 `GITHUB_TOKEN` 建立的 PR 通常不會觸發新的 `pull_request` workflow，分散執行不會解除這個限制。若要求 PR 自動跑 CI，可讓每個 Repo 使用僅授權自身的 GitHub App Installation Token；這不代表要改回中央 Runner。
- 每個專案自己的 CI/CD 仍需取得拉取 Base Image 的權限；**Renovate 能查 Digest 不等於各專案能 Build**。
- 每個 Repo 自行決定何時測試、合併及重新 Build / Deploy；Base Image 發布者仍只需發布一次新版。

## 10. 安全與維運提醒

- **不可變 Digest 與可移動 Tag 是不同概念。** `@sha256` 確保既有 Build 使用固定版本；`:3.14` 供 Renovate 查詢最新 Digest。
- 如果 Repository 啟用 **Immutable Tags**，同一個 `3.14` Tag 不能改指向新版 Digest，需改用發行版 Tag 與對應更新規則。
- Registry 清理政策要保留仍被專案引用的舊 Digest，避免重建時拉不到 Image。
- GCP Access Token 有期限，GitHub Actions 每次執行應重新取得；大量 Repo / 長時間執行需留意 Token 過期。
- Digest 更新不等於安全：Image 更新仍需要漏洞掃描、Build、測試與部署驗證。
- 更新 Base Image 不會自動更新應用程式既有 Image；需要各專案的 CI 重新 Build 與部署。

## 參考文件

- [Renovate Docker / Google Registry authentication](https://docs.renovatebot.com/docker/)
- [Renovate Configuration Options](https://docs.renovatebot.com/configuration-options/)
- [Renovate GitHub Action](https://github.com/renovatebot/github-action)
- [Google GitHub Actions Auth](https://github.com/google-github-actions/auth)
- [Google Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
