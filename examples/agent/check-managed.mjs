import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Host } from '../../dist/src/host/host.js';
import { parseConfig } from '../../dist/src/host/config.js';
import { loadModules } from '../../dist/src/host/modules.js';
const [piCommand = 'pi', acpCommand = 'pi-acp', ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Usage: node examples/agent/check-managed.mjs [pi] [pi-acp]');
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const directory = await mkdtemp(join(tmpdir(), 'imbrex-real-pi-'));
const requests = [];
const server = createServer(async (req, res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
  res.writeHead(200, { 'content-type':'text/event-stream', 'cache-control':'no-cache' });
  const base={ id:'chatcmpl-fixture', object:'chat.completion.chunk', created:Math.floor(Date.now()/1000), model:body.model };
  res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:'Fixture response without sending.'},finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:6,total_tokens:106}})+'\n\n');
  res.end('data: [DONE]\n\n');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
process.env.IMBREX_FIXTURE_MODEL='fixture-model-credential';process.env.IMBREX_FIXTURE_AGENT='fixture-agent-credential';process.env.IMBREX_FIXTURE_ADMIN='fixture-admin-credential';
const principal=(id,permissions=[],token_env)=>({id,permissions,read_sources:[{prefix:'imbrex://qq/123456/main/'}],write_sources:[],invoke_capabilities:[],...(token_env?{token_env}:{})});
const raw={config_version:2,data_dir:join(directory,'data'),external_writes_enabled:false,principals:[principal('protocol'),principal('consumer',['events:read']),principal('agent',['events:read','capabilities:list','calls:read'],'IMBREX_FIXTURE_AGENT'),principal('admin',['admin:inspect','admin:operate'],'IMBREX_FIXTURE_ADMIN'),{...principal('writer',['events:read','events:write']),write_sources:[{prefix:'imbrex://qq/123456/main/'}]}],plugins:[
  ...[['http','server-http',{host:'127.0.0.1',port:0}],['rest','api-rest',{}],['mcp','adapter-mcp',{}],['admin','admin',{}]].map(([id,module,config])=>({id,module:'builtin:'+module,principal_id:'protocol',required:true,enabled:true,config})),
  {id:'agent',module:'builtin:agent-chat',principal_id:'consumer',required:true,enabled:true,config:{input_id:'fixture',source_prefix:'imbrex://qq/123456/main/',max_event_age_seconds:300,turn_timeout_ms:15000,agent:{command:acpCommand,args:[],cwd:directory,env_vars:[]},managed_pi:{provider:'fixture',model:'model-a',context_window:64000,system_prompt:'Initial controlled system instruction.',api:'openai-completions',base_url:'http://127.0.0.1:'+server.address().port+'/v1',api_key_env:'IMBREX_FIXTURE_MODEL',pi_command:piCommand,mcp_principal_id:'agent'}}}
]};
const config=parseConfig(raw,join(directory,'config.json'));const modules=await loadModules(config,join(directory,'config.json'));
let writer,app;
config.plugins.push({id:'writer',module:'fixture',principalId:'writer',required:true,enabled:true,config:{}});modules.set('writer',{apply(ctx){writer=ctx.imbrex.forPlugin(ctx);}});
const until=async(check,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(interrupted)throw new Error('Interrupted');if(await check())return;await delay(30);}throw new Error('Timeout: '+label+' '+JSON.stringify(app.plugins()));};
try{
 app=await Host.open(config,modules);
 const state=async()=>JSON.parse(await readFile(join(directory,'data/plugins/agent/consumer-state.json'),'utf8'));
 const headers={authorization:'Bearer '+process.env.IMBREX_FIXTURE_ADMIN,'content-type':'application/json'};
 const panel=async()=>{const r=await fetch('http://127.0.0.1:'+app.port+'/api/admin/panels/agent',{headers});return r.json();};
 const action=async(name,params)=>{const p=await panel();const r=await fetch('http://127.0.0.1:'+app.port+'/api/admin/panels/agent/actions/'+name,{method:'POST',headers,body:JSON.stringify({store_id:p.store_id,generation:p.generation,params})});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));assert.equal(body.result.status,'succeeded',JSON.stringify(body));return body;};
 const append=async(id)=>writer.events.append({event:{specversion:'1.0',datacontenttype:'application/json',source:'imbrex://qq/123456/main/group/987654',id:'message:'+id,type:'qq.message.group',time:new Date().toISOString(),data:{direction:'inbound',conversation_type:'group',account_id:'123456',identity_namespace:'main',conversation_id:'987654',sender_id:'654321',native_message_id:String(id),text:'Controlled input.'}}});
 await until(()=>app.plugins().find(p=>p.id==='agent').available,'available');
 await append(1);await until(async()=> (await state()).last_seq==='1','first turn');
 const before=await state();const beforeSession=Object.values(before.sessions)[0];const p=await panel();
 const saved=await action('save-agent-config',{revision:p.data.management.revision,settings:{model:'model-b',context_window:500000,system_prompt:'Changed controlled system instruction.'}});
 await action('restart-agent',{revision:saved.result.revision,reason:'Controlled restart verification'});
 await append(2);await until(async()=> (await state()).last_seq==='2','second turn');
 const after=await state();assert.equal(Object.values(after.sessions)[0],beforeSession);
 assert.deepEqual(requests.map(r=>r.model),['model-a','model-b']);
 assert.ok(JSON.stringify(requests[0].messages).includes('Initial controlled system instruction.'));
 assert.ok(JSON.stringify(requests[1].messages).includes('Changed controlled system instruction.'));
 assert.equal(after.management.pi.applied.context_window,500000);
 const runtime = await panel(); assert.equal(runtime.data.management.observed_models[beforeSession],'fixture/model-b');
 assert.equal(runtime.data.management.observed_usage[beforeSession].size,500000);
 process.stdout.write(JSON.stringify({result:'passed',requests:requests.length,models:requests.map(r=>r.model),session_preserved:true,prompt_changed:true,context_config:after.management.pi.applied.context_window,observed_context_size:runtime.data.management.observed_usage[beforeSession].size})+'\n');
}finally{await app?.close();server.closeAllConnections();await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
