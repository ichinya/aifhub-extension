# DESCRIPTION Template

Create `.ai-factory/DESCRIPTION.md` with this structure:

```markdown
# Project: [Name]

## Overview
[1-3 sentences: what this project does and why it exists]

## Product Type
[CLI tool | Web Application | API Service | Library | Extension | Mobile App | ...]

## Current Stack

### Language
- [Primary language and version if known]

### Framework
- [Framework name and version if known]

### Runtime
- [Node.js | PHP | Python | Go | ...]

### Database
- [Database type if detected]

### Key Dependencies
- [List 3-7 most important dependencies]

## Main Modules

| Module | Path | Purpose |
|--------|------|---------|
| [module name] | [path] | [brief description] |

## Key Integrations
- [Integration 1]: [purpose]
- [Integration 2]: [purpose]

## Security-Sensitive Areas
- [Area 1]: [why sensitive]
- [Area 2]: [why sensitive]

## Operational Notes
- [Deployment notes, environment requirements, etc.]

## Current Maturity Snapshot

| Area | Status | Notes |
|------|--------|-------|
| Source Control | [done/partial/missing] | [evidence] |
| Dependencies | [done/partial/missing] | [evidence] |
| Testing | [done/partial/missing] | [evidence] |
| CI/CD | [done/partial/missing] | [evidence] |
| Documentation | [done/partial/missing] | [evidence] |

## Known Gaps / Unclear Areas
- [Gap 1]
- [Gap 2]
- [Unclear area 1]
```

## Include

- Brief project purpose
- Only detected stack details
- Main modules from real paths
- Detected integrations
- Security-sensitive areas grounded in code or config
- Evidence-based maturity assessment
- Known gaps and unclear areas

## Exclude

- Skills to install
- MCP server setup
- Implementation plans
- Roadmap milestones
- Architecture decisions
