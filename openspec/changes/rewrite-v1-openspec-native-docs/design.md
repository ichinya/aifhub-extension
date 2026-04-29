# Design: Rewrite v1 OpenSpec-native workflow docs

## Technical Approach

Rewrite the public documentation around one mental model:

```text
AI Factory UX + OpenSpec artifact protocol.
```

The README should be the short landing page. `docs/usage.md` should be the detailed operational guide. `docs/context-loading-policy.md`, `docs/openspec-compatibility.md`, and `docs/legacy-plan-migration.md` should each own one policy area and link to each other instead of repeating conflicting workflow descriptions.

Use exact vocabulary consistently:

- OpenSpec-native mode
- canonical OpenSpec artifacts
- runtime state
- QA evidence
- generated rules
- legacy AI Factory-only mode
- migration input

## Data / Artifact Model

The docs must use this conceptual layout exactly when explaining v1 ownership:

```text
openspec/
  specs/
    <capability>/spec.md
  changes/
    <change-id>/
      proposal.md
      design.md
      tasks.md
      specs/
        <capability>/spec.md

.ai-factory/
  state/
    <change-id>/
      implementation/
      fixes/
      final-summary.md
      migration-report.md
  qa/
    <change-id>/
      verify.md
      openspec-validation.json
      openspec-status.json
      openspec-archive.json
      done.md
      raw/
  rules/
    generated/
      openspec-base.md
      openspec-change-<change-id>.md
      openspec-merged-<change-id>.md
```

Ownership wording:

```text
openspec/specs                  canonical current behavior
openspec/changes                canonical proposed changes
.ai-factory/state               runtime execution traces
.ai-factory/qa                  verification/finalization evidence
.ai-factory/rules/generated     derived rules, safe to regenerate
.ai-factory/plans               legacy compatibility only
```

`docs/legacy-plan-migration.md` must document this exact mapping:

```text
.ai-factory/plans/<id>.md                    -> openspec/changes/<id>/proposal.md
.ai-factory/plans/<id>/task.md               -> openspec/changes/<id>/tasks.md
.ai-factory/plans/<id>/context.md            -> design.md and/or .ai-factory/state/<id>/legacy-context.md
.ai-factory/plans/<id>/rules.md              -> .ai-factory/state/<id>/legacy-rules.md
.ai-factory/plans/<id>/verify.md             -> .ai-factory/qa/<id>/legacy-verify.md
.ai-factory/plans/<id>/status.yaml           -> .ai-factory/state/<id>/legacy-status.yaml
.ai-factory/plans/<id>/explore.md            -> .ai-factory/state/<id>/legacy-explore.md
```

## Integration Points

Primary files:

- `README.md`: public landing page, quick start, artifact layout, compatibility, migration, troubleshooting links.
- `docs/usage.md`: complete v1 flow with command read/write/never-write sections and an OAuth example.
- `docs/context-loading-policy.md`: context-loading contract for OpenSpec-native consumers and legacy/migration-only paths.
- `docs/openspec-compatibility.md`: optional OpenSpec CLI adapter policy, version and Node requirements, capability flags, no installed OpenSpec skills.
- `docs/legacy-plan-migration.md`: exact migration commands and behavior.

Secondary files:

- `docs/active-change-resolver.md`: link and wording updates only if active-change troubleshooting needs a clearer cross-reference.
- `docs/adr/0001-openspec-native-artifact-protocol.md`: small consistency correction only; do not rewrite into a user guide.
- `docs/README.md`: docs index and reading order.

Validation:

- `npm run validate` runs manifest, agent schema, and doc-link validation.
- `npm test` runs prompt/script tests. If prompt tests object to legacy path mentions, make the legacy/migration boundaries more explicit in docs.

## Alternatives Considered

- Patch only the requested paragraphs: rejected because the issue is the final v1 docs pass and needs one consistent story across the public docs.
- Remove all legacy plan references: rejected because migration and AI Factory-only compatibility remain supported and must be documented.
- Update ADR 0001 heavily: rejected because the ADR should remain a decision record. User-facing explanations belong in README and usage docs.

## Risks

- Legacy examples can accidentally look like the default workflow. Keep every legacy path under clearly labeled compatibility or migration sections.
- The README can become too long if it duplicates the usage guide. Keep README short and link to deeper docs.
- The troubleshooting section can drift if repeated in many files. Prefer a concise README pointer plus the fuller `docs/usage.md` troubleshooting section.
