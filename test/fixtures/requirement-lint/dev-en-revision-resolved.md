# Requirements

- The scheduler MUST use queue delivery instead of cron delivery, per user decision recorded in the reconciliation section.
- The importer MUST read the v2 manifest and replace the v1 reader instead of keeping both; user approved the precedence and the loader logs the selection.
