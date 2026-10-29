// Shared pure projection: ordinary execution progress does not revise intent.
import { parseSimpleYaml } from './aif-artifact-sync.mjs';
import { parseWorkItemSourceBinding, parseLegacyWorkItemSourceBinding, parseSynchronizedWorkItemSourceBinding } from './active-change-resolver.mjs';

export function parseClassicStatusProjection(text, id, parent) {
  const parsed = parseSimpleYaml(text);
  if ((Object.hasOwn(parsed, 'plan_id') && String(parsed.plan_id) !== String(id)) || (text.match(/^plan_id\s*:/gm) ?? []).length > 1) throw new Error('plan-id-mismatch');
  const md = parseWorkItemSourceBinding(parent), yaml = parseLegacyWorkItemSourceBinding(text);
  if (!md.ok || !yaml.ok) throw new Error('invalid-source-binding');
  let binding = null;
  if (md.status === 'bound' || yaml.status === 'bound') {
    const pair = parseSynchronizedWorkItemSourceBinding(parent, text);
    if (!pair.ok) throw new Error('invalid-source-binding');
    binding = pair.binding;
  }
  return { projection: { plan_id: parsed.plan_id ?? null, source_binding: binding }, binding };
}
