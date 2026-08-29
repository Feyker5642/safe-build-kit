---
name: safe-build-compiler
description: Compile a vague AI build request into a reviewable Safe Build Pack containing scope, policy, acceptance cases, and required delivery evidence.
---

# Safe Build Compiler

Turn one proposed AI build request into a reviewable four-file contract. Use this skill before implementation when scope, constraints, acceptance, or required evidence are still incomplete.

## Workflow

1. Decide whether the requested build is worth creating. State the intended user, problem, and smallest useful outcome; stop if there is no defensible outcome.
2. Extract stated facts, unstated assumptions, missing information, and genuine unknowns. Preserve `unknown`; never replace it with a guess.
3. Separate `scope.in` from `scope.out` and make prohibited actions explicit.
4. Choose `personal` or `controlled`. Use `controlled` when organizational controls, protected systems, governed credentials, or auditable isolation are required.
5. Read [references/build-pack-format.md](references/build-pack-format.md), then create exactly four files from `assets/build-pack-template/` under the target project's `.safe-build/` directory.
6. For `controlled`, set `isolationEvidenceRequired: true` and require both `isolation_evidence` and `human_acceptance` artifacts.
7. Check that acceptance cases are deterministic and that every required claim has corresponding delivery evidence.
8. Show a concise summary to a human before treating the Build Pack as frozen.

## Required output

```text
.safe-build/
├─ quest.yaml
├─ policy.yaml
├─ acceptance.yaml
└─ artifact-contract.yaml
```

Before human confirmation, label the pack `DRAFT`. The confirmation summary must include the goal, Profile, in-scope, out-of-scope, assumptions, unknowns, forbidden actions, acceptance cases, required evidence, and any isolation requirement.

After confirmation, do not silently change the pack. Material changes require a new summary and confirmation.

## Boundaries

- Do not write production code.
- Do not start or direct a Coding Agent.
- Do not execute verification or claim that delivery passed.
- Do not invent missing facts, commands, paths, evidence, approvals, or security controls.
- Keep the Build Pack specific to the request; do not introduce a generic framework for hypothetical future needs.
