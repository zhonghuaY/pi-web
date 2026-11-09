import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createJiti } from 'jiti';
import { isolateClaudeHome, isolatePiHome } from '../claude-test-home.mjs';

const isolatedHome = await mkdtemp(join(tmpdir(), 'codex-operations-home-'));
process.env.HOME = isolatedHome;
after(() => rm(isolatedHome, { recursive: true, force: true }));
await isolateClaudeHome();
await isolatePiHome();
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const actor = await jiti.import('./codex.ts');
const { sessions } = await jiti.import('../backend-service/index.ts');
const { projectCodexSessionInfo } = await jiti.import('./codex/projection.ts');
const { GET: inventoryRoute } = await jiti.import('../../app/api/agent/inventory/route.ts');
const { POST: forkRoute } = await jiti.import('../../app/api/sessions/[id]/fork/route.ts');
const { allowFileRoot } = await jiti.import('../file-access.ts');
const { CodexTransport } = await jiti.import('./codex/internal/transport.ts');
const sourceId = '01900000-0000-7000-8000-000000000001';
const targetId = '01900000-0000-7000-8000-000000000002';

async function fixture(fn, mode = '') {
  const dir = await mkdtemp(join(tmpdir(), 'codex-operations-'));
  const binary = join(dir, 'codex');
  const log = join(dir, 'requests.jsonl');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs'), rl = require('node:readline');
if(process.argv[2] === '--version') { console.log('codex-cli 0.153.4'); process.exit(); }
const mode = process.env.MODE, cwd = process.env.TEST_CWD;
const old = { id: 'old', status: 'completed', items: [] };
const thread = { id: '${sourceId}', sessionId: '${sourceId}', preview: 'source', ephemeral: false, projectId: null, modelProvider: 'test', createdAt: 1, updatedAt: 2, cwd, cliVersion: '0.153.4', source: 'cli', status: { type: 'idle' }, turns: [old] };
const response = { thread, approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd, model: 'test', modelProvider: 'test', reasoningEffort: 'ultra', sandbox: { type: 'readOnly' } };
const send = x => console.log(JSON.stringify(x));
let compacted = false;
const event = (method, params) => send({ method, params });
rl.createInterface({ input: process.stdin }).on('line', line => {
 const q = JSON.parse(line); fs.appendFileSync(process.env.TEST_LOG, JSON.stringify({ pid:process.pid, ...q }) + '\\n');
 if(!('id' in q))return;
 const done = result => send({ id:q.id, result });
 if(q.method === 'initialize') {
   const initialized = () => done({ userAgent:'test', codexHome:process.env.CODEX_HOME, platformFamily:'unix', platformOs:'test' });
   if (mode === 'slow-initialize') return setTimeout(initialized, 600);
   return initialized();
 }
 if(q.method === 'thread/start' || q.method === 'thread/resume')return done(response);
 if(q.method === 'thread/read') {
   const turns = compacted && mode !== 'unpersisted' ? [old, { id:'compact', status:'completed', items:[{ id:'compaction', type:'contextCompaction' }] }] : [old];
   return done({ thread:{ ...thread, turns } });
 }
 if(q.method === 'skills/list') {
   if(mode === 'skills-missing')return done({ data:[] });
   const paths = [process.env.OTHER_CWD, ...q.params.cwds];
   return done({ data:paths.map(p => ({ cwd:fs.realpathSync(p), errors:[{ path:p+'/bad/SKILL.md',message:'missing name' }], skills:[{ name:p===cwd?'local':'other',description:'native skill',enabled:true,path:p+'/SKILL.md',scope:'repo',interface:{ displayName:'Native' },pluginId:'plugin-test' }] })) });
 }
 if(q.method === 'mcpServerStatus/list') {
   const statuses = ['notStarted','starting','connected','authenticationRequired','failed',null];
   const n = q.params.cursor ? Number(q.params.cursor) : 0;
   const server = { name:'server-'+n,authStatus:'unsupported',runtimeStatus:statuses[n],tools:{ tool:{ name:'search',description:'docs',inputSchema:{ default:'SECRET_SCHEMA' } } },resources:[{name:'guide',uri:'https://user:SECRET_URI@example.test/private?token=SECRET_QUERY',description:'manual'}],resourceTemplates:[{name:'pages',uriTemplate:'SECRET_TEMPLATE'}],config:{ token:'SECRET_CONFIG' } };
   return done({ data:[server],nextCursor:mode==='mcp-cycle'?'1':n===5?null:String(n+1) });
 }
 if(q.method === 'thread/fork') {
   if(mode === 'fork-lost')return process.exit(1);
   return setTimeout(() => done({ ...response,thread:{ ...thread,id:'${targetId}',sessionId:'${targetId}',forkedFromId:thread.id } }),50);
 }
 if(q.method === 'thread/compact/start') {
   if(mode === 'exit-before-ack')return process.exit(1);
   if(mode === 'reject')return send({ id:q.id,error:{ code:-32602,message:'rejected' } });
   if(mode === 'ack-only')return done({});
   if(mode === 'exit-after-ack') {done({});return setTimeout(()=>process.exit(1),10);}
   const tid = mode==='stale'?'old':'compact';
   const id = mode==='wrong-thread'?'01900000-0000-7000-8000-000000000099':thread.id;
   const turn = { id:tid,status:'inProgress',items:[] };
   event('turn/started',{threadId:id,turn});
   event('turn/completed',{threadId:thread.id,turn:{ id:'wrong-turn',status:'completed',items:[] }});
   event('item/completed',{threadId:id,turnId:tid,item:{type:'contextCompaction',id:'compaction'},completedAtMs:1});
   const finish = () => { compacted=true;event('turn/completed',{threadId:id,turn:{ ...turn,status:mode==='failed'?'failed':'completed' }}); };
   if(mode==='delayed') { done({});return setTimeout(finish,100); }
   finish();return setTimeout(()=>done({}),20);
 }
 if(q.method === 'turn/start')return done({ turn:{id:'prompt',status:'inProgress',items:[]} });
});
`);
  await chmod(binary, 0o700);
  const other = join(dir, 'other'); await mkdir(other);
  const options = { binary, requestTimeoutMs: 5000, env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: join(dir, 'native'), TEST_CWD:dir, TEST_LOG:log, OTHER_CWD:other, MODE:mode } };
  let source;
  try {
    const created = await actor.createCodexSession({ cwd:dir,requestId:randomUUID() },options);
    const phases = created.ok ? '' : await readFile(log, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).method).join(',')).catch(() => '(no native request)');
    assert.equal(created.ok,true,`fixture create failed before compact; native requests: ${phases}; result: ${JSON.stringify(created)}`); source=created.value;
    options.requestTimeoutMs = ['ack-only', 'stale', 'wrong-thread', 'unpersisted'].includes(mode) ? 350 : 5000;
    await fn({dir,other,options,log,source});
  } finally { if(source)await actor.shutdownCodexSession(source);await rm(dir,{recursive:true,force:true}); }
}

const requests = async log => (await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);

test('skills select canonical requested cwd, preserve provenance/diagnostics and never create a native thread', async () => {
  await fixture(async ({dir,other,options,log,source}) => {
    const first = await actor.codexSkills(dir,source);
    assert.equal(first.ok,true,JSON.stringify(first));
    assert.equal(first.value.skills[0].name,'local'); assert.equal(first.value.skills[0].pluginId,'plugin-test');
    assert.equal(first.value.diagnostics[0].message,'missing name');
    options.env.OTHER_CWD=dir;
    const second = await actor.codexSkills(other,undefined,options);
    assert.equal(second.ok,true,JSON.stringify(second)); assert.equal(second.value.skills[0].name,'other');
    assert.equal((await actor.codexSkills(join(dir,'missing'),undefined,options)).ok,false);
    assert.equal((await actor.codexSkills(other,source)).error.kind,'invalid');
    assert.equal((await requests(log)).filter(q=>q.method==='thread/start').length,1);
  });
});
test('skills missing native cwd group fails closed without a Pi list', async()=>fixture(async({dir,source})=>{
  assert.equal((await actor.codexSkills(dir,source)).ok,false);
},'skills-missing'));

test('MCP inventory uses source process, paginates statuses, and strips config, schema and resource references',async()=>fixture(async({source,log})=>{
  const result=await actor.codexMcp(source);assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.value.servers.map(s=>s.status),['absent','starting','connected','auth-required','failed','unknown']);
  assert.equal(result.value.servers[2].tools[0].name,'search');assert.equal(result.value.servers[2].resources[0].name,'guide');
  assert.equal(JSON.stringify(result).includes('SECRET'),false);
  const rows=await requests(log), pid=rows.find(q=>q.method==='thread/start').pid;
  for(const q of rows.filter(q=>q.method==='mcpServerStatus/list')) {assert.equal(q.pid,pid);assert.equal(q.params.threadId,sourceId);assert.equal(q.params.detail,'full');}
}));
test('MCP cursor cycles fail rather than returning a partial success',async()=>fixture(async({source})=>assert.equal((await actor.codexMcp(source)).ok,false),'mcp-cycle'));

test('fork reserves source admission, uses another process, returns native target, and leaves source runnable',async()=>fixture(async({source,log})=>{
  const pending=actor.forkCodexSession(source);
  assert.equal((await actor.promptCodexSession(source,{requestId:randomUUID(),message:'blocked'})).error.kind,'conflict');
  assert.equal((await actor.updateCodexSettings(source,{model:'test',effort:'ultra'})).error.kind,'conflict');
  assert.equal((await actor.compactCodexSession(source)).error.kind,'conflict');
  const result=await pending;assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.id,targetId);
  assert.equal(source.state.kind,'ready');assert.equal(source.state.threadId,sourceId);
  const rows=await requests(log);assert.notEqual(rows.find(q=>q.method==='thread/fork').pid,rows.find(q=>q.method==='thread/start').pid);
  assert.deepEqual(rows.find(q=>q.method==='thread/fork').params.config,{model_reasoning_effort:'ultra'});
  assert.equal((await actor.promptCodexSession(source,{requestId:randomUUID(),message:'still source'})).ok,true);
}));
test('handoff capture excludes fork and compact before dispatch and releases for later work', async () => {
  await fixture(async ({ source, log }) => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const capture = actor.withCodexHandoffSnapshot(source.sessionId, async () => held);
    try {
      for (const mutation of [actor.forkCodexSession, actor.compactCodexSession]) {
        const result = await mutation(source);
        assert.equal(result.ok, false);
        assert.equal(result.error.kind, 'conflict');
      }
      assert.equal((await requests(log)).filter(q => ['thread/fork', 'thread/compact/start'].includes(q.method)).length, 0);
    } finally { release('captured'); }
    assert.equal(await capture, 'captured');
    const forked = await actor.forkCodexSession(source);
    assert.equal(forked.ok, true, JSON.stringify(forked));
    const compacted = await actor.compactCodexSession(source);
    assert.equal(compacted.ok, true, JSON.stringify({ compacted, nativeRequests: (await requests(log)).map(row => row.method) }));
  });
});

for (const [name, mutation] of [['fork', actor.forkCodexSession], ['compact', actor.compactCodexSession]]) {
  test(`${name} holds source admission until settlement before a handoff capture`, async () => {
    await fixture(async ({ source }) => {
      const pending = mutation(source);
      await assert.rejects(
        actor.withCodexHandoffSnapshot(source.sessionId, async () => 'must not capture'),
        error => error.reason === 'source-busy',
      );
      assert.equal((await pending).ok, true);
      assert.equal(await actor.withCodexHandoffSnapshot(source.sessionId, async () => 'captured after settlement'), 'captured after settlement');
    }, 'delayed');
  });
}

test('lost fork response is fork uncertainty and never automatically retried',async()=>fixture(async({source,log})=>{
  assert.deepEqual((await actor.forkCodexSession(source)).error,{kind:'outcome-unknown',operation:'fork'});
  assert.equal((await requests(log)).filter(q=>q.method==='thread/fork').length,1);assert.equal(source.state.kind,'ready');
},'fork-lost'));

test('compact setup tolerates slow native initialization while still verifying persisted lifecycle', async () => fixture(async ({ source, log }) => {
  const result = await actor.compactCodexSession(source);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.turnId, 'compact');
  const methods = (await requests(log)).map(q => q.method);
  assert(methods.indexOf('initialize') < methods.indexOf('thread/start'));
  assert(methods.indexOf('thread/start') < methods.indexOf('thread/compact/start'));
  assert.equal(methods.filter(method => method === 'thread/read').length, 2);
}, 'slow-initialize'));

test('active compaction cannot be reaped', async t => fixture(async ({ source }) => {
  const unsubscribe = actor.subscribeCodexSession(source, () => {});
  const pending = actor.compactCodexSession(source);
  unsubscribe();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try { t.mock.timers.tick(600000); assert.equal(actor.getCodexSession(source.sessionId), source); }
  finally { t.mock.timers.reset(); }
  assert.equal((await pending).ok, true);
}, 'delayed'));

test('compact notification before ack settles only after matching persisted compaction, preserving settings',async()=>fixture(async({source,log})=>{
 const events=[];actor.subscribeCodexSession(source,e=>events.push(e));const before=actor.codexSessionState(source).settings;
 const pending=actor.compactCodexSession(source);
 assert.equal(actor.codexSessionState(source).isCompacting,true);
 const replay=[];actor.subscribeCodexSession(source,e=>replay.push(e));assert.equal(replay[1].type,'compaction_start');
 assert.equal((await actor.compactCodexSession(source)).error.kind,'conflict');
 assert.equal((await actor.promptCodexSession(source,{requestId:randomUUID(),message:'blocked'})).error.kind,'conflict');
 assert.equal((await actor.updateCodexSettings(source,{model:'test',effort:'ultra'})).error.kind,'conflict');
 assert.equal((await actor.forkCodexSession(source)).error.kind,'conflict');
 assert.equal((await actor.stopCodexSession(source)).error.kind,'conflict');
 const result=await pending;assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.value.turnId,'compact');
 assert.equal(actor.codexSessionState(source).isCompacting,false);assert.deepEqual(actor.codexSessionState(source).settings,before);
 assert.deepEqual(events.map(e=>e.type),['session_settings','compaction_start','compaction_end']);
 assert.equal((await requests(log)).filter(q=>q.method==='thread/compact/start').length,1);
}));
test('compact ack alone remains pending until actual lifecycle and history',async()=>fixture(async({source})=>{
 let settled=false;const pending=actor.compactCodexSession(source).then(r=>{settled=true;return r;});
 await new Promise(resolve=>setTimeout(resolve,60));assert.equal(settled,false);assert.equal(actor.codexSessionState(source).isCompacting,true);
 assert.equal((await pending).ok,true);
},'delayed'));
for(const mode of ['ack-only','stale','wrong-thread','unpersisted','exit-before-ack','exit-after-ack'])test(`compact ${mode} cannot report success or replay`,async()=>fixture(async({source,log})=>{
 const result=await actor.compactCodexSession(source);assert.deepEqual(result.error,{kind:'outcome-unknown',operation:'compact'});
 assert.equal(actor.getCodexSession(source.sessionId),undefined);
 assert.equal((await requests(log)).filter(q=>q.method==='thread/compact/start').length,1);
},mode));
test('native compaction failure ends visibly without success and permits subsequent admission',async()=>fixture(async({source})=>{
 const result=await actor.compactCodexSession(source);assert.equal(result.ok,false);assert.equal(result.error.kind,'conflict');
 assert.equal(actor.codexSessionState(source).isCompacting,false);assert.equal(source.state.kind,'ready');
},'failed'));
test('shutdown settles a pending compaction and resume starts a fresh operation generation',async()=>fixture(async({source,options})=>{
 const events=[];actor.subscribeCodexSession(source,event=>events.push(event));
 const pending=actor.compactCodexSession(source);await new Promise(resolve=>setTimeout(resolve,60));await actor.shutdownCodexSession(source);
 assert.equal(events.filter(e=>e.type==='compaction_end').length,1);assert(events.findIndex(e=>e.type==='compaction_end')<events.findIndex(e=>e.type==='session_shutdown'));
 assert.equal((await pending).error.operation,'compact');const resumed=await actor.ensureCodexSession(source.sessionId,{...options,requestTimeoutMs:5000});assert.equal(resumed.ok,true);assert.equal(actor.codexSessionState(resumed.value).isCompacting,false);await actor.shutdownCodexSession(resumed.value);
},'ack-only'));

test('facade refuses unsupported fork/compact options and MCP does not resume a closed native session',async()=>fixture(async({source,dir})=>{
 process.env.PI_WEB_CODEX='1';
 for(const body of [{side:true},{entryId:'x'},{forkAtEntry:'x'},{name:'custom'},{extra:true}]) {
  const result=await sessions.fork({id:source.sessionId,side:body.side===true,body});assert.equal(result.kind,'native');assert.equal(result.status,400);
 }
 for(const body of [{type:'compact',customInstructions:'ignored?'},{type:'compact',cancel:true},{type:'abort_compaction'}])assert.equal((await sessions.commandRuntime(source.sessionId,body)).status,400);
 process.env.PI_WEB_CODEX='1';allowFileRoot(dir);
 const skills=await sessions.inventory({backend:'codex',kind:'skills',cwd:dir,sessionId:source.sessionId});assert.equal(skills.status,200);
 const fork=await sessions.fork({id:source.sessionId,side:false,body:{}});assert.equal(fork.status,200);assert.equal(fork.body.sessionId,`codex:${targetId}`);assert.equal(fork.body.session.relation.originSessionId,source.sessionId);assert.equal(typeof fork.body.session.projectKey,'string');assert.equal(fork.body.session.projectRoot,dir);
 await actor.shutdownCodexSession(source);
 const status=await sessions.inventory({backend:'codex',kind:'mcp',sessionId:source.sessionId});assert.equal(status.status,409);
 process.env.PI_WEB_CODEX='0';
}));

test('native routes preserve security/no-store and refuse malformed/unsupported scopes before starting anything',async()=>fixture(async({source,dir})=>{
 process.env.PI_WEB_CODEX='1';allowFileRoot(dir);
 const get = query => inventoryRoute(new Request('http://localhost/api/agent/inventory?'+query,{headers:{host:'localhost'}}));
 const skills=await get(new URLSearchParams({backend:'codex',kind:'skills',cwd:dir,sessionId:source.sessionId}));assert.equal(skills.status,200);assert.equal(skills.headers.get('cache-control'),'no-store');assert.equal((await skills.json()).backend,'codex');
 const mcp=await get(new URLSearchParams({backend:'codex',kind:'mcp',sessionId:source.sessionId}));assert.equal(mcp.status,200);assert.equal(mcp.headers.get('cache-control'),'no-store');
 for(const query of ['backend=pi&kind=skills&cwd='+dir,'backend=codex&kind=mcp','backend=codex&kind=skills&cwd='+dir+'&content=true','backend=codex&kind=mcp&sessionId='+source.sessionId+'&sessionId='+source.sessionId])assert.equal((await get(query)).status,400);
 const denied=await inventoryRoute(new Request('http://localhost/api/agent/inventory?backend=codex&kind=skills&cwd='+dir,{headers:{host:'attacker.invalid'}}));assert.equal(denied.status,403);
 const malformedUrl = await inventoryRoute({ url: 'not a URL', headers: new Headers({ host: 'localhost' }) });assert.equal(malformedUrl.status,400);
 const post=body=>forkRoute(new Request('http://localhost/api/sessions/'+source.sessionId+'/fork',{method:'POST',headers:{host:'localhost','Content-Type':'application/json'},body}),{params:Promise.resolve({id:source.sessionId})});
 for(const body of ['null','[]','false','broken','{"entryId":"old"}','{"name":"custom"}','{"side":true}']){const response=await post(body);assert.equal(response.status,400,body);assert.equal(response.headers.get('cache-control'),'no-store');}
 const fork=await post('{}');assert.equal(fork.status,200);assert.equal(fork.headers.get('cache-control'),'no-store');assert.equal((await fork.json()).sessionId,`codex:${targetId}`);
 process.env.PI_WEB_CODEX='0';
}));

const nativeBinary = process.env.UNIT8_NATIVE_BINARY;
test('copied native CLI: cwd skills, fork bytes/settings/live-source identity and correlated compact survive resume',{skip:!nativeBinary},async()=>{
 assert.equal((await lstat(nativeBinary)).isFile(),true);
 assert.equal(createHash('sha256').update(await readFile(nativeBinary)).digest('hex'),'88ecd2cbf8044832a49e7710394d9d328f7205fa5e8c8ebbdd015e002b4f6e21');
 const dir=await mkdtemp(join(tmpdir(),'codex-operations-native-'));let source,resumed;
 const server=createServer(async(req,res)=>{
   let body='';for await(const chunk of req)body+=chunk;
   if(req.url?.endsWith('/models')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'mock'}]}));}
   if(body)JSON.parse(body);
   if(req.url?.includes('/compact')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({output:[{type:'compaction',encrypted_content:'native-local-summary'}]}));}
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   for(const event of [ {type:'response.created',response:{id:'r',status:'in_progress',output:[]}}, {type:'response.output_item.added',output_index:0,item:{id:'answer',type:'message',role:'assistant',content:[]}}, {type:'response.output_text.delta',item_id:'answer',output_index:0,content_index:0,delta:'Native local reply'}, {type:'response.output_item.done',output_index:0,item:{id:'answer',type:'message',role:'assistant',content:[{type:'output_text',text:'Native local reply'}]}}, {type:'response.completed',response:{id:'r',status:'completed',output:[],usage:{input_tokens:50,output_tokens:5,total_tokens:55}}}])res.write('data: '+JSON.stringify(event)+'\n\n');
   res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const cwd=join(dir,'project'),other=join(dir,'other'),nativeHome=join(dir,'codex');
  await mkdir(nativeHome);for(const [p,name] of [[cwd,'source-skill'],[other,'other-skill']]){await mkdir(join(p,'.agents','skills',name),{recursive:true});await writeFile(join(p,'.agents','skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: native test skill\n---\nInstructions.\n`);}
  await writeFile(join(nativeHome,'config.toml'),`model = "gpt-5.6-sol"\nmodel_provider = "local"\nmodel_reasoning_effort = "low"\n[model_providers.local]\nname = "local"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n[projects.${JSON.stringify(other)}]\ntrust_level = "trusted"\n`);
  if (process.env.UNIT8_NATIVE_MCP === '1') await writeFile(join(nativeHome,'config.toml'), (await readFile(join(nativeHome,'config.toml'),'utf8')) + '\n[mcp_servers.official_mcp_docs]\nurl = "https://modelcontextprotocol.io/mcp"\nstartup_timeout_sec = 20\n');
  const options={binary:nativeBinary,env:{PATH:process.env.PATH,HOME:dir,CODEX_HOME:nativeHome}};
  const created=await actor.createCodexSession({cwd,requestId:randomUUID(),model:'gpt-5.6-sol',effort:'ultra'},options);assert.equal(created.ok,true,JSON.stringify(created));source=created.value;
  for(const [p,name] of [[cwd,'source-skill'],[other,'other-skill']]){const result=await actor.codexSkills(p,p===cwd?source:undefined,options);assert.equal(result.ok,true,JSON.stringify(result));assert(result.value.skills.some(s=>s.name===name));assert(!result.value.skills.some(s=>s.name===(p===cwd?'other-skill':'source-skill')));}
  let mcp=await actor.codexMcp(source);
  if(process.env.UNIT8_NATIVE_MCP === '1') {
    const until=Date.now()+25000;
    while((!mcp.ok || mcp.value.servers.find(s=>s.name==='official_mcp_docs')?.status!=='connected') && Date.now()<until){await new Promise(resolve=>setTimeout(resolve,200));mcp=await actor.codexMcp(source);}
    assert.equal(mcp.ok,true,JSON.stringify(mcp));const docs=mcp.value.servers.find(s=>s.name==='official_mcp_docs');assert.equal(docs?.status,'connected',JSON.stringify(mcp));assert(docs.tools.some(t=>t.name==='search_model_context_protocol'));console.log(JSON.stringify({check:'product native official MCP inventory',status:docs.status,authStatus:docs.authStatus,tools:docs.tools.map(t=>t.name),credentialsSupplied:false}));
  }else {assert.equal(mcp.ok,true,JSON.stringify(mcp));assert.deepEqual(mcp.value.servers,[]);}
  const prompt=await actor.promptCodexSession(source,{requestId:randomUUID(),message:'Say local hello'});assert.equal(prompt.ok,true,JSON.stringify(prompt));assert.equal((await prompt.value.completion).kind,'completed');
  const read=await source.state.transport.request('thread/read',{threadId:source.state.threadId,includeTurns:true});
  const beforeBytes=await readFile(read.thread.path);const beforeHash=createHash('sha256').update(beforeBytes).digest('hex');const originalTransport=source.state.transport;
  const nativeRequest = CodexTransport.prototype.request;
  CodexTransport.prototype.request = async function(method, params, options) {
    const result = await nativeRequest.call(this, method, params, options);
    if (method === 'thread/fork') console.log(JSON.stringify({ check: 'native fork facts', requested: params, response: { threadId: result.thread?.id, cwd: result.thread?.cwd, model: result.model, provider: result.modelProvider, effort: result.reasoningEffort } }));
    return result;
  };
  const fork=await actor.forkCodexSession(source);CodexTransport.prototype.request=nativeRequest;assert.equal(fork.ok,true,JSON.stringify(fork));assert.notEqual(fork.value.id,source.state.threadId);assert.deepEqual(fork.value.turns,read.thread.turns);assert.equal(source.state.transport,originalTransport);
  assert.equal(createHash('sha256').update(await readFile(read.thread.path)).digest('hex'),beforeHash);
  const target=await actor.ensureCodexSession(`codex:${fork.value.id}`,options);assert.equal(target.ok,true,JSON.stringify(target));assert.deepEqual(actor.codexSessionState(target.value).settings,actor.codexSessionState(source).settings);
  const targetRead=await target.value.state.transport.request('thread/read',{threadId:fork.value.id,includeTurns:true});assert.equal(projectCodexSessionInfo(targetRead.thread).info.relation.originSessionId,source.sessionId);await actor.shutdownCodexSession(target.value);
  assert.equal(createHash('sha256').update(await readFile(read.thread.path)).digest('hex'),beforeHash);
  const compact=await actor.compactCodexSession(source);assert.equal(compact.ok,true,JSON.stringify(compact));
  await actor.shutdownCodexSession(source);const result=await actor.ensureCodexSession(source.sessionId,options);assert.equal(result.ok,true,JSON.stringify(result));resumed=result.value;
  const persisted=await resumed.state.transport.request('thread/read',{threadId:resumed.state.threadId,includeTurns:true});assert(persisted.thread.turns.some(t=>t.id===compact.value.turnId&&t.items.some(i=>i.type==='contextCompaction')));assert.equal(actor.codexSessionState(resumed).settings.effort,'ultra');
 } finally {if(source)await actor.shutdownCodexSession(source);if(resumed)await actor.shutdownCodexSession(resumed);await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
