"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create,cached,cachePath,connectionPath,attemptPath,ORIGIN}=require('../plugins/custom-api-models/scripts/account-profile.cjs');
const packages=require('../plugins/custom-api-models/scripts/profile-package.cjs');
const sync=require('../plugins/custom-api-models/scripts/sync-models.cjs');

const CONTENT='/v2/user-asset/assets/content',NAME='workbuddy-3p-profile';
const secret='FAKE_ACCOUNT_CREDENTIAL_CANARY',refreshSecret='FAKE_REFRESH_CANARY';
function connection(expiresAt=Date.now()+3600000){return{kind:'workbuddy-account',origin:ORIGIN,accountId:'owner',credentials:{accessToken:secret,refreshToken:refreshSecret,expiresAt}};}
function profile(n=0){return{kind:'workbuddy-3p-private-profile',version:1,accountSync:connection(),cloudVersion:'1.0.'+n,cloudUid:'uid',accountRevision:'revision-'+n,config:{mode:'explicit',enabled:'official',providers:{}}};}
function skillItem(uid='uid',version='1.0.0',status='ready'){return{uid,name:NAME,entity_type:'skill',status,version};}
function fillers(n,version='1.0.0'){return Array.from({length:n},(_,i)=>({uid:'filler-'+i,name:'other-profile',entity_type:'skill',status:'ready',version}));}
function bumpVersion(v){const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(v);return m?m[1]+'.'+m[2]+'.'+(Number(m[3])+1):v;}
function setup(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb3p-account-')),p={dir};
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const initial=options.initialProfile||profile();
 if(options.writeCache!==false)fs.writeFileSync(cachePath(p),JSON.stringify(initial));
 const remote=structuredClone(options.remote||profile());
 const state={
  remote,version:options.version||remote.cloudVersion||'1.0.0',status:options.status||'ready',
  calls:[],metadataCalls:0,metadataRequests:[],refreshCount:0,refreshTokens:[],accountCalls:0,accountAuths:[],
  preflightCalls:0,contentPosts:0,downloadUrlCalls:0,directDownloadCalls:0,downloadHeaders:[],uploadProfile:null,itemCalls:0
 };
 const response=(data,status=200)=>new Response(JSON.stringify({code:0,data}),{status,headers:{'Content-Type':'application/json'}});
 const metadataFor=(page,call)=>{
  state.metadataRequests.push({page,call});
  if(options.metadataPages){
   const spec=typeof options.metadataPages==='function'?options.metadataPages(page,call,state):
    Array.isArray(options.metadataPages)?options.metadataPages[page-1]:options.metadataPages[page]||options.metadataPages[String(page)];
   return spec||{items:[],total:0};
  }
  const version=options.metadataVersionSequence?options.metadataVersionSequence[Math.min(call-1,options.metadataVersionSequence.length-1)]:state.version;
  return{items:[skillItem('uid',version,state.status)],total:1};
 };
 const direct=async(url,opts={})=>{
  state.directDownloadCalls++;state.downloadHeaders.push({url:url.href,...opts});
  const payload=options.downloadProfile?options.downloadProfile(state):state.remote;
  return new Response(packages.pack(payload,state.version));
 };
 const fetchImpl=async(url,opts={})=>{
  const u=new URL(url),method=(opts.method||'GET').toUpperCase();
  state.calls.push({url,pathname:u.pathname,search:u.search,method,headers:opts.headers||{},credentials:opts.credentials,redirect:opts.redirect});
  if(u.origin!==ORIGIN)return direct(u,opts);
  if(u.pathname==='/v2/plugin/auth/state')return response({state:'mock-state',authUrl:ORIGIN+'/login?state=mock-state'});
  if(u.pathname==='/v2/plugin/auth/token')return response({accessToken:'finish-access',refreshToken:'finish-refresh',expiresIn:3600});
  if(u.pathname==='/v2/plugin/auth/token/refresh'){
   state.refreshCount++;state.refreshTokens.push(opts.headers?.['X-Refresh-Token']||null);
   if(options.onRefresh)await options.onRefresh(state);
   return response({accessToken:'refreshed-access',refreshToken:'refreshed-refresh',expiresIn:options.refreshExpiresIn===undefined?3600:options.refreshExpiresIn});
  }
  if(u.pathname==='/v2/plugin/account'){
   state.accountCalls++;state.accountAuths.push(opts.headers?.Authorization||null);
   if(options.account401Once&&state.accountCalls===1)return new Response('',{status:401});
   let uid='owner';
   if(typeof options.accountUid==='function')uid=options.accountUid(state);
   else if(options.accountUid!==undefined)uid=options.accountUid;
   else if(state.accountCalls>1&&options.postRefreshUid!==undefined)uid=options.postRefreshUid;
   return response({uid});
  }
  if(u.pathname===CONTENT&&method==='GET'){
   const page=Number(u.searchParams.get('page_no')||1),call=state.metadataCalls+1,data=metadataFor(page,call);
   state.metadataCalls++;return response(data);
  }
  if(u.pathname.startsWith(CONTENT)){
   const suffix=u.pathname.slice(CONTENT.length);
   if(suffix==='/preflight'&&method==='POST'){state.preflightCalls++;return response({can_upload:true,need_confirmation:false,confirmation_types:[]});}
   if(suffix.endsWith('/download-url')&&method==='GET'){state.downloadUrlCalls++;const raw=options.downloadUrl||'https://storage.example.test/profile';return response({download_url:typeof raw==='function'?raw(state):raw});}
   if(suffix===''&&method==='POST'){
    state.contentPosts++;const uploaded=packages.unpack(Buffer.from(await opts.body.get('file').arrayBuffer()));
    state.uploadProfile=uploaded;state.remote=uploaded;state.version=options.postVersion||bumpVersion(state.version);state.status=options.postStatus||'ready';
    if(options.onUpload)await options.onUpload(state,uploaded);
    if(options.postMode==='accept-then-throw')throw new Error('mock upload response lost');
    return response({uid:'uid'});
   }
   if(method==='GET'&&/^\/[^/]+$/.test(suffix)){state.itemCalls++;let data=skillItem('uid',state.version,state.status);if(options.onItem)data=await options.onItem(state,data)||data;return response(data);}
  }
  throw new Error('unexpected mock URL '+u.pathname);
 };
 const core={withLock:sync.runtimeLock,writeAtomic:sync.runtimeWrite,cloudProfile:options.cloudProfile||(()=>null)};
 const client=create(core,{fetchImpl,allowedDownloadHosts:options.allowedDownloadHosts===undefined?['storage.example.test']:options.allowedDownloadHosts,pollIntervalMs:options.pollIntervalMs===undefined?0:options.pollIntervalMs,pollAttempts:options.pollAttempts===undefined?2:options.pollAttempts});
 const setRemote=x=>{state.remote=structuredClone(x);state.version=x.cloudVersion||state.version;state.status=x.status||'ready';};
 return{p,core,client,fetchImpl,state,calls:state.calls,getRemote:()=>structuredClone(state.remote),setRemote,setStatus:v=>{state.status=v;},setVersion:v=>{state.version=v;}};
}
test('private profile ZIP roundtrips and rejects unrelated or malformed packages',()=>{
 const p=profile(),b=packages.pack(p,'1.0.0');
 assert.deepEqual(packages.unpack(b),p);assert.throws(()=>packages.unpack(Buffer.from('invalid')));
 const corrupt=Buffer.from(b);corrupt[40]^=0xff;assert.throws(()=>packages.unpack(corrupt));assert.throws(()=>packages.pack(p,'latest'));
});
test('account status is secret-free and uses authenticated owner metadata',async t=>{const f=setup(t);const r=await f.client.pull(f.p,{strict:true});assert.equal(r.available,true);assert.equal(r.revision,'revision-0');assert.ok(!JSON.stringify(r).includes(secret));});
test('publishing backs up, reads back and allows a separate sandbox to pull global defaults',async t=>{
 const f=setup(t);const result=await f.client.publish(f.p,{mode:'explicit',enabled:'official',providers:{},routes:{'glm-5.1':'official'}},'revision-0');
 assert.equal(result.accountCommitted,true);assert.ok(fs.existsSync(path.join(result.backup,'previous-account-profile.json')));assert.equal(cached(f.p).config.routes['glm-5.1'],'official');assert.ok(!JSON.stringify(result).includes(secret));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb3p-new-account-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const p={dir};fs.writeFileSync(cachePath(p),JSON.stringify(profile()));const reader=create(f.core,{fetchImpl:f.fetchImpl,allowedDownloadHosts:['storage.example.test']});const read=await reader.pull(p,{strict:true});assert.equal(read.revision,result.revision);assert.equal(cached(p).config.routes['glm-5.1'],'official');
});
test('changed cloud revision rejects before uploading rather than overwriting',async t=>{const f=setup(t);f.setRemote(profile(1));await assert.rejects(f.client.publish(f.p,profile().config,'revision-0'),/ACCOUNT_REVISION_CHANGED/);assert.ok(!f.calls.some(c=>c.method==='POST'&&c.url.endsWith('/content')));assert.equal(f.state.contentPosts,0);});
test('no account connection is unavailable and does not create a local success receipt',async t=>{const f=setup(t,{writeCache:false});assert.equal((await f.client.pull(f.p)).available,false);await assert.rejects(f.client.publish(f.p,profile().config,null),/ACCOUNT_LOGIN_REQUIRED/);assert.equal(fs.existsSync(cachePath(f.p)),false);});
test('finish-connect stores only a connection and preserves switch/session configuration',async t=>{
 const f=setup(t,{writeCache:false}),switchFile=path.join(f.p.dir,'workbuddy-3p.switch'),scopeFile=path.join(f.p.dir,'workbuddy-3p.scope.json'),configFile=path.join(f.p.dir,'workbuddy-3p.json');
 fs.writeFileSync(switchFile,'third-party\n');fs.writeFileSync(scopeFile,JSON.stringify({version:1,scope:'session'})+'\n');fs.writeFileSync(configFile,JSON.stringify({mode:'explicit',enabled:'third-party',providers:{}}));
 const before=[switchFile,scopeFile,configFile].map(x=>fs.readFileSync(x,'utf8')),started=await f.client.begin(f.p);
 assert.equal(started.loginRequired,true);const result=await f.client.finish(f.p);
 assert.equal(result.accountConnected,true);assert.equal(result.accountCommitted,false);assert.ok(!JSON.stringify(result).includes('finish-access'));
 assert.equal(fs.existsSync(cachePath(f.p)),false);assert.deepEqual([switchFile,scopeFile,configFile].map(x=>fs.readFileSync(x,'utf8')),before);
 assert.equal(JSON.parse(fs.readFileSync(connectionPath(f.p),'utf8')).accountId,'owner');assert.equal(fs.existsSync(path.join(f.p.dir,'workbuddy-3p.account-login.json')),false);
 const local=f.client.local(f.p);assert.equal(local.connectionOnly,true);assert.equal(fs.existsSync(cachePath(f.p)),false);
});
test('an unknown upload is fenced until the same ready revision and config recover it',async t=>{
 const f=setup(t,{postMode:'accept-then-throw',postStatus:'pending'}),cfg={mode:'explicit',enabled:'official',providers:{},routes:{'glm-5.1':'official'}};
 const first=await f.client.publish(f.p,cfg,'revision-0');
 assert.equal(first.accountCommitted,null);assert.equal(first.retryBlocked,true);assert.equal(first.outcomeUnknown,true);assert.equal(f.state.contentPosts,1);
 assert.ok(fs.existsSync(attemptPath(f.p)));const attempt=JSON.parse(fs.readFileSync(attemptPath(f.p),'utf8'));assert.equal(attempt.status,'unknown');
 const second=await f.client.publish(f.p,cfg,'revision-0');
 assert.equal(second.accountCommitted,null);assert.equal(second.retryBlocked,true);assert.equal(second.status,'publication-unresolved');assert.equal(f.state.contentPosts,1);
 assert.equal(cached(f.p).config.routes?.['glm-5.1'],undefined);
 f.setStatus('ready');const recovered=await f.client.pull(f.p,{strict:true});
 assert.equal(recovered.status,'synced');assert.equal(recovered.recoveredPublication,true);assert.equal(recovered.revision,attempt.revision);assert.equal(f.state.contentPosts,1);
 assert.equal(fs.existsSync(attemptPath(f.p)),false);assert.equal(cached(f.p).config.routes['glm-5.1'],'official');
});
test('tampered ready readback stays pending/unknown and never commits',async t=>{
 const cases=[['accountId',s=>{s.remote.accountSync.accountId='attacker';}],['config',s=>{s.remote.config.routes={'tampered':'attacker'};}]];
 for(const [label,mutate]of cases)await t.test(label,async t=>{
  const f=setup(t,{onUpload:mutate}),before=fs.readFileSync(cachePath(f.p),'utf8');
  const result=await f.client.publish(f.p,{mode:'explicit',enabled:'official',providers:{}},'revision-0');
  assert.equal(result.accountCommitted,null);assert.equal(result.retryBlocked,true);assert.equal(result.outcomeUnknown,true);
  assert.equal(fs.readFileSync(cachePath(f.p),'utf8'),before);assert.equal(JSON.parse(fs.readFileSync(attemptPath(f.p),'utf8')).status,'unknown');
  const pulled=await f.client.pull(f.p);assert.equal(pulled.available,false);assert.equal(pulled.status,'sync-error');assert.notEqual(pulled.accountCommitted,true);
 });
});
test('signed downloads omit account material and reject hosts unless explicitly allowed for the test',async t=>{
 await t.test('explicit test host is credentialless on the direct fetch',async t=>{
  const f=setup(t,{allowedDownloadHosts:['storage.example.test']});f.setRemote(profile(1));const result=await f.client.pull(f.p,{strict:true});
  assert.equal(result.status,'synced');assert.equal(f.state.directDownloadCalls,1);const direct=f.state.downloadHeaders[0];
  assert.equal(direct.url,'https://storage.example.test/profile');assert.equal(direct.credentials,'omit');assert.equal(direct.redirect,'error');assert.equal(direct.headers?.Authorization,undefined);assert.equal(direct.headers?.Cookie,undefined);
 });
 await t.test('mock storage host is not official without the explicit test allowlist',async t=>{
  const f=setup(t,{allowedDownloadHosts:[]});f.setRemote(profile(1));await assert.rejects(f.client.pull(f.p,{strict:true}),/ACCOUNT_DOWNLOAD_HOST_REJECTED/);assert.equal(f.state.directDownloadCalls,0);
 });
 await t.test('an unrelated host is rejected even when a test host is allowed',async t=>{
  const f=setup(t,{downloadUrl:'https://not-official.example/profile',allowedDownloadHosts:['storage.example.test']});f.setRemote(profile(1));await assert.rejects(f.client.pull(f.p,{strict:true}),/ACCOUNT_DOWNLOAD_HOST_REJECTED/);assert.equal(f.state.directDownloadCalls,0);
 });
});
test('refresh is bounded, owner-checked and serialized per host',async t=>{
 await t.test('401 refreshes once and rechecks owner',async t=>{
  const f=setup(t,{account401Once:true,postRefreshUid:'owner'}),result=await f.client.pull(f.p,{strict:true});
  assert.equal(result.status,'synced');assert.equal(f.state.refreshCount,1);assert.equal(f.state.accountCalls,3);assert.equal(f.state.accountAuths[0],'Bearer '+secret);assert.equal(f.state.accountAuths[1],'Bearer refreshed-access');
 });
 await t.test('illegal expiresIn is rejected before account success',async t=>{
  const expired=profile();expired.accountSync.credentials.expiresAt=Date.now()-1;const f=setup(t,{initialProfile:expired,refreshExpiresIn:0});
  await assert.rejects(f.client.pull(f.p,{strict:true}),/ACCOUNT_TOKEN_EXPIRY_INVALID/);assert.equal(f.state.refreshCount,1);assert.equal(f.state.accountCalls,0);
 });
 await t.test('a refreshed token for another owner is rejected before storing credentials or reading assets',async t=>{
  const f=setup(t,{account401Once:true,postRefreshUid:'other-owner'});
  await assert.rejects(f.client.pull(f.p,{strict:true}),/ACCOUNT_IDENTITY_MISMATCH/);
  assert.equal(f.state.metadataCalls,0);assert.equal(fs.existsSync(connectionPath(f.p)),false);
  assert.equal(cached(f.p).accountSync.credentials.accessToken,secret);
 });
 await t.test('same-host concurrent pulls share one refresh',async t=>{
  const expired=profile();expired.accountSync.credentials.expiresAt=Date.now()-1;let started,release;const startedPromise=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const f=setup(t,{initialProfile:expired,onRefresh:async()=>{started();await gate;}});const first=f.client.pull(f.p,{strict:true});await startedPromise;const second=f.client.pull(f.p,{strict:true});release();const results=await Promise.all([first,second]);
  assert.equal(f.state.refreshCount,1);assert.ok(results.every(r=>r.status==='synced'));assert.deepEqual(f.state.accountAuths,['Bearer refreshed-access','Bearer refreshed-access','Bearer refreshed-access']);
 });
});
test('remote version changes, metadata pages/duplicates and failed states never fabricate success',async t=>{
 await t.test('version change after preflight rejects before POST',async t=>{
  const f=setup(t,{metadataVersionSequence:['1.0.0','1.0.0','1.0.1']});await assert.rejects(f.client.publish(f.p,profile().config,'revision-0'),/ACCOUNT_REVISION_CHANGED/);assert.equal(f.state.contentPosts,0);assert.equal(fs.existsSync(attemptPath(f.p)),false);
 });
 await t.test('pagination reaches a matching profile',async t=>{
  const pages={1:{items:fillers(100),total:101},2:{items:[skillItem('uid','1.0.2','ready')],total:101}},f=setup(t,{remote:profile(2),version:'1.0.2',metadataPages:pages});
  const result=await f.client.pull(f.p,{strict:true});assert.equal(result.status,'synced');assert.equal(result.revision,'revision-2');assert.deepEqual(f.state.metadataRequests.map(x=>x.page),[1,2]);assert.equal(f.state.directDownloadCalls,1);
 });
 await t.test('duplicate metadata is ambiguous, not global success',async t=>{
  const pages={1:{items:fillers(100),total:102},2:{items:[skillItem('uid','1.0.1','ready'),skillItem('uid','1.0.1','ready')],total:102}},f=setup(t,{metadataPages:pages});
  await assert.rejects(f.client.pull(f.p,{strict:true}),/ACCOUNT_PROFILE_AMBIGUOUS/);const soft=await f.client.pull(f.p);assert.equal(soft.available,false);assert.equal(soft.status,'sync-error');assert.equal(soft.accountCommitted,undefined);
 });
 await t.test('failed profile is unavailable and publish does not upload',async t=>{
  const f=setup(t,{status:'failed'}),soft=await f.client.pull(f.p);assert.equal(soft.available,false);assert.equal(soft.status,'sync-error');assert.equal(soft.reason,'ACCOUNT_PROFILE_NOT_READY');assert.equal(soft.accountCommitted,undefined);
  await assert.rejects(f.client.publish(f.p,profile().config,'revision-0'),/ACCOUNT_PROFILE_NOT_READY/);assert.equal(f.state.contentPosts,0);
 });
});
