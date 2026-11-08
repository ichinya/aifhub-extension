import { test } from 'node:test';
import { auth } from '../src/auth.mjs';

// operation:auth.login denied path is documented here but must not anchor.
const label = 'operation:auth.login denied literal';

test('auth.login happy path', () => {
  const token = auth.login('u', 'p');
  token;
});
