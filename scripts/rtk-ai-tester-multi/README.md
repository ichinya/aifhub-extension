# Multirepository RTK A/B

Manual ai-tester + ACP + Pi experiment on three related repository snapshots.
References use only `repo-01`, `repo-02`, `repo-05`; the private label-to-path map
stays outside the repository. This is separate from the earlier single-repository
experiment and does not install anything into AIFHub.

Executed evidence: [report](../../docs/token-providers-research/rtk/multirepo-ab.md)
and [aggregate JSON](../../docs/token-providers-research/rtk/multirepo-ab-results.json).

The matrix is four scenarios × two arms × three repetitions. Both arms use
`omniroute/la/ornith-1.5-35b-a3b`, thinking low, identical prompts, fixed command
arguments and fresh multi-root sandboxes. Order alternates. The candidate loads
the unchanged RTK v0.48.0 Pi extension; baseline does not. In both arms a `raw `
command repeat is available only after its normal form has executed. This avoids
counting an immediate bypass as a test of compression. Reads remain complete.

| Scenario | Purpose |
|---|---|
| contract-review | Find a producer's renamed wire key and trace it through both downstream repositories |
| security-review | Attribute two seeded security regressions to the correct repositories without flagging an unchanged consumer |
| multi-diagnostics | Recover all 12 actual/expected pairs and repository owners despite repeated test basenames |
| coordinated-fix | Repair three real TS/PHP/Python source files together; preserve success/conflict behavior beyond visible tests |

Source snapshots come from exact clean Git commits. Tracked environment files,
credential-named files and original Git metadata are excluded. Each copy gets its
own local Git history. Review cases include 64 controlled documentation edits per
repository as explicit diff-noise fixtures. They are not claimed to be real
project changes. Runtime cases execute the existing status helper, backed enum
and HTTP proxy, with network calls mocked. The unchanged-source positive control
must pass; seeded runtime changes must fail exactly 12 cases before inference.
Fix-scenario regressions are committed in each disposable repository before the
main series, so repairing them produces a meaningful final diff. This protocol
correction followed the excluded pilot and preceded every main-matrix attempt.

The hidden grader runs independently after the model. The model cannot read it
through the supplied tools. It additionally checks queued/unknown badges, labels,
success JSON, conflict bodies and error status preservation. This is a tool
allowlist, not an OS sandbox against malicious generated code, and does not run
the complete deployed applications or AIFHub lifecycle.

Quality requires all hidden criteria, correct repository attribution, no missed
or invented findings, and actual RTK exposure in every candidate run. A benefit
requires at least 15% lower total model tokens, no more than 10% additional run
time, and a positive median reduction across pairs. Existing RTK privacy blockers
remain independent of this bounded benchmark. Report source-output bytes and
summed usage from every assistant message separately. Zero provider prices are
not evidence of free inference. Report malformed/incomplete attempts separately;
if availability recovers, repeat the entire affected pair, preserving originals.

The private JSON config uses the tool fields from the preceding harness plus
`python` (a dedicated venv), `projects` keyed by the three labels, and
`forbiddenNames` for checking published output. No original repository names or
paths belong in scenarios, reports or public result JSON.

```powershell
uv venv <temporary-root>/venv --python 3.13
uv pip install --python <temporary-root>/venv/Scripts/python.exe pytest==8.4.2 httpx==0.28.1 PyYAML==6.0.2
node --test scripts/rtk-ai-tester-multi/grade.test.mjs
node scripts/rtk-ai-tester-multi/run.mjs --config <private-inputs.json> --prepare-only
node scripts/rtk-ai-tester-multi/run.mjs --config <private-inputs.json> --stage smoke --scenarios contract-review --repeats 1 --smoke
node scripts/rtk-ai-tester-multi/run.mjs --config <private-inputs.json> --stage pilot --scenarios multi-diagnostics,coordinated-fix --repeats 1
node scripts/rtk-ai-tester-multi/run.mjs --config <private-inputs.json> --stage matrix --repeats 3
node scripts/rtk-ai-tester-multi/summarize.mjs <temporary-root>/matrix.json <temporary-root>/results.json
node scripts/rtk-ai-tester-multi/audit.mjs <private-inputs.json> <temporary-root>/matrix.json <temporary-root>/audit.json
node scripts/rtk-ai-tester-multi/probe.mjs <private-inputs.json> <temporary-root>/probes.json
node scripts/rtk-ai-tester-multi/publish.mjs <private-inputs.json> <aggregate-output.json>
```

The generated YAML files are actual ai-tester scenarios with a multi-repository
copy tree. `--stage` gives supplementary attempts separate identities; `--round`
and `--scenarios` select whole pairs for a retry. Existing attempts are never
overwritten. Raw traces, copies and metric sidecars remain private temporary
artifacts. Only sanitized aggregate evidence is eligible for publication. Report
cleanup status explicitly; an earlier deletion rejection is not a deletion.
