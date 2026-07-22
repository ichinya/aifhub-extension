# Shared Language Policy

Apply this policy before producing user-facing responses or generated artifacts from AIFHub extension-owned skills, injections, and packaged agents.

## Source Of Truth

- Read `.ai-factory/config.yaml` first when it is available.
- Treat `language.ui`, `language.artifacts`, and `language.technical_terms` as project-level preferences, not global user memory.
- Do not infer or persist project language from OS locale, repository programming language, or the current conversation alone.
- After config resolution, read and follow `skills/shared/PROJECT-GLOSSARY.md` for optional project terminology. That shared contract does not expand artifact ownership or make glossary loading mandatory.

## Output Rules

- Use `language.ui` for user-facing responses.
- Use `language.artifacts` for generated or updated artifacts.
- Keep commands, filenames, file paths, code identifiers, JSON keys, YAML keys, package names, and CLI flags in English.
- When `language.technical_terms` is missing or set to `keep`, keep technical terms in English unless an existing artifact already uses a localized term consistently.

## Missing Or Incomplete Config

- If `.ai-factory/config.yaml` is missing or does not contain complete language settings, preserve the current conversation language for the current response only.
- Do not persist inferred language guesses to config, rules, memory, or generated artifacts.
- When creating a durable artifact without explicit language config, prefer the existing project artifact language when one is clearly established.

## Existing Artifacts

- When editing an existing artifact, preserve its established language unless the owning command is creating or replacing the artifact.
- Translate an existing artifact only when the user explicitly asks for translation or the owning workflow explicitly performs a language migration.
- `## Original Request` is a raw-source exception in canonical `proposal.md`: keep the fixed English heading and preserve the request body byte-for-byte in its original language, including line endings, whitespace, punctuation, casing, and line breaks. Do not translate, summarize, normalize, or regenerate it.
- An existing `## Research Context` is an immutable committed snapshot. Preserve its body, source path, `Updated` marker, and `SHA256` metadata without translation or regeneration unless the user explicitly requests a research rebase.
- Configured `language.artifacts` still applies to generated proposal, design, task, spec, response, and report prose outside these raw or committed source sections.
- This policy does not expand ownership boundaries: prompts may only create or update artifacts they already own.
