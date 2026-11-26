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
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { hashContent, isProtectedReadPath, readContextDedupPolicy, recordRead, resolveCanonicalTarget, resolveContextDedupPolicy } from "../../scripts/context-dedup.mjs";

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
  // The benchmark owns the arm, compression threshold, and executable.
  return resolveContextDedupPolicy({
    mode: config.mode,
    minBytes: config.minBytes,
    sqz: { command: config.sqzCommand }
  });
}

async function projectReadPolicy(root, benchmarkPolicy) {
  const file = await resolveCanonicalTarget(root, ".ai-factory/config.yaml");
  const project = await readContextDedupPolicy({ rootDir: root, configPath: file.absolutePath });
  // A project can move its evidence directories. The benchmark still owns its original state directory.
  const protectedPatterns = new Set([...benchmarkPolicy.protectedPatterns, ...project.protectedPatterns]);
  return { ...benchmarkPolicy, protectedPatterns: [...protectedPatterns] };
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
    throw new RangeError(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
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

// A session ID and a disk entry survive context edits. Check the actual text
// still present in Pi's model-visible projection before serving a reference.
function hasVisibleDelivery(ctx, key) {
  try {
    const messages = ctx.sessionManager?.buildSessionProjection?.()?.messages;
    return Array.isArray(messages) && messages.some(message => {
      const proof = message.details?.dedup?.delivery;
      return message.role === "toolResult" && message.toolName === "read" && !message.isError
        && proof?.key === key && message.content?.length === 1 && message.content[0].type === "text"
        && hashContent(message.content[0].text) === proof.digest;
    });
  } catch {
    return false;
  }
}

export default function (pi) {
  const config = benchConfig();
  const policy = buildPolicy(config);
  let policyRoot;
  let projectPolicy;
  let protectedPatternCount = policy.protectedPatterns.length;
  const reads = [];
  const history = new Map();
  let sessionId = null;
  const sessionIds = new Set();
  let recipient = randomUUID();

  pi.registerTool({
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      force: Type.Optional(Type.Boolean({ description: "Return the original file text" })),
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

      let target;
      try {
        target = await resolveCanonicalTarget(ctx.cwd, rawPath);
      } catch {
        return {
          content: [{ type: "text", text: "Error reading file: path unavailable within the project root" }],
          details: { error: true },
        };
      }
      try {
        if (IMAGE_EXTENSIONS.has(extension)) {
          const buffer = await readFile(target.absolutePath);
          return {
            content: [{
              type: "text",
              text: `[binary image ${buffer.byteLength}B; not part of the dedup benchmark]`,
            }],
            details: { image: true },
          };
        }
        const rawContent = await readFile(target.absolutePath, "utf8");

        const hasOffset = params.offset !== undefined;
        const hasLimit = params.limit !== undefined;
        const original = formatReadOutput(rawContent, hasOffset, hasLimit, params.offset, params.limit);
        let visible = original;
        let servedLines = rawContent.split("\n").length;
        let record = null;
        let decision = "passthrough";
        let delivery;
        if (policyRoot !== ctx.cwd) {
          policyRoot = ctx.cwd;
          projectPolicy = projectReadPolicy(ctx.cwd, policy);
        }
        const effectivePolicy = await projectPolicy;
        protectedPatternCount = effectivePolicy.protectedPatterns.length;
        const digest = hashContent(rawContent);
        const view = JSON.stringify([params.offset ?? 1, params.limit ?? null]);
        const prior = history.get(target.absolutePath);
        const sameContext = prior?.recipient === recipient;
        const sameRevision = prior?.digest === digest && sameContext;
        const repeated = sameRevision && prior.views.has(view);
        let payloadClass = "firstRead";
        if (isProtectedReadPath(target.relativePath, effectivePolicy)) payloadClass = "protected";
        else if (prior && !sameContext) payloadClass = "freshSession";
        else if (prior && !sameRevision) payloadClass = "changed";
        else if (repeated) payloadClass = "exactRepeat";
        if (config.mode !== "off" && !hasOffset && !hasLimit && !original.details.truncation) {
          const stateDir = `.ai-factory/state/context-dedup-bench/${config.runId}`;
          const key = hashContent(JSON.stringify([recipient, sessionId, target.absolutePath, digest]));
          const result = await recordRead({
            filePath: target.relativePath,
            content: rawContent,
            rootDir: ctx.cwd,
            policy: effectivePolicy,
            stateDir,
            sessionId: sessionId ?? config.runId,
            force: params.force === true,
            replayAvailable: hasVisibleDelivery(ctx, key),
            sqzTimeoutMs: 15000,
          });
          record = result;
          decision = result.decision;
          const candidate = result.content ?? result.replay?.text ?? rawContent;
          if (candidate !== rawContent) {
            const formatted = formatReadOutput(candidate, false, false);
            if (formatted.details.truncation) {
              decision = "full";
            } else {
              visible = formatted;
              servedLines = candidate.split("\n").length;
            }
          }
          if (decision !== "deduplicated") {
            delivery = { key, digest: hashContent(visible.outputText) };
          }
        }

        const { outputText, details } = visible;
        const observedBytes = Buffer.byteLength(original.outputText, "utf8");
        const servedBytes = Buffer.byteLength(outputText, "utf8");
        const savedBytes = observedBytes - servedBytes;

        const views = sameRevision ? prior.views : new Set();
        views.add(view);
        history.set(target.absolutePath, { digest, recipient, views });
        reads.push({
          payloadClass, repeated,
          path: target.relativePath,
          mode: config.mode,
          decision,
          provider: record?.provider ?? null,
          providerOutcome: record?.providerOutcome ?? null,
          observedBytes,
          servedBytes,
          savedBytes,
          warnings: record?.warnings?.map((w) => w.code) ?? [],
        });

        return {
          content: [{ type: "text", text: outputText }],
          details: {
            ...details,
            lines: servedLines,
            dedup: record
              ? { decision, savedBytes, delivery }
              : undefined,
          },
        };
      } catch (error) {
        const reason = error.code ?? (error instanceof RangeError ? error.message : "read unavailable");
        return {
          content: [{ type: "text", text: `Error reading file: ${reason}` }],
          details: { error: true },
        };
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    policyRoot = undefined;
    projectPolicy = undefined;
    protectedPatternCount = policy.protectedPatterns.length;
    recipient = randomUUID();
    try {
      sessionId = ctx.sessionManager.getSessionId() ?? config.runId;
    } catch {
      sessionId = config.runId;
    }
    sessionIds.add(sessionId);
  });

  pi.on("session_shutdown", async () => {
    const totals = reads.reduce(
      (acc, r) => {
        acc.observedBytes += r.observedBytes;
        acc.servedBytes += r.servedBytes;
        acc.savedBytes += r.savedBytes;
        acc.readCalls += 1;
        if (r.repeated) acc.repeatReads += 1;
        const bucket = acc.payloadByClass[r.payloadClass];
        bucket.reads++;
        bucket.inputBytes += r.observedBytes;
        bucket.outputBytes += r.servedBytes;
        bucket.savedBytes += r.savedBytes;
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
        repeatReads: 0,
        payloadByClass: Object.fromEntries(["firstRead", "exactRepeat", "changed", "protected", "freshSession"].map(name =>
          [name, { reads: 0, inputBytes: 0, outputBytes: 0, savedBytes: 0 }])),
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
      attempt: 1,
      mode: config.mode,
      sessionId,
      sessionIds: [...sessionIds],
      policy: {
        minBytes: policy.minBytes,
        maxEntries: policy.maxEntries,
        protectedPatterns: protectedPatternCount,
      },
      totals,
      reads,
    };
    await writeFile(config.metricsFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  });
}
