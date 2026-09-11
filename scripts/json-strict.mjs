// JSON.parse alone silently accepts duplicate decoded keys. Reject them at every
// nesting level before parsing policy, signals, or stored runtime content.
import { sddError } from './sdd-profiles.mjs';

export function parseStrictJson(raw) {
  if (typeof raw !== 'string') throw sddError('invalid_json');
  try {
    let index = 0;
    const white = () => { while (/\s/.test(raw[index] ?? '') && index < raw.length) index++; };
    const string = () => {
      const start = index++;
      while (index < raw.length) {
        if (raw[index] === '\\') { index += 2; continue; }
        if (raw[index++] === '"') return JSON.parse(raw.slice(start, index));
      }
      throw sddError('invalid_json');
    };
    const value = (depth = 0) => {
      if (depth > 100) throw sddError('invalid_json');
      white();
      const char = raw[index];
      if (char === '"') return string();
      if (char === '{') {
        index++;
        const object = {};
        const seen = new Set();
        white();
        if (raw[index] === '}') { index++; return object; }
        while (true) {
          white();
          const key = string();
          if (seen.has(key)) throw sddError('duplicate_json_key');
          seen.add(key);
          white();
          if (raw[index] !== ':') throw sddError('invalid_json');
          index++;
          object[key] = value(depth + 1);
          white();
          if (raw[index] === ',') { index++; continue; }
          if (raw[index] === '}') { index++; return object; }
          throw sddError('invalid_json');
        }
      }
      if (char === '[') {
        index++;
        const array = [];
        white();
        if (raw[index] === ']') { index++; return array; }
        while (true) {
          array.push(value(depth + 1));
          white();
          if (raw[index] === ',') { index++; continue; }
          if (raw[index] === ']') { index++; return array; }
          throw sddError('invalid_json');
        }
      }
      if (char === 't' || char === 'f' || char === 'n') {
        const literal = raw.slice(index, index + 20).match(/^(true|false|null)\b/)?.[0];
        if (!literal) throw sddError('invalid_json');
        index += literal.length;
        return JSON.parse(literal);
      }
      if (char === '-' || (char >= '0' && char <= '9')) {
        const number = raw.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)?.[0];
        if (!number) throw sddError('invalid_json');
        index += number.length;
        return JSON.parse(number);
      }
      throw sddError('invalid_json');
    };
    white();
    const result = value();
    white();
    if (index !== raw.length) throw sddError('invalid_json');
    return result;
  } catch (error) { throw error.sddCode ? error : sddError('invalid_json'); }
}
