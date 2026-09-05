// Shared helpers for Ponytail lifecycle A/B hidden graders.
// Every grader receives exactly one argument: the case project root.
// Grader exit code 0 = pass; any non-zero exit = fail.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function caseRootOf(projectRoot) {
  return path.dirname(path.resolve(projectRoot));
}

export async function readText(filePath, label) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${error.message}`);
  }
  return raw;
}

export function extractAssistantText(piEventsJsonl) {
  const texts = [];
  for (const line of String(piEventsJsonl ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event?.type === 'message_end' && event.message?.role === 'assistant'
      ? event.message
      : event?.type === 'agent_end'
        ? [...(event.messages ?? [])].reverse().find((item) => item?.role === 'assistant')
        : null;
    if (!message) continue;
    const chunks = [];
    if (typeof message.content === 'string') {
      chunks.push(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
      }
    }
    const text = chunks.join('\n').trim();
    if (text) texts.push(text);
  }
  if (texts.length === 0) throw new Error('no assistant message found in pi-events.jsonl');
  return texts[texts.length - 1];
}

export function extractGateBlocks(text, label) {
  const blocks = [];
  const fence = /```aif-gate-result\s*([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(text)) !== null) {
    const trimmed = match[1].trim();
    let parsed;
    let parseError = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      parseError = error.message;
    }
    blocks.push({ raw: trimmed, parsed, parseError });
  }
  if (blocks.length === 0) throw new Error(`${label}: no fenced aif-gate-result block found`);
  return blocks;
}

export function assertFinalGateBlock(text, label, expectedGate) {
  const blocks = extractGateBlocks(text, label);
  if (blocks.length !== 1) {
    throw new Error(`${label}: expected exactly one aif-gate-result block, found ${blocks.length}`);
  }
  const block = blocks[0];
  if (block.parseError) throw new Error(`${label}: final aif-gate-result is not valid JSON: ${block.parseError}`);
  const gate = block.parsed;
  if (gate.gate !== expectedGate) {
    throw new Error(`${label}: gate must be ${JSON.stringify(expectedGate)}, got ${JSON.stringify(gate.gate)}`);
  }
  if (!['pass', 'warn', 'fail'].includes(gate.status)) {
    throw new Error(`${label}: status must be lowercase pass|warn|fail, got ${JSON.stringify(gate.status)}`);
  }
  if (gate.schema_version !== 1) {
    throw new Error(`${label}: schema_version must be 1`);
  }
  const suggested = gate.suggested_next ?? null;
  if (gate.status === 'pass') {
    if (suggested !== null) throw new Error(`${label}: suggested_next must be null when status is pass`);
    if (gate.blocking === true) throw new Error(`${label}: blocking must not be true when status is pass`);
  }
  if (gate.status === 'fail') {
    if (gate.blocking !== true) throw new Error(`${label}: blocking must be true when status is fail`);
    if (suggested?.command !== '/aif-fix') {
      throw new Error(`${label}: suggested_next.command must be /aif-fix when status is fail`);
    }
  }
  if (gate.status === 'warn' && gate.blocking === true) {
    throw new Error(`${label}: blocking must not be true when status is warn`);
  }
  return gate;
}

export function assertKeywordGroups(text, groups, label) {
  for (const [index, group] of groups.entries()) {
    const hit = group.some((pattern) => new RegExp(pattern, 'iu').test(text));
    if (!hit) {
      throw new Error(`${label}: finding text missed required keyword group #${index + 1} (${group.join(' | ')})`);
    }
  }
}

export function pass(marker) {
  process.stdout.write(`${marker}=pass\n`);
}
