import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = '0.153.4';
const files = {
  'thread/list': 'v2/ThreadListResponse.json',
  'thread/read': 'v2/ThreadReadResponse.json',
  'account/read': 'v2/GetAccountResponse.json',
  'model/list:request': 'v2/ModelListParams.json',
  'model/list:response': 'v2/ModelListResponse.json',
  'thread/settings/update:request': 'v2/ThreadSettingsUpdateParams.json',
  'thread/settings/update:response': 'v2/ThreadSettingsUpdateResponse.json',
  'thread/settings/updated': 'v2/ThreadSettingsUpdatedNotification.json',
  'skills/list:request': 'v2/SkillsListParams.json',
  'skills/list:response': 'v2/SkillsListResponse.json',
  'mcpServerStatus/list:request': 'v2/ListMcpServerStatusParams.json',
  'mcpServerStatus/list:response': 'v2/ListMcpServerStatusResponse.json',
  'thread/fork:request': 'v2/ThreadForkParams.json',
  'thread/fork:response': 'v2/ThreadForkResponse.json',
  'thread/compact/start:request': 'v2/ThreadCompactStartParams.json',
  'thread/compact/start:response': 'v2/ThreadCompactStartResponse.json',
  'thread/start:request': 'v2/ThreadStartParams.json',
  'thread/start:response': 'v2/ThreadStartResponse.json',
  'thread/resume:request': 'v2/ThreadResumeParams.json',
  'thread/resume:response': 'v2/ThreadResumeResponse.json',
  'turn/start:request': 'v2/TurnStartParams.json',
  'turn/start:response': 'v2/TurnStartResponse.json',
  'turn/steer:request': 'v2/TurnSteerParams.json',
  'turn/steer:response': 'v2/TurnSteerResponse.json',
  'turn/interrupt:request': 'v2/TurnInterruptParams.json',
  'turn/interrupt:response': 'v2/TurnInterruptResponse.json',
  'item/commandExecution/requestApproval:response': 'CommandExecutionRequestApprovalResponse.json',
  'item/fileChange/requestApproval:response': 'FileChangeRequestApprovalResponse.json',
  'item/tool/requestUserInput:response': 'ToolRequestUserInputResponse.json',
  'thread/tokenUsage/updated': 'v2/ThreadTokenUsageUpdatedNotification.json',
  'thread/started': 'v2/ThreadStartedNotification.json',
  'remoteControl/status/changed': 'v2/RemoteControlStatusChangedNotification.json',
  'error': 'v2/ErrorNotification.json',
  'turn/started': 'v2/TurnStartedNotification.json',
  'turn/completed': 'v2/TurnCompletedNotification.json',
  'item/started': 'v2/ItemStartedNotification.json',
  'item/completed': 'v2/ItemCompletedNotification.json',
  'item/agentMessage/delta': 'v2/AgentMessageDeltaNotification.json',
  'item/reasoning/textDelta': 'v2/ReasoningTextDeltaNotification.json',
  'item/reasoning/summaryTextDelta': 'v2/ReasoningSummaryTextDeltaNotification.json',
  'serverRequest/resolved': 'v2/ServerRequestResolvedNotification.json',
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalParams.json',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalParams.json',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalParams.json',
  'item/tool/requestUserInput': 'ToolRequestUserInputParams.json',
  'mcpServer/elicitation/request': 'McpServerElicitationRequestParams.json',
  'execCommandApproval': 'ExecCommandApprovalParams.json',
  'applyPatchApproval': 'ApplyPatchApprovalParams.json',
};
const binary = process.argv[2] ?? 'codex';
const temp = mkdtempSync(join(tmpdir(), 'pi-web-codex-schema-'));
try {
  const home = join(temp, 'home');
  const output = join(temp, 'schema');
  mkdirSync(home);
  mkdirSync(join(home, '.codex'));
  mkdirSync(output);
  const options = { env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 };
  const actual = execFileSync(binary, ['--version'], options).trim();
  if (actual !== `codex-cli ${version}`) throw new Error('Unsupported Codex CLI version');
  execFileSync(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', output], options);
  const schemas = Object.fromEntries(Object.entries(files).map(([method, file]) => [method, JSON.parse(readFileSync(join(output, file), 'utf8'))]));
  writeFileSync(fileURLToPath(new URL('./schemas.json', import.meta.url)), `${JSON.stringify({ version, schemas })}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
