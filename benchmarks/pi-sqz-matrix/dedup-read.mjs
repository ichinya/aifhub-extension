// dedup-read.mjs - pi extension for the SQZ context-dedup benchmark matrix.
//
// Overrides the built-in `read` tool and routes text file reads through
// scripts/context-dedup.mjs (the exact production integration under test).
//
// Configuration (env):
//   SQZ_BENCH_MODE        off | aifhub | sqz          (required)
//   SQZ_BENCH_RUN_ID      unique per-run id            (required, isolates state)
//   SQZ_BENCH_METRICS     output JSON path             (required)
//   SQZ_BENCH_SQZ_CMD     path to verified sqz binary  (required for mode=sqz)
//   SQZ_BENCH_MIN_BYTES   minBytes threshold           (default 2048)
//
// The extension never mutates the project: dedup state lives under
// .ai-factory/state/context-dedup-bench/<run-id>/ and metrics are written
// to an absolute path outside the project. Session ledger state is removed
// by the harness after each run.
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { access, constants, readFile, writeFile } from "node:fs/promises";
import { recordRead, resolveContextDedupPolicy } from "../../scripts/context-dedup.mjs";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

function benchConfig() {
  const mode = (process.env.SQZ_BENCH_MODE ?? "off").trim().toLowerCase();
  if (!["off", "aifhub", "sqz"].includes(mode)) {
    throw new Error(`SQZ_BENCH_MODE must be off|aifhub|sqz, received: ${mode}`);
  }
  const runId = (process.env.SQZ_BENCH_RUN_ID ?? "").trim();
  const metricsFile = (process.env.SQZ_BENCH_METRICS ?? "").trim();
  if (!runId) throw new Error("SQZ_BENCH_RUN_ID is required");
  if (!metricsFile) throw new Error("SQZ_BENCH_METRICS is required");
  return {
    mode,
    runId,
    metricsFile,
    sqzCommand: (process.env.SQZ_BENCH_SQZ_CMD ?? "sqz").trim(),
    minBytes: Number(process.env.SQZ_BENCH_MIN_BYTES ?? 2048),
  };
}

function buildPolicy(config) {
  // Plain object lands in extractContextDedupConfig because every key is a
  // known policy key; protected patterns fall back to the built-in defaults.
  return resolveContextDedupPolicy({
    mode: config.mode,
    minBytes: config.minBytes,
    sqz: { command: config.sqzCommand }
  });
}

// Faithful replication of the built-in read tool output for text files:
// same offset/limit semantics, same truncation limits and continuation
// notices. Applied identically in every arm so the only variable between
// off/aifhub/sqz runs is the served content itself.
function formatReadOutput(rawContent, hasOffset, hasLimit, offset, limit) {
  const textContent = String(rawContent ?? "");
  const allLines = textContent.split("\n");
  const totalFileLines = allLines.length;
  const startLine = hasOffset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;

  if (hasOffset && startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
  }

  let selectedContent;
  let userLimitedLines;
  if (hasLimit) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }

  const truncation = truncateHead(selectedContent);
  let outputText;
  let details = {};
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' <file> | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return { outputText, details };
}

export default function (pi) {
  const config = benchConfig();
  const policy = buildPolicy(config);
  const reads = [];
  let sessionId = null;

  pi.registerTool({
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),
    promptGuidelines: [
      "Use read to examine files instead of cat or sed.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const rawPath = String(params.path ?? "").trim();
      if (!rawPath) {
        return {
          content: [{ type: "text", text: "Error: path is required" }],
          details: { error: true },
        };
      }
      const extension = path.extname(rawPath).toLowerCase();

      // Images and unreadable files follow the built-in path untouched.
      if (IMAGE_EXTENSIONS.has(extension)) {
        try {
          const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.cwd, rawPath);
          await access(absolute, constants.R_OK);
          const buffer = await readFile(absolute);
          return {
            content: [{
              type: "text",
              text: `[binary image ${buffer.byteLength}B; not part of the dedup benchmark]`,
            }],
            details: { image: true },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error reading file: ${error.message}` }],
            details: { error: true },
          };
        }
      }

      try {
        const absolutePath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(ctx.cwd, rawPath);
        const rawContent = await readFile(absolutePath, "utf8");

        let servedContent = rawContent;
        let record = null;
        if (config.mode !== "off") {
          const stateDir = `.ai-factory/state/context-dedup-bench/${config.runId}`;
          const result = await recordRead({
            filePath: absolutePath,
            content: rawContent,
            rootDir: ctx.cwd,
            policy,
            stateDir,
            sessionId: sessionId ?? config.runId,
            sqzTimeoutMs: 15000,
          });
          record = result;
          if (typeof result.content === "string") {
            servedContent = result.content;
          } else if (result.replay && typeof result.replay.text === "string") {
            servedContent = result.replay.text;
          }
        }

        const { outputText, details } = formatReadOutput(
          servedContent,
          params.offset !== undefined,
          params.limit !== undefined,
          params.offset,
          params.limit
        );

        reads.push({
          path: record?.path ?? rawPath,
          mode: config.mode,
          decision: record?.decision ?? "passthrough",
          provider: record?.provider ?? null,
          providerOutcome: record?.providerOutcome ?? null,
          observedBytes: record?.bytes ?? Buffer.byteLength(rawContent, "utf8"),
          servedBytes: record
            ? (record.decision === "deduplicated"
              ? (record.replayBytes ?? 0)
              : (record.outputBytes ?? record.bytes ?? 0))
            : Buffer.byteLength(servedContent, "utf8"),
          savedBytes: record?.savedBytes ?? 0,
          warnings: record?.warnings?.map((w) => w.code) ?? [],
        });

        return {
          content: [{ type: "text", text: outputText }],
          details: {
            ...details,
            lines: servedContent.split("\n").length,
            dedup: record
              ? { decision: record.decision, savedBytes: record.savedBytes ?? 0 }
              : undefined,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error reading file: ${error.message}` }],
          details: { error: true },
        };
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      sessionId = ctx.sessionManager.getSessionId() ?? config.runId;
    } catch {
      sessionId = config.runId;
    }
  });

  pi.on("session_shutdown", async () => {
    const totals = reads.reduce(
      (acc, r) => {
        acc.observedBytes += r.observedBytes;
        acc.servedBytes += r.servedBytes;
        acc.savedBytes += r.savedBytes;
        acc.readCalls += 1;
        if (r.decision === "deduplicated") acc.dedupHits += 1;
        if (r.decision === "compressed") acc.compressedReads += 1;
        if (r.decision === "protected") acc.protectedReads += 1;
        if (r.decision === "full" && r.mode !== "off") acc.fullReads += 1;
        if (r.decision === "passthrough") acc.passthroughReads += 1;
        if (r.warnings.length > 0) acc.warnedReads += 1;
        return acc;
      },
      {
        readCalls: 0,
        dedupHits: 0,
        compressedReads: 0,
        protectedReads: 0,
        fullReads: 0,
        passthroughReads: 0,
        warnedReads: 0,
        observedBytes: 0,
        servedBytes: 0,
        savedBytes: 0,
      }
    );
    const payload = {
      runId: config.runId,
      mode: config.mode,
      sessionId,
      policy: {
        minBytes: policy.minBytes,
        maxEntries: policy.maxEntries,
        protectedPatterns: policy.protectedPatterns.length,
      },
      totals,
      reads,
    };
    await writeFile(config.metricsFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  });
}
