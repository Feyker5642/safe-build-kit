# Safe Build Kit Blueprint

## 1. 問題

Coding Agent 能快速產出程式，但需求邊界、禁止事項、驗收案例與交付證據通常不完整。結果是「程式看起來完成」與「需求已被安全、可重現地驗收」之間仍有缺口。

Safe Build Kit 把需求先整理成可審查的 Build Pack，再以確定性程式檢查 Agent 的交付及證據。它負責契約與驗證，不負責執行 Agent。

## 2. 使用者

- 個人開發者。
- 使用 Codex、Claude Code 等 Coding Agent 的人。
- 評估 AI 產出是否符合需求的人。
- 負責企業內部 AI 導入、治理與驗收的人。

## 3. 產品元件

### Compiler Skill

短生命的需求編譯 Skill。它辨識假設與未知、切分範圍、選擇 Profile，並產生四份 Build Pack 文件。它不寫正式程式碼，也不啟動 Coding Agent。

### Build Pack

一次建置任務的正式契約。它固定由四個 YAML 檔案組成，並可由 JSON Schema 驗證結構。

### CLI

本機確定性工具。M1、M2、M3 已依序提供 `safe-build validate`、`safe-build verify` 與 `safe-build report`；M0 原始範圍不包含實作。

### Static Report

把驗證結果投影成可閱讀、可保存的靜態報告，不負責執行建置。

### GitHub Action

把相同的確定性驗證放進既有 GitHub pull request 工作流程，不建立另一套驗證語意。Action 只投影 verifier 結果；只有 repository 另外把該 check 設為 required status check，才會阻止 Merge。

## 4. Build Pack 固定四檔

```text
.safe-build/
├─ quest.yaml
├─ policy.yaml
├─ acceptance.yaml
└─ artifact-contract.yaml
```

- `quest.yaml`：定義目標、使用者、Profile、範圍、輸入、輸出與成功條件。
- `policy.yaml`：定義可用路徑與命令、禁止行為、網路與憑證政策、人工核准與隔離證據要求。
- `acceptance.yaml`：定義可由程式重現的功能、負向與安全案例。
- `artifact-contract.yaml`：定義交付時不可缺少的 diff、測試、追溯與其他證據。

四檔共同構成正式契約；聊天訊息與口頭補充只有在寫回 Build Pack 並重新凍結後才生效。

## 5. 結果語意

- `PASS`：契約結構有效，必要檢查通過，要求的證據完整且與結果一致。
- `FAIL`：存在明確違規、測試失敗或證據證明交付不符合契約。
- `BLOCKED`：無法安全或完整驗證。例如任務聲稱採用 controlled 模式，卻缺少必要隔離或核准證據。
- `OPERATIONAL_ERROR`：驗證作業本身發生錯誤，無法可靠完成判定。

缺少證據不能自動視為 PASS；不確定也不能被改寫成成功。

## 6. Profile

V0.1 只保留兩種 Profile：

- `personal`：個人或低風險工作；仍需明確範圍與可重現驗收。
- `controlled`：受控或較高風險工作；必須要求 isolation evidence，缺少時結果為 BLOCKED。

Profile 只改變契約要求，不啟動不同的 Agent 或執行環境。

## 7. Non-goals

Safe Build Kit V0.1 明確排除：

- Agent Runtime。
- Agent Loop。
- OAuth。
- Sandbox Engine。
- multi-agent 或多 Agent Orchestration。
- 模型 Provider 與 model API。
- Web Platform、dashboard 與 Workflow Editor。
- DSH、Pi 或其他 Agent Harness 整合。
- 長期記憶。
- 自動部署。

這些項目不是 M0 的延後實作清單，而是產品邊界。未來只有在產品定位正式改變時才重新決策。
