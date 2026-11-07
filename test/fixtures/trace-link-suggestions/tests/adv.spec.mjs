import { test } from 'node:test';
import { adv } from '../src/adv.mjs';

test('adv thing works', () => {
  adv.thing('docs/secret.md');
});
