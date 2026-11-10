import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createJiti } from 'jiti';
import { isolateClaudeHome } from '../../../claude-test-home.mjs';
await isolateClaudeHome();
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { CodexTransport, codexEnvironment } = await jiti.import('./transport.ts');

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  lines = [];
  exitCode = null;
  signalCode = null;
  stdin = new Writable({ write: (chunk, _, done) => { this.lines.push(JSON.parse(chunk.toString())); done(); } });
  kill(signal) { this.signalCode = signal; this.emit('exit', null, signal); this.emit('close', null, signal); return true; }
  exit() { this.exitCode = 1; this.emit('exit', 1, null); this.emit('close', 1, null); }
  send(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
}
const setup = options => { const child = new FakeChild(); const transport = new CodexTransport(child, { shutdownTimeoutMs: 1, ...options }); return { child, transport }; };
const kind = expected => error => error.kind === expected;

test('correlates out-of-order numeric and string ids across split and combined frames', async () => {
  const { child, transport } = setup();
  const one = transport.request('one', {}, { id: 8 });
  const two = transport.request('two', {}, { id: '8' });
  child.stdout.write('{"id":"8","res');
  child.stdout.write('ult":"second"}\n{"id":8,"result":"first"}\n{"id":8,"result":"duplicate"}\n');
  assert.equal(await one, 'first'); assert.equal(await two, 'second');
  await transport.shutdown();
});

test('reports an unexpected idle exit once and does not report intentional shutdown', async () => {
  const errors = [];
  const unexpected = setup({ onFailure: error => errors.push(error.kind) });
  unexpected.child.exit();
  await unexpected.transport.shutdown();
  assert.deepEqual(errors, ['exit']);
  const intentional = setup({ onFailure: error => errors.push(error.kind) });
  await intentional.transport.shutdown();
  assert.deepEqual(errors, ['exit']);
});

test('delivers unknown notifications without treating them as requests', async () => {
  const notifications = [];
  const { child, transport } = setup({ onNotification: event => notifications.push(event) });
  child.send({ method: 'future/notice', params: { value: 1 } });
  assert.equal(notifications[0].method, 'future/notice'); assert.deepEqual(child.lines, []);
  await transport.shutdown();
});

test('malformed JSON or envelopes fail pending requests and close the process', async () => {
  for (const line of ['not-json\n', '{"id":1}\n']) {
    const { child, transport } = setup(); const pending = transport.request('x', {});
    child.stdout.write(line); await assert.rejects(pending, kind('protocol'));
    assert.equal(child.signalCode, 'SIGKILL'); await transport.shutdown();
  }
});

test('server requests receive matching replies and unknown requests are refused', async () => {
  const { child, transport } = setup({ serverRequests: { approve: async () => ({ decision: 'decline' }) } });
  child.send({ id: 'server', method: 'approve', params: {} });
  child.send({ id: 2, method: 'unknown', params: {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.lines.find(x => x.id === 'server'), { id: 'server', result: { decision: 'decline' } });
  assert.deepEqual(child.lines.find(x => x.id === 2), { id: 2, error: { code: -32601, message: 'Unsupported server request' } });
  await transport.shutdown();
});

test('duplicate outstanding server request ids terminate the connection without double replies', async () => {
  let resolveApproval;
  let approvalSignal;
  const { child, transport } = setup({ serverRequests: { approve: (_, signal) => {
    approvalSignal = signal;
    return new Promise(resolve => { resolveApproval = resolve; });
  } } });
  child.send({ id: 'approval', method: 'approve' });
  await new Promise(resolve => setImmediate(resolve));
  const pending = transport.request('thread/read', {});
  child.send({ id: 'approval', method: 'approve' });
  await assert.rejects(pending, kind('protocol'));
  assert.equal(approvalSignal.aborted, true);
  resolveApproval({ decision: 'accept' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(child.lines.filter(line => line.id === 'approval'), []);
  assert.equal(child.signalCode, 'SIGKILL');
  await transport.shutdown();
});

test('preserves the JSON-RPC error code and message', async () => {
  const { child, transport } = setup();
  const request = transport.request('thread/read', {});
  child.send({ id: 1, error: { code: -32601, message: 'Method not found' } });
  await assert.rejects(request, error => error.kind === 'rpc' && error.code === -32601 && error.rpcMessage === 'Method not found');
  await transport.shutdown();
});

test('timeout, late reply, cancellation, and process exit settle requests', async () => {
  const { child, transport } = setup();
  const timeout = transport.request('once', {}, { id: 'timeout', timeoutMs: 5 });
  await assert.rejects(timeout, kind('timeout'));
  await assert.rejects(transport.request('once', {}, { id: 'timeout' }), kind('capacity'));
  child.send({ id: 'timeout', result: 'late' });
  const controller = new AbortController();
  const cancelled = transport.request('once', {}, { signal: controller.signal }); controller.abort();
  await assert.rejects(cancelled, kind('cancelled'));
  const pending = transport.request('once', {}); child.exit();
  await assert.rejects(pending, kind('exit'));
  assert.equal(child.lines.filter(x => x.method === 'once').length, 3);
  await transport.shutdown();
});

test('server interaction is aborted on process exit and no reply leaks afterwards', async () => {
  let signal;
  const { child, transport } = setup({ serverRequests: { wait: (_, s) => { signal = s; return new Promise(() => {}); } } });
  child.send({ id: 1, method: 'wait' }); await new Promise(resolve => setImmediate(resolve));
  child.exit(); assert.equal(signal.aborted, true); assert.deepEqual(child.lines, []);
  await transport.shutdown();
});

test('stderr stays bounded and shutdown is idempotent', async () => {
  const { child, transport } = setup(); child.stderr.write(Buffer.alloc(100_000, 65));
  assert.equal(transport.stderrBytes, 4096);
  const first = transport.shutdown(); const second = transport.shutdown();
  assert.equal(first, second); await first; assert.equal(child.signalCode, 'SIGTERM');
});

test('environment excludes Pi Web settings case-insensitively', () => {
  assert.deepEqual(codexEnvironment({ PATH: '/bin', PI_WEB_PASSWORD: 'secret', pi_web_other: 'secret', CODEX_HOME: '/tmp/codex' }), { PATH: '/bin', CODEX_HOME: '/tmp/codex' });
});
