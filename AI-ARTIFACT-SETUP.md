# AI 任務：串接 Artifact Registry，自動建立 Image 更新 PR

## 人類輸入

Artifact Registry 位置：

```text
<填入 Artifact Registry Repository 或 Image 路徑>
```

目標 GitHub repository 為目前專案，不另外指定。
人類只需提供上述位置；其餘能查詢確認的資訊由 AI 自行取得。

## 最終目標

完成以下自動化：

```text
Artifact Registry 有符合專案追蹤策略的 Image 更新
→ GitHub Actions 定期執行 Renovate
→ Renovate 自動建立更新 PR
→ 人類審核與合併
```

不自動合併，不自動部署。日常偵測與開 PR 由 Renovate 與 GitHub Actions 負責，不依賴 AI 持續運行。

## 你的職責

你有 gcloud 與 GitHub 操作權限。請自行完成調查、設定、修改、測試與交付，不要只提供操作教學，也不要要求人類手動執行你已經能完成的步驟。

先調查並簡短說明執行方向，再於本文件授權範圍內自主完成。不必逐條指令詢問；只有無法確認的必要決策或超出操作邊界時，才集中請人類確認。

### 1. 自動調查與配對

- 閱讀適用的 `AGENTS.md`、本專案的 `README.md`、Dockerfile、Renovate 設定與 GitHub Actions。
- 確認目前 GitHub repository、預設分支、既有自動化及工作目錄修改狀態。
- 從提供的 Artifact Registry 路徑確認 GCP project、location、repository、registry host 與可用 Images；若為 `gcr.io` 相容網域，確認實際由 Artifact Registry 承載。
- 辨識專案使用的 Images，與指定 Registry 內的 Images 配對。
- 沿用專案既有的版本與 Tag 策略，不預設特定語言、版本或固定 Tag。
- 若需要替換來源路徑，確認 Image 用途與版本相容性，不得只因名稱相似就直接替換。
- 若既有策略不明確，或 Registry 的 Tag 不可移動而與現行策略衝突，提出查證結果與建議，請人類確認，不得自行更換版本策略。
- 能透過查詢確認的資訊自行取得；只有無法唯一配對、需求衝突或涉及額外風險時，才集中詢問人類。

本文件是任務目標；既有 README 是操作參考。若文件、程式與實際環境不一致，請查證並修正，不要直接照抄、套用範例中的固定版本或重新建立所有資源。

### 2. 完成串接

優先沿用既有資源與設定，採取最小必要變更，補齊以下項目：

- GitHub Actions 執行 Renovate，支援排程與手動觸發；已有合理排程時優先沿用。
- 使用 GitHub OIDC 與 GCP Workload Identity Federation，每次執行取得短效憑證。
- Renovate 使用的 Service Account 僅取得目標 Artifact Registry Repository 的讀取權限。
- WIF 信任限制於目前 GitHub repository 與執行分支，不放寬其他既有使用者的安全邊界。
- 設定必要的 GitHub Variables、Workflow 權限、Registry 認證及 Renovate 規則。
- 讓 Renovate 能自行建立更新分支與 PR，維持不自動合併。
- 只處理指定 Registry 中與本專案相關的 Images，不順便啟用其他套件或無關 Image 的更新。
- 不把本機 gcloud 登入狀態或本機憑證當成 GitHub Actions 的持續認證方式。

若使用內建 `GITHUB_TOKEN` 建立 PR，應說明其通常不會觸發後續 `pull_request` Workflow 的限制。若專案要求更新 PR 自動執行 CI，確認是否已有適用的 GitHub App；新增認證或安裝授權需求應另行說明，不得默默擴大權限。

Renovate 只負責偵測更新與建立 PR，不負責建置或同步上游 Image。發布者仍須將新版 Image 發布至指定 Registry。

### 3. 驗證實際行為

不能只以設定檔存在或 Workflow 顯示成功作為完成依據。

請確認：

- GitHub Actions 實際透過 WIF 取得 GCP 存取權。
- Renovate 能讀取目標 Registry 的 Image metadata；本機管理員帳號讀取成功不能代替此項驗證。
- Renovate 能辨識本專案的 Image 參照。
- 有符合條件的更新時，能自動建立正確的 PR。
- 沒有更新時，不會製造無意義或重複的 PR。
- 更新範圍符合專案既有版本策略，且沒有修改無關 Images。

若目前沒有可用更新，不得改動正式 Image 製造更新。可提出隔離測試方案，取得必要授權後執行；尚未實測的行為必須明確標示，不能將 dry-run 或首次 Pin Digest PR 當成完整更新驗收。

### 4. 交付與人類確認

將必要的程式與設定修改整理成設定 PR，並提供：

- 自動判定的 Registry 與專案 Image 對應。
- 採用的更新策略與排程。
- 已建立或修改的 GCP、GitHub 設定。
- Workflow 執行連結、驗證結果及更新 PR 連結。
- 尚待人類確認或尚未驗證的項目。
- 停用與回復方式，區分本次新增與原有共用資源。

若設定必須先合併才能在預設分支執行，先交付設定 PR，明確請人類確認合併；合併後繼續完成實際驗證，不得提前宣稱完成。

## 操作邊界

本任務授權以下必要操作：

- 建立或沿用專用 WIF、Service Account，並啟用必要 API。
- 新增限定範圍的 IAM 綁定，使目前 repository 能以專用身分讀取目標 Registry。
- 設定目前 repository 的必要 Actions Variables 與 Actions 建立 PR 權限，但不得繞過組織政策。
- 建立工作分支、提交本任務修改、推送並建立 PR。
- 手動觸發已可用的 Workflow 並查閱執行結果。

不得：

- 建立長效 Service Account Key。
- 給 Renovate Registry 寫入權、Owner、Editor 或其他廣泛管理權。
- 修改正式 Image 的 Tag 或內容、刪除既有資源或放寬組織安全政策。
- 自行合併 PR、直接推送預設分支、force push 或部署。
- 覆蓋、撤銷或提交其他人與本任務無關的工作。
- 在文件、提交、PR、log 或回報中揭露 Token、憑證及秘密值。

擁有完整操作權限不代表所有操作都已獲授權。超出以上範圍時才需要另外確認。

## 完成標準

- [ ] 已確認 Registry 與專案 Image 對應，以及適用的更新策略。
- [ ] 必要的 GCP 與 GitHub 串接已完成。
- [ ] Workflow 支援排程與手動執行。
- [ ] 已驗證 Actions → WIF → Registry → Renovate 的實際存取路徑。
- [ ] 已驗證符合策略的更新能自動建立 PR，且不影響無關 Images。
- [ ] 已確認無更新時不會重複建立更新 PR。
- [ ] 已交付設定 PR、驗證證據、限制與回復方式。

尚未驗證的項目不得勾選；有阻礙時清楚列出剩餘步驟與需要人類確認的事項。
