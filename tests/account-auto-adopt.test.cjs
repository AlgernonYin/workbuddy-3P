"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const account=require('../plugins/custom-api-models/scripts/account-profile.cjs');
const packages=require('../plugins/custom-api-models/scripts/profile-package.cjs');

const CONTENT='/v2/user-asset/assets/content',NAME='workbuddy-3p-profile';
const accessToken='FAKE_ACCOUNT_TOKEN',refreshToken='FAKE_REFRESH_TOKEN';

function connection(accountId='owner'){
 return{kind:'workbuddy-account',origin:account.ORIGIN,accountId,credentials:{accessToken,refreshToken,expiresAt:Date.now()+3600000}};
}
function publishedProfile(){
 return{kind:'workbuddy-3p-private-profile',version:1,accountSync:connection(),accountRevision:'account-revision',
  config:{mode:'explicit',enabled:'official',providers:{},routes:{'glm-5.1':'official'}}};
}
function response(data){return new Response(JSON.stringify({code:0,data}),{status:200,headers:{'Content-Type':'application/json'}});}

function fixture(t,{cloud=true,pluginOptions=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb3p-auto-adopt-')),p={dir};
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let cloudPath=null;
 if(cloud){
  cloudPath=path.join(dir,'skills','workbuddy-3p-profile','workbuddy-3p.profile.json');
  fs.mkdirSync(path.dirname(cloudPath),{recursive:true});fs.writeFileSync(cloudPath,JSON.stringify(publishedProfile()));
 }
 const envName='CODEBUDDY_PLUGIN_OPTION_AUTO_ADOPT_TEST',previous=process.env[envName];
 if(pluginOptions)process.env[envName]='native-option';
 t.after(()=>{if(previous===undefined)delete process.env[envName];else process.env[envName]=previous;});

 const core={
  withLock:async(_key,fn)=>fn(),
  writeAtomic:(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);},
  cloudProfile:()=>cloud?{from:cloudPath}:null,
  hasLocalOverrides:()=>Object.keys(process.env).some(k=>/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)&&!!process.env[k]&&!['WB3P_PROFILE','WB3P_CLOUD_SKILLS_DIR'].includes(k))
 };
 const fetchImpl=async(url,opts={})=>{
  const u=new URL(url);
  if(u.origin!==account.ORIGIN)return new Response(packages.pack(publishedProfile(),'1.0.0'));
  if(u.pathname==='/v2/plugin/account')return response({uid:'owner'});
  if(u.pathname==='/v2/plugin/auth/state')return response({state:'mock-state',authUrl:account.ORIGIN+'/login?state=mock-state'});
  if(u.pathname==='/v2/plugin/auth/token')return response({accessToken:'finish-access',refreshToken:'finish-refresh',expiresIn:3600});
  if(u.pathname===CONTENT&&(opts.method||'GET')==='GET')return response({items:[{uid:'uid',name:NAME,entity_type:'skill',status:'ready',version:'1.0.0'}],total:1});
  if(u.pathname===CONTENT+'/uid/download-url')return response({download_url:'https://test.cos.accelerate.myqcloud.com/profile'});
  throw new Error('unexpected mock URL '+u.pathname);
 };
 const client=account.create(core,{fetchImpl,allowedDownloadHosts:['test.cos.accelerate.myqcloud.com']});
 return{p,client,core};
}

test('a clean private-skill sandbox auto-adopts the published account profile despite native plugin options',async t=>{
 const f=fixture(t);
 assert.equal(f.core.hasLocalOverrides(),true);
 assert.equal(account.cached(f.p),null);
 const result=await f.client.pull(f.p,{strict:true});
 assert.equal(result.status,'synced');
 const saved=account.cached(f.p);
 assert.equal(Object.hasOwn(saved,'connectionOnly'),false);
 assert.equal(saved.accountRevision,'account-revision');
 assert.equal(saved.accountSync.accountId,'owner');
 assert.equal(saved.config.routes['glm-5.1'],'official');
});

test('pending login is inactive and finish-connect remains connection-only after cloud adoption',async t=>{
 const f=fixture(t,{cloud:false});
 const started=await f.client.begin(f.p);
 assert.equal(started.loginRequired,true);
 assert.equal(f.client.local(f.p),null);
 assert.equal(account.cached(f.p),null);

 const connected=await f.client.finish(f.p);
 assert.equal(connected.accountConnected,true);assert.equal(connected.accountCommitted,false);
 assert.equal(f.client.local(f.p).connectionOnly,true);
 assert.equal(account.cached(f.p),null);

 const pulled=await f.client.pull(f.p,{strict:true});
 assert.equal(pulled.status,'synced');
 assert.equal(account.cached(f.p).connectionOnly,true);
});
