# Requirements

- The reporter MUST summarize the audit trail after each nightly consolidation.
- The uploader MUST store the signed bundle on the artifact server and confirm completion with a visible status.
- Obviously the retention window is seven days.
- The indexer MUST keep the flat layout instead of the nested layout, though the spec previously declared nested storage and the loader uses the compact index.
