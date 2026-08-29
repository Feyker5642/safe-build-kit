# Safe Build Kit

A portable build-contract compiler and verification kit for AI coding agents.

把模糊的 AI 建置需求轉成可驗收契約，再用確定性檢查驗證 Agent 交付。

## 核心流程

```text
Request
→ Safe Build Compiler
→ Build Pack
→ Coding Agent
→ Deterministic Verification
→ PASS / FAIL / BLOCKED / OPERATIONAL_ERROR
```

Safe Build Kit 不執行 Agent，不提供模型，不提供 Sandbox，不管理 OAuth，也不自行修改正式系統。

## Build Pack

每份 Build Pack 固定包含四個檔案：

- `quest.yaml`：目標、使用者、範圍、輸入、輸出與成功條件。
- `policy.yaml`：路徑、命令、網路、憑證、人工核准與隔離證據政策。
- `acceptance.yaml`：可重現的功能、負向與安全驗收案例。
- `artifact-contract.yaml`：Coding Agent 必須交付的證據。

聊天內容可以協助形成契約，但不是唯一正本；凍結後的 Build Pack 才是審查與驗證依據。

## V0.1 做什麼

- 用 Safe Build Compiler Skill 把模糊需求整理成 Build Pack。
- 支援 `personal` 與 `controlled` 兩種 Profile。
- 以小型 JSON Schema 定義四份契約格式。
- M1 提供確定性的 validate；M2 提供 Commit 對 Commit的唯讀 verify；M3 把同一次 verify execution 投影成機器可讀 JSON 與離線 HTML；M4 把同一 execution 放進唯讀 GitHub pull request check。
- 以清楚的 PASS、FAIL、BLOCKED、OPERATIONAL_ERROR 語意呈現結果。

M0 已凍結文件、Schema、模板與 Synthetic Example；M1 已實作 `safe-build validate`；M2 已實作 `safe-build verify`；M3 已實作 `safe-build report`；M4 已實作 bundled GitHub Action 並完成真實 PR red → green receipt。

## V0.1 取得與安裝

V0.1 是 GitHub source / Action release，不是 npm registry package。需要 Git、Node.js 24 LTS，以及 Node.js 隨附的 npm。

```powershell
git clone --branch v0.1.0 --single-branch https://github.com/Feyker5642/safe-build-kit.git
cd safe-build-kit
npm ci
npm run build
```

`npm ci` 依 lockfile 安裝固定版本的 dependencies；`npm run build` 產生 `dist/` CLI。`package.json` 保留 `"private": true`，用來阻止意外執行 `npm publish`。

## 一鍵可重現範例

完成安裝後，在 PowerShell 執行：

```powershell
node .\scripts\run-release-example.mjs $env:TEMP
```

macOS / Linux 可改用：

```bash
node ./scripts/run-release-example.mjs "${TMPDIR:-/tmp}"
```

這個指令會在指定的既有目錄下建立一個不覆寫舊資料的唯一子目錄，依序真跑 `validate`、`verify`、`report`，成功時只輸出一行 JSON。預期 `steps` 精確為 `["validate","verify","report"]`、`status` 是 `PASS`、command exit code 是 0；`reportJson` 與 `reportHtml` 是可直接開啟的報告路徑。

範例使用的是 synthetic Evidence（人工合成的證據資料），所以它只證明工具流程與 Evidence 內部一致；不證明真實測試曾執行、Artifact 產生者可信或來源身分已驗證。

## M1 使用方式

在全新 checkout 中執行：

```powershell
npm ci
npm run build
node .\dist\cli.js validate .\examples\quote-intake\.safe-build
```

成功時輸出 `PASS` 並回傳 exit code 0。

## M2 使用方式

`verify` 只讀取兩個 Commit、Build Pack 與已存在的 Evidence，不執行測試、Build、命令或 Artifact：

```powershell
node .\dist\cli.js verify .\.safe-build `
  --repo . `
  --base <git-ref> `
  --head <git-ref> `
  --evidence <evidence-directory>
```

Evidence 目錄必須包含 `evidence-manifest.yaml`。CLI 先把兩個 ref 固定成不可變 Commit OID，再檢查 Git changed paths、必要 Artifact、檔案邊界、SHA-256 與結構化 status。

結果與 exit code：

- `PASS`：0
- `FAIL`：1
- `OPERATIONAL_ERROR`：2
- `BLOCKED`：3

`PASS` 只證明指定 Commit 範圍與 Evidence Package 內部一致；它不證明測試真的執行、隔離證據真實、Artifact 產生者可信，或核准者身分已驗證。

## M3 使用方式

`report` 使用與 `verify` 相同的輸入，只執行一次 verification，並把該次 `ValidationResult`、`VerifyResult` 與追溯資料投影成兩個檔案：

```powershell
node .\dist\cli.js report .\.safe-build `
  --repo . `
  --base <git-ref> `
  --head <git-ref> `
  --evidence <evidence-directory> `
  --out .\.safe-build-report
```

`--out` 的父目錄必須已存在，指定的最終目錄必須尚不存在。成功後該目錄只包含：

- `report.json`：機器可讀的原始結果與 trace。
- `report.html`：完全離線、無 JavaScript 或外部資源的靜態報告；內含 `report.json` 精確 bytes 的 SHA-256。

只要兩檔成功發布，command exit code 就直接沿用同一個 `VerifyResult` 的 `0/1/2/3`。產報本身失敗時不改寫 verifier result、不覆寫既有輸出，stderr 輸出 `REPORT_GENERATION_FAILED` 並回傳 exit code 2。這和「verifier 本身判定 `OPERATIONAL_ERROR`，但報告成功產生」是兩種不同情況。

## M4 GitHub Action 使用方式

`action.yml` 把同一個 `executeVerification` 投影成 GitHub check；Action runtime 使用已提交的 bundle，不在 consumer 的 PR 執行期間安裝 npm dependencies、建置 Safe Build 或連接 registry。

Required inputs 與 `verify` CLI 一對一：

- `build-pack`：已凍結且來源可信的 Build Pack 目錄。
- `repository`：同時包含 base / head commit objects 的 Git repository。
- `base`、`head`：明確 commit OID；PR 使用 event payload 的 `base.sha` / `head.sha`，不使用 synthetic merge commit。
- `evidence`：由 consumer 的既有 CI 事先產生的 Evidence Package。

最小呼叫：

先把 annotated release tag 解成它實際指向的完整 commit SHA：

```powershell
git ls-remote https://github.com/Feyker5642/safe-build-kit.git "refs/tags/v0.1.0^{}"
```

把輸出的 40 字元 SHA 填進下方 `uses`；不要直接用 tag 作正式 gate 的 pin。

```yaml
permissions:
  contents: read

steps:
  - name: Checkout pull request head and both commit objects
    uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
    with:
      ref: ${{ github.event.pull_request.head.sha }}
      fetch-depth: 0
      persist-credentials: false

  # Consumer 必須在這之前建立 Evidence Package；Safe Build 不代跑 tests / build。
  - name: Verify frozen contract and existing evidence
    uses: Feyker5642/safe-build-kit@<full-commit-sha-from-command-above>
    with:
      build-pack: ${{ runner.temp }}/trusted-build-pack
      repository: ${{ github.workspace }}
      base: ${{ github.event.pull_request.base.sha }}
      head: ${{ github.event.pull_request.head.sha }}
      evidence: ${{ runner.temp }}/evidence
```

若 PR 作者可以同時修改 Action code 或 Build Pack，內部一致的惡意輸入仍可能得到誠實但無法信任的 PASS。正式 gate 應 pin Action 的 full commit SHA，並從 base commit 或另一個受保護來源 materialize frozen Build Pack；本 repo 的 [M4 smoke workflow](.github/workflows/m4-action-smoke.yml) 使用 `uses: ./`，只證明無 secrets 的 integration mechanics。

Outputs 在合計不超過 512 KiB UTF-16 safety budget 時，保留 canonical `status`、`safe-build-exit-code`、`result-json` 與 `trace-json`；超限時不發布 partial JSON，而以固定 infrastructure error 與 exit `2` fail closed。一般 PASS `0` 讓 check 綠燈；FAIL `1`、OPERATIONAL_ERROR `2`、BLOCKED `3` 保留原 exit 並讓 check 失敗。只有 repository 另外把該 check 設為 required status check，才能進一步阻止 Merge；Action 本身不修改 branch protection。

## V0.1 不做什麼

- 不提供 Agent Runtime、Agent Loop 或多 Agent Orchestration。
- 不提供模型 Provider 或 model API。
- 不建立 Sandbox Engine、OAuth 或憑證管理。
- 不建立 Web Platform、dashboard 或 Workflow Editor。
- 不提供長期記憶、自動部署或正式系統寫入能力。
- 不整合 DSH、Pi、Codex CLI 或 Claude Code Runtime。

## Repo 導覽

- `docs/BLUEPRINT.md`：產品問題、元件、契約與明確 non-goals。
- `skills/safe-build-compiler/`：需求編譯 Skill、格式參考與 Build Pack 模板。
- `schemas/`：四份 Build Pack JSON Schema 與一份 Evidence Manifest Schema。
- `examples/quote-intake/`：不含真實客戶資料的完整 Synthetic Example。
- `src/`：M1 validate、M2 verify 與 M3 report 的確定性 CLI 邏輯。
- `tests/`：validate／verify／report／release example 的有效、無效與安全邊界測試。
- `scripts/`：建置、Action fixture 與一鍵 release example 腳本。
- `action.yml`、`action-dist/`：M4 Action contract 與不需 runtime install 的預建 bundle。

## 版本與驗證

`package.json` 的 V0.1 版本是 `0.1.0`。目前完整 source gate 為 115 tests、113 pass、0 fail、2 個既有 Windows skips、0 todo；其中包含 release example 的 PASS、GitHub Actions `GITHUB_OUTPUT` 隔離、故意竄改後 FAIL／1，以及另建乾淨 fixture 後恢復 PASS／0。

正式 Release 的 annotated tag 才是可重現版本邊界；未帶 tag 的 branch checkout 應視為開發快照。Action consumer 即使使用版本 tag 辨識版本，正式 gate 仍應 pin 實際驗過的 full commit SHA。

## 授權

Safe Build Kit 採用 [MIT License](LICENSE)，copyright holder 為 `Feyker5642`。
