# Safe Build Pack Format

Use this reference when producing or reviewing the four files under `.safe-build/`. The JSON Schemas in the repository are the structural authority; this document explains how to fill the fields without inventing facts.

## Shared rules

- Use `version: 0.1` for this format.
- Use stable lowercase kebab-case identifiers.
- Keep source wording when precision matters. For example, preserve `約 3000` as approximate rather than converting it to an exact commitment.
- Put unavailable facts in `unknowns` or describe them as missing. Do not infer them from convention.
- Use relative paths when the target project is known.
- Keep each Build Pack specific to one build request.
- A Build Pack remains `DRAFT` until a human confirms the Compiler summary.

## quest.yaml

Defines what should be built and what success means.

- `version`: Build Pack format version.
- `id`: Stable task identifier.
- `title`: Short reviewable name.
- `goal`: Smallest useful outcome for the intended users.
- `users`: People who benefit from the result.
- `profile`: `personal` or `controlled`.
- `scope.in`: Explicitly included behavior and deliverables.
- `scope.out`: Explicit exclusions that prevent scope growth.
- `inputs`: Source material the build may rely on.
- `outputs`: Expected user-visible or machine-readable results.
- `successCriteria`: Observable statements that must all hold.
- `assumptions`: Optional claims currently treated as true and needing human review.
- `unknowns`: Optional missing facts that must remain unknown until supplied.

## policy.yaml

Defines what an implementation attempt may and may not do.

- `version`: Build Pack format version.
- `allowedPaths`: Paths where changes are permitted.
- `forbiddenPaths`: Paths that must remain untouched.
- `allowedCommands`: Commands explicitly permitted by the contract. Use an empty list when none have been confirmed.
- `forbiddenActions`: Side effects or behaviors that must not occur.
- `network`: `forbidden`, `restricted`, or `allowed`.
- `credentials`: `forbidden`, `environment-only`, or `organization-managed`.
- `humanApproval`: Actions or freeze points requiring a human decision.
- `isolationEvidenceRequired`: `true` only when the delivery must prove an isolation boundary. It must be `true` for `controlled`.

M2 interprets `allowedPaths` and `forbiddenPaths` as case-sensitive Git-tree paths:

- use repository-relative UTF-8 text and `/` separators;
- a trailing `/` is a directory prefix; every other value is an exact file path;
- do not use absolute paths, drive letters, UNC paths, `\`, empty segments, `.` or `..` segments;
- V0.1 does not support Glob and rejects `*`, `?`, `[` and `]`;
- every changed path must match an allowed path, and a matching forbidden path always wins.

Whenever `isolationEvidenceRequired` is `true`, the artifact contract must require `isolation_evidence`.

Do not put a secret value in this file. A credential mode describes policy, not credential content.

## acceptance.yaml

Defines deterministic cases used to judge the result.

Each item in `cases` contains:

- `id`: Stable case identifier.
- `type`: `functional`, `negative`, or `security`.
- `input`: Exact fixture, condition, or operation being checked.
- `expected`: Observable output or absence of a forbidden effect.
- `deterministic`: Must be `true` when the case belongs in a frozen Build Pack.

Use `negative` for forbidden behavior and missing-information handling. Use `security` only when the expected result checks a real security boundary; do not relabel ordinary validation as security.

## artifact-contract.yaml

Defines evidence required from the Coding Agent delivery. Each entry in `required` contains:

- `id`: Stable artifact identifier.
- `type`: One supported artifact type.
- `description`: What the evidence must demonstrate.
- `required`: Whether absence prevents acceptance.

Supported `type` values:

- `git_diff`
- `changed_files`
- `test_results`
- `build_results`
- `known_limitations`
- `source_traceability`
- `isolation_evidence`
- `human_acceptance`

For `controlled`, require both `isolation_evidence` and `human_acceptance`.

## evidence-manifest.yaml

The Artifact Contract declares which evidence is required. M2's fixed `evidence-manifest.yaml` maps those requirement IDs to the files supplied for one immutable Commit range.

```yaml
version: "0.1"
buildPackHash: <64 lowercase hex>
baseCommit: <40 or 64 lowercase hex>
headCommit: <40 or 64 lowercase hex>
artifacts:
  - id: <artifact-contract id>
    path: <relative POSIX path inside the evidence directory>
    sha256: <64 lowercase hex>
    status: passed | failed | unknown
```

`status` is required only for `test_results`, `build_results`, `isolation_evidence`, and `human_acceptance`, and must be absent for all other types. Artifact `type` is derived from the matching Artifact Contract entry and is not repeated in the Manifest.

The Manifest stores resolved `baseCommit` and `headCommit` OIDs, not mutable branch names. Artifact paths cannot be absolute, escape with `..`, use Windows separators, or pass through a Symlink or Junction. The verifier reads Artifact files only as bytes and recomputes SHA-256; it never executes them.

An absent required Manifest entry produces `BLOCKED`. A present entry whose file is missing or unreadable produces `OPERATIONAL_ERROR`. A present file whose recomputed Hash differs produces `FAIL`.

### Build Pack Hash byte framing

`buildPackHash` 使用 SHA-256，輸入不是 YAML object，也不做換行正規化、BOM 移除或重新序列化。所有文字 framing 都依下列規則轉成 bytes：

1. 先加入 UTF-8 bytes `safe-build-pack-v1`，再加入一個 `0x00` byte。也就是 domain separator `safe-build-pack-v1\0`。
2. 依固定順序處理四份檔案：
   1. `quest.yaml`
   2. `policy.yaml`
   3. `acceptance.yaml`
   4. `artifact-contract.yaml`
3. 每份檔案依序加入：
   - filename 的 UTF-8 bytes；
   - 一個 `0x00` filename separator；
   - raw file bytes 長度的 base-10 ASCII digits，等同 JavaScript `String(content.byteLength)`，沒有正負號或前導零；
   - 一個 `0x00` length separator；
   - 未改寫的 raw file bytes；
   - 一個 `0x00` trailing separator。
4. 對完整 byte stream 計算 SHA-256，輸出 64 個 lowercase hexadecimal 字元。

等價 pseudo-code：

```text
H = SHA256()
H.update(UTF8("safe-build-pack-v1"))
H.update(byte(0))
for filename in [
  "quest.yaml",
  "policy.yaml",
  "acceptance.yaml",
  "artifact-contract.yaml"
]:
  content = readRawBytes(filename)
  H.update(UTF8(filename))
  H.update(byte(0))
  H.update(ASCII(base10(content.byteLength)))
  H.update(byte(0))
  H.update(content)
  H.update(byte(0))
buildPackHash = lowercaseHex(H.digest())
```

因此任何 raw byte 差異，包括 YAML 空白或換行差異，都會改變 Build Pack Hash。

### Filesystem replacement boundary

Safe Build Verify 以 `lstat`、`realpath` containment、檔案 size／mtime／ctime 前後檢查、Hash 重算，以及驗證尾端的 Build Pack input recheck，降低檔案在驗證期間被替換的風險。

這些措施不能完全消除 filesystem TOCTOU race。V0.1 不提供 kernel-level immutable snapshot、`openat2 RESOLVE_BENEATH`、filesystem transaction，或 cryptographically authenticated evidence producer；不得把 `PASS` 解讀為上述保證。

M2 `PASS` proves Commit-range and Evidence-package consistency only. It does not prove that tests ran honestly, isolation is authentic, the producer is trusted, or a named human actually approved the delivery.

## Human confirmation summary

Before freeze, show:

1. Worth-building judgment and smallest useful outcome.
2. Goal and intended users.
3. Selected Profile and why.
4. In-scope and out-of-scope lists.
5. Assumptions and unknowns.
6. Network, credential, approval, and isolation policy.
7. Acceptance case IDs and expected outcomes.
8. Required artifact IDs.

Ask the human to confirm or revise this summary. Confirmation freezes the four files; it does not mean the future implementation is correct or accepted.

## Non-goals

The Build Pack format does not describe Runtime, Session, OAuth, Model, Agent Loop, provider routing, dashboards, or orchestration state. Those concepts must not be added to the four Schema files without a concrete product decision.
