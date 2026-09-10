## Fixer handoff

After classification permits the selected fix, preserve the previous finding IDs, descriptions, severity, and source review target. Before editing, identify the exact pre-fix target; after editing, report the exact resulting target, intended fix diff, per-finding attempted changes, covering check results, and remaining findings in the existing fix report/response. An attempted fix is a claim for the reviewer to verify, not a resolved finding.

Separate the defect claim from the proposed remedy before following review advice. Bind the claim to the actual target, requirement and relevant unchanged callers; check compatibility obligations before removing a validation, fallback or public behavior. Distinguish supported, contradicted and insufficient evidence in the existing report. A confident reviewer or a plausible patch is not evidence about the current target.

When the claim is contradicted or the target is stale, preserve the finding ID and blocker, make no speculative edit, and return an evidenced dispute to the reviewer or parent. When the defect is real but the remedy breaks the contract, use the narrower supported repair and request the ordinary re-review. The fixer does not mark a finding ADDRESSED or issue PASS; reassessment remains with the reviewer/parent and final verification owner. An unresolved question holds only dependent actions; independently clear findings retain their existing scope.

If the original review has no IDs, assign stable local references in its original order and retain the source description/location mapping throughout this fix round. Do not change existing provider IDs or treat two similar findings as one without evidence.

For committed work, use immutable fix-base and fix-head commit IDs, with fix-base equal to the target the previous review inspected. When fixes are uncommitted, identify both the pre-edit and post-edit working-tree snapshots and the corresponding bounded patch, including relevant added files and pre-existing changes. A HEAD-to-HEAD comparison does not describe uncommitted edits. Do not create commits, overwrite existing work, or manufacture a baseline just to prepare a handoff. If the previous target cannot be established, report that limitation explicitly.

Keep this evidence in the existing fix trace/report location for the selected artifact mode. Do not put findings or target revisions into `REVIEW.md`, canonical requirements, or a new receipt schema. Preserve unrelated open findings; selecting a subset for repair does not close the rest.
