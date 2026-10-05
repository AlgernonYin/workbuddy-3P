"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../plugins/custom-api-models/scripts/sync-models.cjs');
const capabilities=require('../plugins/custom-api-models/scripts/provider-models.cjs');
function fixture(t,cfg) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb3p-public-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const env={...process.env,CODEBUDDY_CONFIG_DIR:dir};for(const k of Object.keys(env))if(/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k))delete env[k];env.WB3P_PARAMETER_PRIORITY='native';
 fs.writeFileSync(path.join(dir,'workbuddy-3p.json'),JSON.stringify(cfg));
 function call(expr){const r=spawnSync(process.execPath,['-e',`const l=require(${JSON.stringify(script)});(async()=>{${expr}})().catch(e=>{console.error(e.message);process.exitCode=1})`],{env,encoding:'utf8'});assert.ok(!r.stdout.includes('FAKE_PUBLIC_CREDENTIAL'));return r;}
 function ok(expr){const r=call(expr);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout)}
 return {dir,call,ok};
}
test('a new public provider does not imply a preset, import or same-name route',t=>{
 const f=fixture(t,{providers:{p:{baseUrl:'https://api.example.invalid/v1',apiKey:'FAKE_PUBLIC_CREDENTIAL'}}});
 const out=f.ok('console.log(JSON.stringify(await l.sync()))');assert.equal(out.active,false);
 const view=f.ok('console.log(JSON.stringify(await l.settingsStatus()))');assert.equal(view.routingMode,'explicit');assert.deepEqual(view.models,[]);assert.deepEqual(view.routes,{});
 assert.equal(view.providers[0].preset,'');assert.equal(view.providers[0].protocol,'openai-chat');
});
test('unknown imported models do not acquire fabricated window, reasoning or tool capabilities',t=>{
 const f=fixture(t,{providers:{p:{baseUrl:'https://api.example.invalid/v1',apiKey:'FAKE_PUBLIC_CREDENTIAL',extraModels:['unknown']}}});
 f.ok('console.log(JSON.stringify(await l.sync()))');
 const m=JSON.parse(fs.readFileSync(path.join(f.dir,'models.json'))).models[0];
 for(const k of ['maxInputTokens','maxOutputTokens','supportsReasoning','supportsToolCall'])assert.equal(m[k],undefined);
});
test('Responses inventory can be managed but must not receive an incompatible native chat route',t=>{
 const f=fixture(t,{providers:{p:{baseUrl:'https://api.example.invalid/v1',protocol:'openai-responses',apiKey:'FAKE_PUBLIC_CREDENTIAL',extraModels:['r'],models:{r:{maxInputTokens:64000}}}}});
 const s=f.ok('console.log(JSON.stringify(await l.settingsStatus()))');assert.equal(s.providers[0].nativeSessionSupported,false);assert.equal(s.providers[0].models.r.maxInputTokens,64000);
 const r=f.call("const s=await l.settingsStatus();await l.applySettings({action:'apply',scope:'session',expectedRevision:s.revision,patch:{routes:{'glm-5.1':{provider:'p',model:'r'}}}})");assert.notEqual(r.status,0);assert.match(r.stderr,/does not convert protocols/);
});
test('capability declarations reject credential fields and impossible efforts',()=>{
 for(const m of [{apiKey:'secret'},{url:'https://elsewhere.invalid'},{maxInputTokens:0},{reasoning:{supportedEfforts:['ultra']}},{reasoning:{supportedEfforts:['low'],defaultEffort:'max'}},{onlyReasoning:true,reasoning:{canDisableThinking:true}}])assert.throws(()=>capabilities.validateModel(m));
 assert.equal(capabilities.validateModel({maxInputTokens:64000,supportsReasoning:true,reasoning:{supportedEfforts:['low','high'],defaultEffort:'low'}}).maxInputTokens,64000);
});
