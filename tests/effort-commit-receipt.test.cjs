"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawnSync}=require("node:child_process");

const ROOT=path.resolve(__dirname,"..");
const MCP=path.join(ROOT,"plugins","custom-api-models","scripts","mcp-sync.cjs");
const SYNC=path.join(ROOT,"plugins","custom-api-models","scripts","sync-models.cjs");
const CALLS_MARK="__WB3P_EFFORT_CALLS__";
const UPLOADS_MARK="__WB3P_EFFORT_UPLOADS__";
const BASE_MOCK="sync:async()=>({ok:true}),maintainRuntime:async()=>({}),status:()=>({ok:true}),setSwitch:async()=>({ok:true}),accountLogin:async()=>({ok:true}),providerRequest:async()=>({ok:true}),doctor:async()=>({ok:true})";

function cleanEnv(dir){
  const env={...process.env,CODEBUDDY_CONFIG_DIR:dir};
  for(const key of Object.keys(env))if(/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(key))delete env[key];
  return env;
}
function parseReplies(stdout){
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
}
function toolReply(child,id){
  assert.equal(child.status,0,child.error?.message||child.stderr||"MCP child failed");
  const reply=parseReplies(child.stdout).find(item=>item.id===id);
  assert.ok(reply,"missing MCP reply "+id+"\n"+child.stdout+"\n"+child.stderr);
  assert.ok(reply.result,"missing MCP result "+id+"\n"+JSON.stringify(reply));
  return reply.result;
}
function payload(reply){
  assert.equal(reply.isError,undefined,reply.content?.[0]?.text||"tool returned isError");
  return JSON.parse(reply.content[0].text);
}
function runMocked(t,mockFactory,args){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wb3p-effort-receipt-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=[
    "const calls=[];",
    `const mock=(${mockFactory})();`,
    `require.cache[${JSON.stringify(SYNC)}]={id:${JSON.stringify(SYNC)},filename:${JSON.stringify(SYNC)},loaded:true,exports:mock};`,
    `process.on("exit",()=>process.stderr.write(${JSON.stringify(CALLS_MARK)}+JSON.stringify(calls)+"\\n"));`,
    `require(${JSON.stringify(MCP)});`
  ].join("\n");
  const input=[
    {jsonrpc:"2.0",id:1,method:"initialize",params:{}},
    {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"models_effort",arguments:args}}
  ].map(item=>JSON.stringify(item)).join("\n")+"\n";
  const child=spawnSync(process.execPath,["-e",source],{env:cleanEnv(dir),encoding:"utf8",input,timeout:20000,windowsHide:true});
  const marker=child.stderr.split(/\r?\n/).find(line=>line.startsWith(CALLS_MARK));
  const calls=marker?JSON.parse(marker.slice(CALLS_MARK.length)):[];
  return {child,calls,result:toolReply(child,2),dir};
}

test("models_effort keeps a committed localSyncPending receipt and never reads stale session effort",t=>{
  const mockFactory=`function(){let read=0;return {${BASE_MOCK},
    settingsStatus:async(opts)=>{calls.push({fn:"settingsStatus",scope:opts&&opts.scope});return {ok:true,revision:"r0",scope:opts&&opts.scope};},
    effortStatus:async(opts)=>{read+=1;calls.push({fn:"effortStatus",scope:opts&&opts.scope,model:opts&&opts.model,read});return read===1?{models:[{target:"p:m",configuredEffort:"high"}],scopeUsed:opts&&opts.scope||"default"}:{models:[{target:"p:m",configuredEffort:"low"}],scopeUsed:opts&&opts.scope||"default",staleSession:true};},
    applySettings:async(args)=>{calls.push({fn:"applySettings",scope:args.scope});return {ok:true,committed:true,accountCommitted:true,scope:"account",localSyncPending:true,localSynced:false};}
  };}`;
  const run=runMocked(t,mockFactory,{action:"set",scope:"model",model:"p:m",level:"high"});
  const result=payload(run.result);
  assert.equal(result.committed,true);
  assert.equal(result.accountCommitted,true);
  assert.equal(result.scope,"account");
  assert.equal(result.localSyncPending,true);
  assert.equal(result.localSynced,false);
  assert.equal(result.staleSession,undefined);
  assert.equal(result.models,undefined);
  assert.deepEqual(run.calls.filter(item=>item.fn==="effortStatus"),[{fn:"effortStatus",scope:"account",model:"p:m",read:1}]);
  assert.deepEqual(run.calls.find(item=>item.fn==="applySettings"),{fn:"applySettings",scope:"account"});
});

test("a normal account post-read passes saveScope and retains the commit receipt when it fails",t=>{
  const mockFactory=`function(){let read=0;return {${BASE_MOCK},
    settingsStatus:async(opts)=>{calls.push({fn:"settingsStatus",scope:opts&&opts.scope});return {ok:true,revision:"r0",scope:opts&&opts.scope};},
    effortStatus:async(opts)=>{read+=1;calls.push({fn:"effortStatus",scope:opts&&opts.scope,model:opts&&opts.model,read});if(read===1)return {models:[{target:"p:m",configuredEffort:"high"}]};throw Error("injected account post-read failure");},
    applySettings:async(args)=>{calls.push({fn:"applySettings",scope:args.scope});return {ok:true,committed:true,accountCommitted:true,scope:"account",backup:"fake-backup"};}
  };}`;
  const run=runMocked(t,mockFactory,{action:"set",scope:"model",model:"p:m",level:"high"});
  const result=payload(run.result);
  assert.equal(result.committed,true);
  assert.equal(result.accountCommitted,true);
  assert.equal(result.scope,"account");
  assert.equal(result.stateUnavailable,true);
  assert.equal(result.backup,"fake-backup");
  assert.deepEqual(run.calls.filter(item=>item.fn==="effortStatus").map(item=>[item.read,item.scope]),[[1,"account"],[2,"account"]]);
});

test("a session commit keeps sessionCommitted and scope when its post-read fails",t=>{
  const mockFactory=`function(){let read=0;return {${BASE_MOCK},
    settingsStatus:async(opts)=>{calls.push({fn:"settingsStatus",scope:opts&&opts.scope});return {ok:true,revision:"r0",scope:opts&&opts.scope};},
    effortStatus:async(opts)=>{read+=1;calls.push({fn:"effortStatus",scope:opts&&opts.scope,read});if(read===1)return {models:[{target:"p:m",configuredEffort:"high"}]};throw Error("injected session post-read failure");},
    applySettings:async(args)=>{calls.push({fn:"applySettings",scope:args.scope});return {ok:true,committed:true,sessionCommitted:true,session:true,scope:"session",backup:"fake-session-backup"};}
  };}`;
  const run=runMocked(t,mockFactory,{action:"set",scope:"model",model:"p:m",level:"high",saveScope:"session"});
  const result=payload(run.result);
  assert.equal(result.committed,true);
  assert.equal(result.sessionCommitted,true);
  assert.equal(result.scope,"session");
  assert.equal(result.stateUnavailable,true);
  assert.deepEqual(run.calls.filter(item=>item.fn==="effortStatus").map(item=>[item.read,item.scope]),[[1,"session"],[2,"session"]]);
});

test("the MCP effort path reports accountCommitted/localSyncPending after one mocked asset upload and a publication-time local change",t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wb3p-effort-real-account-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=[
    `const fs=require("node:fs"),path=require("node:path");`,
    `const root=${JSON.stringify(ROOT)};`,
    `const account=require(path.join(root,"plugins","custom-api-models","scripts","account-profile.cjs"));`,
    `const packages=require(path.join(root,"plugins","custom-api-models","scripts","profile-package.cjs"));`,
    `const dir=process.env.CODEBUDDY_CONFIG_DIR;`,
    `const connection={kind:"workbuddy-account",origin:account.ORIGIN,accountId:"owner",credentials:{accessToken:"FAKE_ACCOUNT_TOKEN",refreshToken:"FAKE_REFRESH",expiresAt:Date.now()+3600000}};`,
    `const baseCfg={mode:"explicit",enabled:"official",parameterPriority:"native",providers:{},routes:{}};`,
    `const localCfg={mode:"explicit",enabled:"official",parameterPriority:"native",providers:{},routes:{}};`,
    `let remote={kind:"workbuddy-3p-private-profile",version:1,config:baseCfg,accountSync:connection,accountRevision:"rev-0"};`,
    `let version="1.0.0",uploaded=0;`,
    `fs.mkdirSync(dir,{recursive:true});`,
    `fs.writeFileSync(account.cachePath({dir}),JSON.stringify({...remote,cloudVersion:version,cloudUid:"uid"}));`,
    `fs.writeFileSync(path.join(dir,"workbuddy-3p.json"),JSON.stringify(localCfg));`,
    `const response=data=>new Response(JSON.stringify({code:0,data}),{status:200,headers:{"Content-Type":"application/json"}});`,
    `global.fetch=async(url,options={})=>{`,
    ` const u=new URL(url);`,
    ` if(u.hostname==="test.cos.accelerate.myqcloud.com")return new Response(packages.pack(remote,version));`,
    ` if(u.origin!==account.ORIGIN)throw Error("unexpected mock origin");`,
    ` if(u.pathname==="/v2/plugin/account")return response({uid:"owner"});`,
    ` if(u.pathname.includes("/download-url"))return response({download_url:"https://test.cos.accelerate.myqcloud.com/profile"});`,
    ` if(u.pathname.includes("/preflight")){fs.writeFileSync(path.join(dir,"workbuddy-3p.json"),JSON.stringify({...localCfg,duringPublication:true}));return response({can_upload:true,need_confirmation:false});}`,
    ` if(options.method==="POST"&&u.pathname.endsWith("/content")){uploaded+=1;remote=packages.unpack(Buffer.from(await options.body.get("file").arrayBuffer()));version="1.0.1";return response({uid:"uid"});}`,
    ` if(u.pathname.includes("/content/uid"))return response({uid:"uid",name:"workbuddy-3p-profile",entity_type:"skill",version,status:"ready"});`,
    ` return response({items:[{uid:"uid",name:"workbuddy-3p-profile",entity_type:"skill",version,status:"ready"}],total:1});`,
    `};`,
    `process.on("exit",()=>process.stderr.write(${JSON.stringify(UPLOADS_MARK)}+uploaded+"\\n"));`,
    `require(${JSON.stringify(MCP)});`
  ].join("\n");
  const input=[
    {jsonrpc:"2.0",id:1,method:"initialize",params:{}},
    {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"models_effort",arguments:{action:"set",level:"high"}}}
  ].map(item=>JSON.stringify(item)).join("\n")+"\n";
  const child=spawnSync(process.execPath,["-e",source],{env:cleanEnv(dir),encoding:"utf8",input,timeout:20000,windowsHide:true});
  const result=payload(toolReply(child,2));
  assert.equal(result.committed,true);
  assert.equal(result.accountCommitted,true);
  assert.equal(result.scope,"account");
  assert.equal(result.localSyncPending,true);
  assert.equal(result.localSynced,false);
  const uploads=child.stderr.split(/\r?\n/).find(line=>line.startsWith(UPLOADS_MARK));
  assert.ok(uploads,"missing upload count marker");
  assert.equal(Number(uploads.slice(UPLOADS_MARK.length)),1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,"workbuddy-3p.json"),"utf8")).duringPublication,true);
});
for(const flag of ["partial","stateUnavailable"]){
  test(`models_effort returns a committed account ${flag} receipt without a post-read`,t=>{
    const property=JSON.stringify(flag);
    const mockFactory=`function(){let read=0;return {${BASE_MOCK},
      settingsStatus:async(opts)=>{calls.push({fn:"settingsStatus",scope:opts&&opts.scope});return {ok:true,revision:"r0",scope:opts&&opts.scope};},
      effortStatus:async(opts)=>{read+=1;calls.push({fn:"effortStatus",scope:opts&&opts.scope,read});return read===1?{models:[{target:"p:m",configuredEffort:"high"}]}:{staleSession:true};},
      applySettings:async(args)=>{calls.push({fn:"applySettings",scope:args.scope});return {ok:true,committed:true,accountCommitted:true,scope:"account",${property}:true};}
    };}`;
    const run=runMocked(t,mockFactory,{action:"set",scope:"model",model:"p:m",level:"high"});
    const result=payload(run.result);
    assert.equal(result.committed,true);
    assert.equal(result.accountCommitted,true);
    assert.equal(result.scope,"account");
    assert.equal(result[flag],true);
    assert.equal(result.staleSession,undefined);
    assert.equal(run.calls.filter(item=>item.fn==="effortStatus").length,1);
  });
}