import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { createJiti } from 'jiti';
import { isolateClaudeHome, isolatePiHome } from '../lib/claude-test-home.mjs';

const home=await mkdtemp(join(tmpdir(),'codex-operations-ui-'));process.env.HOME=home;test.after(()=>rm(home,{recursive:true,force:true}));
await isolateClaudeHome();await isolatePiHome();
const {shouldHandleWebSlashCommand}=await createJiti(import.meta.url,{tsconfigPaths:true}).import('../lib/agent-backends.ts');
const text=await readFile(new URL('./useAgentSession.ts',import.meta.url),'utf8');
const file=ts.createSourceFile('useAgentSession.ts',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function callback(name){let found;const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)===name&&node.initializer&&ts.isCallExpression(node.initializer))found=node.initializer.arguments[0];else ts.forEachChild(node,visit);};visit(file);assert(found,name);const js=ts.transpileModule('('+found.getText(file)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.trim().replace(/;$/,'');return new Function('scope',`with(scope){return ${js};}`);}
const makeCommand=callback('handleBuiltinSlashCommand'),makeCompact=callback('handleCompact');
function fixture(){
 let resolve,reject;const pending=new Promise((a,b)=>{resolve=a;reject=b;});const calls={commands:[],opened:[],notices:[],loads:[],forked:[],fetches:[],results:[],errors:[],busy:[]};
 const scope={backendRef:{current:'codex'},sessionIdRef:{current:'codex:01900000-0000-7000-8000-000000000001'},capabilities:{compact:true,mcp:true,fork:true,side:false},isCompacting:false,shouldHandleWebSlashCommand,
   createRequestId:()=> '00000000-0000-4000-8000-000000000001',ensureNewSession:()=>{throw Error('must not start a session');},addNotice:n=>calls.notices.push(n),onOpenSettings:s=>calls.opened.push(s),
   sendAgentCommand:(id,command)=>{calls.commands.push({id,command});return pending;},setIsCompacting:b=>calls.busy.push(b),setCompactError:e=>calls.errors.push(e),setCompactResult:r=>calls.results.push(r),readCompactResult:()=>null,
   loadSession:async id=>{calls.loads.push(id);return true;},promoteNewSession:()=>{},opts:{},agentRunningRef:{current:false},bashRunningRef:{current:false},activeLeafId:'should-not-be-sent',onSessionForked:id=>calls.forked.push(id),
   fetch:async(url,init)=>{calls.fetches.push({url,init});return{ok:true,json:async()=>({sessionId:'codex:01900000-0000-7000-8000-000000000002'})};},
 };
 scope.handleCompact=makeCompact(scope);return{scope,calls,run:makeCommand(scope),resolve,reject};
}
test('native /mcp opens the readonly panel without Pi command discovery, thread creation or a prompt',async()=>{
 const{run,calls}=fixture();assert.deepEqual(await run('/mcp'),{handled:true,action:'openSettings'});assert.deepEqual(calls.opened,['mcp']);assert.deepEqual(calls.commands,[]);assert.deepEqual(calls.notices,[]);
});
test('native MCP subcommands and auto-compact are visibly refused without a Pi write',async()=>{
 for(const command of ['/mcp login docs','/mcp reconnect','/auto-compact']){const{run,calls}=fixture();const result=await run(command);assert.equal(result.handled,true);assert.equal(typeof result.error,'string');assert.deepEqual(calls.commands,[]);assert.deepEqual(calls.opened,[]);}
});
test('native /compact detaches its blocking command and shows no success before settlement',async()=>{
 const{run,calls,resolve}=fixture();assert.deepEqual(await run('/compact'),{handled:true,action:'compact'});assert.deepEqual(calls.busy,[true]);assert.deepEqual(calls.loads,[]);assert.deepEqual(calls.results,[null]);assert.equal(calls.commands[0].command.type,'compact');resolve({turnId:'compact'});await new Promise(setImmediate);assert.equal(calls.loads.length,1);assert.deepEqual(calls.busy,[true,false]);assert.deepEqual(calls.notices,[]);
});
test('native compact uncertainty stays visible and performs no replay or history success',async()=>{
 const{run,calls,reject}=fixture();await run('/compact');reject(Error('Native compaction outcome is unknown'));await new Promise(setImmediate);assert.equal(calls.errors.at(-1),'Native compaction outcome is unknown');assert.equal(calls.commands.length,1);assert.deepEqual(calls.loads,[]);
});
test('a native compact response for a previous session cannot reload it over the selected session',async()=>{
 const{run,scope,calls,resolve}=fixture();await run('/compact');scope.sessionIdRef.current='another-session';resolve({turnId:'compact'});await new Promise(setImmediate);assert.deepEqual(calls.loads,[]);assert.deepEqual(calls.busy,[true]);assert.deepEqual(calls.results,[null]);
});
test('native clone uses the whole-thread fork endpoint without entry or custom options',async()=>{
 const{run,calls}=fixture();assert.equal((await run('/clone')).handled,true);assert.equal(calls.fetches.length,1);assert.equal(calls.fetches[0].init.body,'{}');assert.match(calls.fetches[0].url,/codex%3A.*\/fork$/);assert.equal(calls.forked.length,1);assert.deepEqual(calls.commands,[]);
});
test('native clone lost response is surfaced and not automatically resent',async()=>{
 const{run,scope,calls}=fixture();scope.fetch=async()=>{calls.fetches.push(1);return{ok:false,json:async()=>({error:'Native fork outcome is unknown',operation:'fork'})};};assert.equal((await run('/clone')).error,'Native fork outcome is unknown');assert.equal(calls.fetches.length,1);assert.deepEqual(calls.forked,[]);
});
test('native message forks and compaction cancellation controls stay unavailable while sidebar fork remains supported',async()=>{
 const window=await readFile(new URL('../components/ChatWindow.tsx',import.meta.url),'utf8');const input=await readFile(new URL('../components/ChatInput.tsx',import.meta.url),'utf8');
 assert.match(window,/onFork: backend !== "codex" && capabilities\.fork/);assert.match(window,/onAbortCompaction=\{backend === "codex" \? undefined/);assert.match(input,/disabled=\{isCompacting && !onAbortCompaction\}/);assert.match(input,/backend === "codex" && command\.name === "auto-compact"/);
});
