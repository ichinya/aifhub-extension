## AIFHub OpenSpec-native Override

Apply this block before the upstream `aif-explore` body. When any rule below conflicts with the base skill text, this block wins.

### Goal

Keep `/aif-explore` as a research-oriented command while making the extension aware of OpenSpec-native artifact ownership.

### Mode Detection

Before resolving exploration inputs, read `.ai-factory/config.yaml` when it exists.

- If the config contains `aifhub.artifactProtocol: openspec`, use **OpenSpec-native mode**.
- Otherwise, use **Legacy AI Factory-only mode**.
- If the config is missing, continue with Legacy AI Factory-only mode and state that no OpenSpec-native protocol was detected.

### OpenSpec-native mode

When `.ai-factory/config.yaml` declares `aifhub.artifactProtocol: openspec`, `/aif-explore` is research-oriented and must not create canonical OpenSpec change artifacts.

Allowed read context:

- `.ai-factory/config.yaml`
- `.ai-factory/DESCRIPTION.md`
- `.ai-factory/ARCHITECTURE.md`
- `.ai-factory/RESEARCH.md`
- `openspec/specs/**`
- `openspec/changes/<change-id>/**`
- `.ai-factory/state/<change-id>/`

Canonical OpenSpec change files under an active change are only:

- `openspec/changes/<change-id>/proposal.md`
- `openspec/changes/<change-id>/design.md`
- `openspec/changes/<change-id>/tasks.md`
- `openspec/changes/<change-id>/specs/**/spec.md`

Write boundaries:

- Write research output only to `.ai-factory/RESEARCH.md` or runtime notes under `.ai-factory/state/<change-id>/`.
- Valid runtime note targets include `.ai-factory/state/<change-id>/explore.md` and `.ai-factory/state/<change-id>/research-notes.md`.
- Do not create non-OpenSpec files under `openspec/changes/<change-id>/`.
- Do not write debug files, summaries, research notes, validation evidence, or runtime-only files under an OpenSpec change folder.
- If no change ID is known, write only to `.ai-factory/RESEARCH.md` and report that no change-scoped runtime path was selected.

Response and next-step guidance:

- Report where research was written in the normal response.
- Distinguish research output from canonical OpenSpec artifacts.
- Suggest `/aif-plan full "<request>"` for new work that needs canonical change artifacts.
- Suggest `/aif-improve <change-id>` for refining an existing OpenSpec-native change.
- Suggest `/aif-implement <change-id>` only after an OpenSpec-native plan is ready for execution.
- Do not suggest deprecated `*-plus` aliases.
- Do not install OpenSpec skills or slash commands.

### Legacy AI Factory-only mode

When OpenSpec-native mode is not enabled, preserve the extension's companion plan behavior:

- Treat `.ai-factory/plans/<plan-id>.md` and `.ai-factory/plans/<plan-id>/` as one active plan pair.
- If `@path` points to the plan file, the plan folder, or one of its local artifacts (`task.md`, `context.md`, `rules.md`, `verify.md`, `status.yaml`, `explore.md`), resolve the whole pair before continuing.
- Persist exploration only to `config.paths.research` / `.ai-factory/RESEARCH.md`.
- Do not treat `DESCRIPTION.md`, `ARCHITECTURE.md`, `ROADMAP.md`, or `RULES.md` as writable from explore mode in this extension workflow.
- For next steps, prefer:
  - `/aif-plan full "<task>"` for new work
  - `/aif-improve <plan-id>` for plan refinement
  - `/aif-implement <plan-id>` for execution
- If a legacy folder-only plan is detected, present the canonical next step using the normalized plan id and companion plan-file model.

### Codex Runtime

When running in Codex app/CLI:

- The planning stage (`/aif-explore`, `/aif-plan full`, `/aif-improve`) should run in Codex Plan mode when structured clarifying questions are needed.
- This skill may recommend Plan mode, but it does not attempt or promise to switch the Codex session mode. The user controls the mode.
- In Codex Plan mode, use `request_user_input` only for 1-3 short questions.
- In Codex Default mode, if a question is needed, ask it as plain text in the assistant message. Do not use `question(...)`, `questionnaire(...)`, or `request_user_input`.
- In autonomous or subagent mode, do not ask interactive questions. Record assumptions and return blockers/open questions to the parent.
- See `skills/shared/QUESTION-TOOL.md` for the full runtime question format mapping.
