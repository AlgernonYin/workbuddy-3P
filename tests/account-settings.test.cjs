"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const packages=require('../plugins/custom-api-models/scripts/profile-package.cjs');
const account=require('../plugins/custom-api-models/scripts/account-profile.cjs');
const script=path.resolve(__dirname,'../plugins/custom-api-models/scripts/sync-models.cjs');
const settingsScript=path.resolve(__dirname,'../plugins/custom-api-models/scripts/settings.cjs');
const canary='FAKE_GLOBAL_SETTINGS_KEY_CANARY';
const connection={kind:'workbuddy-account',origin:account.ORIGIN,accountId:'owner',credentials:{accessToken:'FAKE_ACCOUNT_TOKEN',refreshToken:'FAKE_REFRESH',expiresAt:Date.now()+3600000}};
function cfg(){return{mode:'explicit',enabled:'official',parameterPriority:'native',providers:{p:{baseUrl:'https://api.example.invalid/v1',apiKey:canary,extraModels:['m'],models:{m:{maxInputTokens:64000,supportsReasoning:true,compat:{thinkingFormat:'openai',supportsReasoningEffort:true},reasoning:{supportedEfforts:['low','high'],defaultEffort:'low',canDisableThinking:true},thinkingLevelMap:{low:'low',high:'high',off:'none'}}}}},routes:{'glm-5.1':'p:m'}};}
function fixture(t,{connectedOnly=false,partial=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb3p-global-settings-')),previousEnv={...process.env},priorFetch=global.fetch;
 for(const k of Object.keys(process.env))if(/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k))delete process.env[k];
 process.env.CODEBUDDY_CONFIG_DIR=dir;
 let remote={kind:'workbuddy-3p-private-profile',version:1,config:cfg(),accountSync:structuredClone(connection),accountRevision:'rev-0'},version='1.0.0',preflightHook;
 if(connectedOnly){fs.writeFileSync(account.connectionPath({dir}),JSON.stringify(connection));fs.writeFileSync(path.join(dir,'workbuddy-3p.json'),JSON.stringify(cfg()));}
 else fs.writeFileSync(account.cachePath({dir}),JSON.stringify({...remote,cloudVersion:version,cloudUid:'uid'}));
 const response=d=>new Response(JSON.stringify({code:0,data:d}));
 const calls=[];
 global.fetch=async(url,o={})=>{
  calls.push({url,method:o.method||'GET'});
  if(url.startsWith('https://test.cos.accelerate.myqcloud.com/')){assert.equal(o.headers,undefined);assert.equal(o.credentials,'omit');return new Response(packages.pack(remote,version));}
  assert.ok(url.startsWith(account.ORIGIN+'/v2/'));
  if(url.endsWith('/account'))return response({uid:'owner'});
  if(url.includes('/download-url'))return response({download_url:'https://test.cos.accelerate.myqcloud.com/private'});
  if(url.includes('/preflight')){preflightHook?.();return response({can_upload:true,need_confirmation:false});}
  if(o.method==='POST'&&url.endsWith('/content')){remote=packages.unpack(Buffer.from(await o.body.get('file').arrayBuffer()));version='1.0.'+(Number(version.split('.')[2])+1);return response({uid:'uid'});}
  if(url.includes('/content/uid?'))return response({uid:'uid',name:'workbuddy-3p-profile',version,status:'ready'});
  return response({items:[{uid:'uid',name:'workbuddy-3p-profile',entity_type:'skill',version,status:'ready'}],total:1});
 };
 const factory=require(settingsScript);
 if(partial)require.cache[settingsScript].exports=core=>({...factory(core),adoptAccount:async()=>({ok:false,partial:true,warnings:['injected local incomplete routing']})});
 delete require.cache[script];const lib=require(script);
 require.cache[settingsScript].exports=factory;
 t.after(()=>{global.fetch=priorFetch;for(const k of Object.keys(process.env))if(!(k in previousEnv))delete process.env[k];Object.assign(process.env,previousEnv);delete require.cache[script];fs.rmSync(dir,{recursive:true,force:true});});
 return{dir,lib,calls,remote:()=>remote,changeRemote:c=>{remote.config=c;version='1.0.'+(Number(version.split('.')[2])+1);remote.accountRevision='rev-'+version;},preflight:fn=>{preflightHook=fn},setLocal:c=>fs.writeFileSync(path.join(dir,'workbuddy-3p.json'),JSON.stringify(c)),view:options=>lib.settingsStatus(options),save:async (patch,options={})=>{const s=await lib.settingsStatus();const r=await lib.applySettings({action:'apply',expectedRevision:s.revision,patch,...options});assert.ok(!JSON.stringify(r).includes(canary));return r;}};
}
test('settings default is an account commit plus complete local adoption, not a session write',async t=>{
 const f=fixture(t);const r=await f.save({providers:{p:{label:'Global label'}},efforts:{'p:m':'high'},contexts:{'p:m':32000}});
 assert.equal(r.scope,'account');assert.equal(r.accountCommitted,true);assert.equal(r.localSynced,true);assert.equal(r.localSyncPending,undefined);
 assert.equal(f.remote().config.providers.p.label,'Global label');assert.equal(f.remote().config.effort.models['p:m'],'high');assert.equal(f.remote().config.context.models['p:m'],32000);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'workbuddy-3p.scope.json'))).scope,'account');
 assert.ok(fs.existsSync(path.join(r.backup,'previous-account-profile.json')));
 assert.equal((await f.view()).providers[0].label,'Global label');assert.ok(r.officialModels.includes('glm-5.1'));
});
test('merely connecting and reading account status never hides existing session config/switch',async t=>{
 const f=fixture(t,{connectedOnly:true});const c=cfg();c.providers.p.label='Local label';f.setLocal(c);fs.writeFileSync(path.join(f.dir,'workbuddy-3p.switch'),'official\n');
 const s=await f.view({scope:'session'});assert.equal(s.providers[0].label,'Local label');assert.equal(s.configuredMode,'official');assert.equal(s.sourceKind,'file');
 const global=await f.view();assert.deepEqual(global.providers,[]);assert.equal(global.canImportSession,true);assert.equal(global.scope,'account');
 assert.equal(account.cached({dir:f.dir}).connectionOnly,true);assert.equal(fs.existsSync(path.join(f.dir,'workbuddy-3p.scope.json')),false);
});
test('host credential references are privately resolved into portable account settings',async t=>{
 const f=fixture(t,{connectedOnly:true});const c=cfg();delete c.providers.p.apiKey;c.providers.p.apiKeyEnv='WB3P_TEST_PORTABLE_KEY';f.setLocal(c);process.env.WB3P_TEST_PORTABLE_KEY=canary;
 const r=await f.save({providers:{p:{label:'Portable'}}},{importSession:true});assert.equal(r.accountCommitted,true);
 assert.equal(f.remote().config.providers.p.apiKey,canary);assert.equal(f.remote().config.providers.p.apiKeyEnv,undefined);
 delete process.env.WB3P_TEST_PORTABLE_KEY;assert.equal((await f.view()).providers[0].credential.kind,'inline');
});
test('a source changed during publication stays intact and yields committed plus local sync pending',async t=>{
 const f=fixture(t,{connectedOnly:true});const external=cfg();external.providers.p.label='Concurrent edit';
 f.preflight(()=>f.setLocal(external));const r=await f.save({providers:{p:{label:'Published snapshot'}}},{importSession:true});
 assert.equal(r.accountCommitted,true);assert.equal(r.localSyncPending,true);assert.equal(r.localSynced,false);assert.equal(f.remote().config.providers.p.label,'Published snapshot');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'workbuddy-3p.json'))).providers.p.label,'Concurrent edit');
 assert.equal(fs.existsSync(path.join(f.dir,'workbuddy-3p.scope.json')),false);
});
test('partial local routing never produces a false localSynced receipt',async t=>{
 const f=fixture(t,{partial:true});const r=await f.save({providers:{p:{label:'Account only'}}});
 assert.equal(r.accountCommitted,true);assert.equal(r.localSynced,false);assert.equal(r.localSyncPending,true);assert.equal(r.partial,true);assert.deepEqual(r.warnings,['injected local incomplete routing']);
});
test('session export backs up an existing hidden local config and carries effective account parameters',async t=>{
 const f=fixture(t);const old=cfg();old.providers.p.label='Hidden old session';f.setLocal(old);
 const s=await f.view();const r=await f.lib.applySettings({action:'apply',scope:'session',expectedRevision:s.revision,patch:{contexts:{'p:m':32000}}});
 assert.equal(r.sessionCommitted,true);assert.equal(f.remote().config.context,undefined);assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'workbuddy-3p.scope.json'))).scope,'session');
 const manifest=JSON.parse(fs.readFileSync(path.join(r.backup,'manifest.json'))),entry=manifest.find(x=>x.file===path.join(f.dir,'workbuddy-3p.json'));
 assert.equal(JSON.parse(fs.readFileSync(path.join(r.backup,entry.backup))).providers.p.label,'Hidden old session');
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'workbuddy-3p.parameters.json'))).priority,'native');
});
test('two independent routes can declare different efforts including off for one imported model',async t=>{
 const f=fixture(t,{connectedOnly:true});const c=cfg();c.parameterPriority='3p';c.routes={'glm-5.1':{provider:'p',model:'m',effort:'high'},'glm-5.3-flash':{provider:'p',model:'m',effort:'off'}};f.setLocal(c);
 const s=await f.view({scope:'session'}),high=s.models.find(x=>x.aliases.includes('glm-5.1')),off=s.models.find(x=>x.aliases.includes('glm-5.3-flash'));
 assert.notEqual(high.id,off.id);assert.equal(high.configuredEffort,'high');assert.equal(off.configuredEffort,'off');assert.equal(off.applied,true);
});
test('maintenance picks up an account revision change and updates an already running sandbox',async t=>{
 const f=fixture(t);await f.lib.sync();const c=cfg();c.providers.p.label='Updated elsewhere';f.changeRemote(c);await f.lib.maintainRuntime();
 assert.equal((await f.view()).providers[0].label,'Updated elsewhere');assert.equal(f.lib.status().configuredMode,'official');assert.equal(f.lib.status().parameterPriority,'native');
});
test('independent native bindings do not fabricate an off toggle for host-limited upstream models',async t=>{
 const f=fixture(t,{connectedOnly:true});const c=cfg(),m=c.providers.p.models.m;
 c.providers.p.models={'deepseek-v4.1-flash':m};c.providers.p.extraModels=[];c.routes={'glm-5.1':{provider:'p',model:'deepseek-v4.1-flash',effort:'off'}};f.setLocal(c);
 await assert.rejects(f.view({scope:'session'}),/does not support requested effort/);
});
test('route thinking on uses the imported default instead of silently selecting the highest level',async t=>{
 const f=fixture(t,{connectedOnly:true});const c=cfg();c.parameterPriority='3p';c.routes={'glm-5.1':{provider:'p',model:'m',effort:'on'}};f.setLocal(c);
 const s=await f.view({scope:'session'}),m=s.models.find(x=>x.aliases.includes('glm-5.1'));
 assert.equal(m.requestedEffort,'on');assert.equal(m.configuredEffort,'on');assert.equal(m.baseEffort,'low');assert.equal(m.applied,true);
});
