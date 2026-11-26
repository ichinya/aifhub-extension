import { createHash } from 'node:crypto';

// Seeded, uniformly varied text for a low-redundancy input. Each line is
// a 43-character digest followed by LF. No provider or random data required.
const noise = Array.from({ length: 64 }, (_, index) =>
  createHash('sha256').update(`sample-${index}`).digest('base64url')
).join('\n') + '\n';

export const byteInputs = [
  { path: 'empty.txt', text: '', bytes: 0 },
  { path: 'short.txt', text: 'нет', bytes: 6 },
  { path: 'below.txt', text: 'я'.repeat(1023) + 'a', bytes: 2047 },
  { path: 'at.txt', text: 'я'.repeat(1024), bytes: 2048 },
  { path: 'above.txt', text: 'я'.repeat(1024) + 'a', bytes: 2049 },
  { path: 'large.log', text: 'entry=ok\n'.repeat(8192) + 'final=FAIL\n', bytes: 73739 },
  { path: 'long-line.txt', text: 'x'.repeat(65536) + '|END\n', bytes: 65541 },
  { path: 'noise.txt', text: noise, bytes: 2816 }
];
