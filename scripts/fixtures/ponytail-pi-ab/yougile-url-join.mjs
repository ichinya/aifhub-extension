import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error('project root argument is required');

const moduleUrl = pathToFileURL(path.join(projectRoot, 'build', 'common', 'request-helper.js')).href;
const requestHelper = await import(moduleUrl);
assert.equal(typeof requestHelper.buildYougileApiUrl, 'function', 'buildYougileApiUrl must be exported');

const cases = [
  ['https://yougile.com/api-v2', 'task-list', 'https://yougile.com/api-v2/task-list'],
  ['https://yougile.com/api-v2/', 'task-list', 'https://yougile.com/api-v2/task-list'],
  ['https://yougile.com/api-v2', '/task-list', 'https://yougile.com/api-v2/task-list'],
  ['https://yougile.com/api-v2/', '/task-list', 'https://yougile.com/api-v2/task-list'],
  ['https://proxy.example/custom', '/task-list?limit=1&offset=2', 'https://proxy.example/custom/task-list?limit=1&offset=2']
];

for (const [host, requestPath, expected] of cases) {
  assert.equal(requestHelper.buildYougileApiUrl(host, requestPath), expected, `${host} + ${requestPath}`);
}

let observedUrl;
const server = createServer((request, response) => {
  observedUrl = request.url;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"ok":true}');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
try {
  const address = server.address();
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.YOUGILE_API_HOST_URL = `http://127.0.0.1:${address.port}/api-v2`;
  process.env.YOUGILE_API_KEY = 'benchmark-placeholder';
  await requestHelper.makeYougileRequest('GET', '/task-list?limit=1');
  assert.equal(observedUrl, '/api-v2/task-list?limit=1', 'makeYougileRequest must use buildYougileApiUrl');
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

process.stdout.write('ponytail_pi_ab_hidden_grader=pass\n');
