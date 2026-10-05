"use strict";
// Private first-party assets are account authority. Credentials stay inside this module.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const packages=require('./profile-package.cjs');
const ORIGIN='https://www.workbuddy.cn',NAME='workbuddy-3p-profile',CONTENT='/v2/user-asset/assets/content';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const fail=code=>{const e=Error(code);e.code=code;throw e;};
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){if(e.code==='ENOENT')return null;fail('ACCOUNT_CACHE_INVALID');}};
const cachePath=p=>path.join(p.dir,'workbuddy-3p.account-cache.json');
const connectionPath=p=>path.join(p.dir,'workbuddy-3p.account-connection.json');
const attemptPath=p=>path.join(p.dir,'workbuddy-3p.account-attempt.json');
const cached=p=>read(cachePath(p));
function validateConnection(v){
 if(!object(v)||v.kind!=='workbuddy-account'||v.origin!==ORIGIN||!object(v.credentials)||
  typeof v.credentials.accessToken!=='string'||!v.credentials.accessToken||typeof v.credentials.refreshToken!=='string'||!v.credentials.refreshToken||
  typeof v.accountId!=='string'||!v.accountId||Object.keys(v.credentials).some(k=>!['accessToken','refreshToken','expiresAt'].includes(k))||
  v.credentials.expiresAt!==undefined&&(!Number.isFinite(v.credentials.expiresAt)||v.credentials.expiresAt<=0))fail('ACCOUNT_CONNECTION_INVALID');
 return v;
}
function tokenCredentials(t){
 if(!t||typeof t.accessToken!=='string'||!t.accessToken||typeof t.refreshToken!=='string'||!t.refreshToken)fail('ACCOUNT_REFRESH_FAILED');
 const seconds=t.expiresIn===undefined?3600:Number(t.expiresIn);
 if(!Number.isFinite(seconds)||seconds<=0||seconds>31*86400)fail('ACCOUNT_TOKEN_EXPIRY_INVALID');
 return {accessToken:t.accessToken,refreshToken:t.refreshToken,expiresAt:Date.now()+seconds*1000};
}
function create(core,{fetchImpl=fetch,allowedDownloadHosts=[],pollIntervalMs=1000,pollAttempts=12}={}){
 const nonce=()=>crypto.randomBytes(32).toString('hex');
 // ONE-host transaction lock only. No verified server-side CAS across sandboxes.
 const exclusive=(p,fn)=>core.withLock(path.join(p.dir,'.workbuddy-3p-account'),fn);
 const saveConnection=(p,c)=>core.writeAtomic(connectionPath(p),JSON.stringify(validateConnection(c)));
 async function request(route,c,options={},retry=true,p){
  if(!route.startsWith('/v2/plugin/')&&!route.startsWith(CONTENT))fail('ACCOUNT_ROUTE_REJECTED');
  const headers={'X-Submitted-From':'web',...(c?{Authorization:'Bearer '+validateConnection(c).credentials.accessToken}:{}),...(options.headers||{})};
  let response;try{response=await fetchImpl(ORIGIN+route,{...options,headers,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});}catch{fail('ACCOUNT_TRANSPORT_FAILED');}
  if(!response.ok){
   await response.body?.cancel();
   if([401,403].includes(response.status)&&retry&&c&&p&&!route.includes('/auth/token/refresh')){await refresh(p,c);return request(route,c,options,false,p);}
   fail([401,403].includes(response.status)?'ACCOUNT_LOGIN_REQUIRED':'ACCOUNT_REQUEST_FAILED');
  }
  const chunks=[];let n=0;
  try{for await(const b of response.body){n+=b.length;if(n>2*1024*1024)fail('ACCOUNT_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(b));}}
  catch(e){fail(e.code==='ACCOUNT_RESPONSE_TOO_LARGE'?e.code:'ACCOUNT_TRANSPORT_FAILED');}
  let j;try{j=JSON.parse(Buffer.concat(chunks,n).toString());}catch{fail('ACCOUNT_RESPONSE_INVALID');}
  if(j.code!==0)fail('ACCOUNT_REQUEST_REJECTED');return j.data?.data||j.data;
 }
 async function refresh(p,c){
  const t=await request('/v2/plugin/auth/token/refresh',c,{method:'POST',headers:{'Content-Type':'application/json','X-Refresh-Token':c.credentials.refreshToken,'X-Auth-Refresh-Source':'plugin'},body:'{}'},false);
  c.credentials=tokenCredentials(t);
  const owner=await request('/v2/plugin/account',c,{},false);
  if(String(owner?.uid||'')!==c.accountId)fail('ACCOUNT_IDENTITY_MISMATCH');
  saveConnection(p,c);
 }
 async function credentials(p,profile){
  const c=validateConnection(profile.accountSync);
  if(c.credentials.expiresAt&&Date.now()>c.credentials.expiresAt-60000)await refresh(p,c);
  const a=await request('/v2/plugin/account',c,{},true,p);if(String(a?.uid||'')!==c.accountId)fail('ACCOUNT_IDENTITY_MISMATCH');return c;
 }
 function local(p){
  const saved=cached(p),found=saved?null:core.cloudProfile(p.dir);
  let profile=saved||(found?read(found.from):null);const connection=read(connectionPath(p));
  if(connection){validateConnection(connection);if(profile?.accountSync&&profile.accountSync.accountId!==connection.accountId)fail('ACCOUNT_IDENTITY_MISMATCH');
   profile=profile?{...profile,accountSync:connection}:{kind:'workbuddy-3p-private-profile',version:1,connectionOnly:true,config:{mode:'explicit',enabled:'official',providers:{}},accountSync:connection};
  }
  return profile?.accountSync?profile:null;
 }
 async function metadata(c,p,allowPending=false){
  const rows=[];
  for(let page=1;page<=10;page++){
   const j=await request(CONTENT+'?entity_type=skill&page_no='+page+'&page_size=100',c,{},true,p);if(!Array.isArray(j?.items))fail('ACCOUNT_METADATA_INVALID');
   rows.push(...j.items.filter(x=>x.name===NAME&&x.entity_type==='skill'));if(rows.length>1)fail('ACCOUNT_PROFILE_AMBIGUOUS');
   if(j.items.length<100||Number.isFinite(j.total)&&page*100>=j.total)break;
   if(page===10)fail('ACCOUNT_METADATA_TOO_LARGE');
  }
  const item=rows[0];if(item&&(typeof item.uid!=='string'||!item.uid||typeof item.version!=='string'))fail('ACCOUNT_METADATA_INVALID');
  if(item&&item.status!=='ready'&&!allowPending)fail('ACCOUNT_PROFILE_NOT_READY');return item||null;
 }
 async function download(item,c,p){
  const d=await request(CONTENT+'/'+encodeURIComponent(item.uid)+'/download-url?entity_type=skill',c,{},true,p);
  let u;try{u=new URL(d?.download_url||d?.downloadUrl)}catch{fail('ACCOUNT_DOWNLOAD_INVALID');}
  // Observed first-party CDN: Tencent COS. Do not send account headers, follow
  // redirects or accept arbitrary/private download hosts.
  const official=/^[a-z0-9-]+\.cos(?:\.[a-z0-9-]+){1,3}\.myqcloud\.com$/i.test(u.hostname);
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||!official&&!allowedDownloadHosts.includes(u.hostname))fail('ACCOUNT_DOWNLOAD_HOST_REJECTED');
  const r=await fetchImpl(u.href,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok){await r.body?.cancel();fail('ACCOUNT_DOWNLOAD_FAILED');}
  const chunks=[];let n=0;for await(const b of r.body){n+=b.length;if(n>2*1024*1024)fail('ACCOUNT_PROFILE_TOO_LARGE');chunks.push(Buffer.from(b));}
  return packages.unpack(Buffer.concat(chunks,n));
 }
 function validateReadback(next,c,expected){
  // A legacy profile predates account connection. Its private download was
  // authorized by the verified owner; attach this connection, never reuse an
  // unverified token supplied by another package.
  if(next.accountSync===undefined&&!expected)next.accountSync=c;
  validateConnection(next.accountSync);if(next.accountSync.accountId!==c.accountId)fail('ACCOUNT_PROFILE_IDENTITY_MISMATCH');
  if(expected&&(next.accountRevision!==expected.revision||digest(next.config)!==expected.configDigest))fail('ACCOUNT_READBACK_CONFLICT');
 }
 async function storeProfile(p,next,item,c,connectionOnly){
  next.accountSync=c;next.cloudVersion=item.version;next.cloudUid=item.uid;
  // Host/plugin options may be non-empty in a clean sandbox; they are not an
  // explicit connection-only state. Only finish-connect carries that marker.
  if(connectionOnly===true)next.connectionOnly=true;else delete next.connectionOnly;
  await core.withLock(p.dir,()=>core.writeAtomic(cachePath(p),JSON.stringify(next)));
 }
 const pendingReceipt=a=>({ok:false,accountCommitted:null,publicationPending:a.status==='pending',outcomeUnknown:a.status!=='pending',retryBlocked:true,
  note:'The previous publication is unresolved. Read account status; do not submit again. Cached routes are retained.'});
 async function reconcile(p,c,item){
  const a=read(attemptPath(p));if(!a)return null;if(a.accountId!==c.accountId)fail('ACCOUNT_IDENTITY_MISMATCH');
  let d=item;if(a.uid)d=await request(CONTENT+'/'+encodeURIComponent(a.uid)+'?entity_type=skill',c,{},true,p);
  if(!d||d.status!=='ready')return pendingReceipt(a);
  if(item?.uid!==d.uid||item?.version!==d.version)return pendingReceipt(a);
  const restored=await download(d,c,p);validateReadback(restored,c);
  if(restored.accountRevision!==a.revision)return pendingReceipt(a);
  validateReadback(restored,c,a);if(d.version!==a.expectedVersion)fail('ACCOUNT_READBACK_CONFLICT');
  await storeProfile(p,restored,d,c,false);fs.rmSync(attemptPath(p),{force:true});
  return {ok:true,accountCommitted:true,recoveredPublication:true,revision:restored.accountRevision,version:d.version,backup:a.backup};
 }
 async function pullUnlocked(p,{strict=false}={}){
  try{
   let profile=local(p);if(!profile)return {available:false,status:'not-connected',reason:'Authorize WorkBuddy account sync before saving account defaults.'};
   const c=await credentials(p,profile),item=await metadata(c,p,true),recovery=await reconcile(p,c,item);
   if(recovery?.accountCommitted===null)return {available:true,status:'publication-unresolved',revision:profile.accountRevision||profile.cloudVersion||null,...recovery};
   if(!item)return {available:true,status:'not-published',revision:null,note:'Remote profile missing; last-good cached routes retained, not silently revoked.'};
   if(item.status!=='ready')fail('ACCOUNT_PROFILE_NOT_READY');
   profile=local(p);
   if(profile.cloudVersion!==item.version||!cached(p)){
    const next=await download(item,c,p);validateReadback(next,c);await storeProfile(p,next,item,c,profile.connectionOnly===true);profile=cached(p);
   }
   return {available:true,status:'synced',revision:profile.accountRevision||item.version,version:item.version,...(recovery?.recoveredPublication?{recoveredPublication:true}:{})};
  }catch(e){if(strict)throw e;return {available:false,status:'sync-error',reason:['ACCOUNT_LOGIN_REQUIRED','ACCOUNT_IDENTITY_MISMATCH','ACCOUNT_PROFILE_NOT_READY'].includes(e.code)?e.code:'Account sync unavailable; cached routes are retained.'};}
 }
 async function beginUnlocked(p){
  const j=await request('/v2/plugin/auth/state?platform=CLI',null,{method:'POST',headers:{'Content-Type':'application/json','X-No-Authorization':'true','X-No-User-Id':'true','X-No-Enterprise-Id':'true','X-No-Department-Info':'true'},body:'{}'});
  if(!j?.state||typeof j.authUrl!=='string')fail('ACCOUNT_LOGIN_INVALID');const u=new URL(j.authUrl);if(u.origin!==ORIGIN)fail('ACCOUNT_LOGIN_ORIGIN_REJECTED');
  core.writeAtomic(path.join(p.dir,'workbuddy-3p.account-login.json'),JSON.stringify({state:j.state,expiresAt:Date.now()+300000}));
  return {ok:true,loginRequired:true,authorizationUrl:j.authUrl,note:'Use your own WorkBuddy account. Connecting alone does not change model routing.'};
 }
 async function finishUnlocked(p){
  const pending=read(path.join(p.dir,'workbuddy-3p.account-login.json'));if(!pending||!Number.isFinite(pending.expiresAt)||pending.expiresAt<Date.now())fail('ACCOUNT_LOGIN_EXPIRED');
  const t=await request('/v2/plugin/auth/token?state='+encodeURIComponent(pending.state),null);if(!t?.accessToken||!t.refreshToken)return {ok:false,loginPending:true};
  const c={kind:'workbuddy-account',origin:ORIGIN,accountId:'pending',credentials:tokenCredentials(t)};
  const a=await request('/v2/plugin/account',c);if(!a?.uid)fail('ACCOUNT_LOGIN_INVALID');c.accountId=String(a.uid);
  const previous=local(p);if(previous?.accountSync&&previous.accountSync.accountId!==c.accountId)fail('ACCOUNT_IDENTITY_MISMATCH');
  saveConnection(p,c);fs.rmSync(path.join(p.dir,'workbuddy-3p.account-login.json'),{force:true});
  return {ok:true,accountConnected:true,accountCommitted:false,note:'Account authorized; existing routing unchanged. Save account defaults to distribute the private connection to future sandboxes.'};
 }
 async function publishUnlocked(p,cfg,expectedRevision,{confirmedConfirmationTypes=[]}={}){
  if(!Array.isArray(confirmedConfirmationTypes)||confirmedConfirmationTypes.some(x=>typeof x!=='string'||x.length>256))fail('ACCOUNT_CONFIRMATIONS_INVALID');
  const pulled=await pullUnlocked(p,{strict:true});if(pulled.retryBlocked)return pulled;
  const current=local(p);if(!current)fail('ACCOUNT_LOGIN_REQUIRED');
  const c=await credentials(p,current),before=await metadata(c,p),rev=before?current.accountRevision||before.version:null;
  if(rev!==expectedRevision)fail('ACCOUNT_REVISION_CHANGED');
  let version='1.0.0';if(before){const m=/^(\d+)\.(\d+)\.(\d+)$/.exec(before.version||'');if(!m)fail('ACCOUNT_VERSION_INVALID');version=m[1]+'.'+m[2]+'.'+(Number(m[3])+1);}
  const next={kind:'workbuddy-3p-private-profile',version:1,config:cfg,accountSync:c,accountRevision:nonce()};
  const backup=path.join(p.dir,'workbuddy-3p.backups',Date.now()+'-account-'+nonce().slice(0,12));
  fs.mkdirSync(backup,{recursive:true,mode:0o700});fs.chmodSync(backup,0o700);fs.writeFileSync(path.join(backup,'previous-account-profile.json'),JSON.stringify(current),{mode:0o600,flag:'wx'});
  const form=()=>{const zipped=packages.pack(next,version);const f=new FormData();f.append('entity_type','skill');f.append('name',NAME);f.append('title','WorkBuddy 3P private settings');f.append('description','Private provider and routing settings for this account');f.append('file',new Blob([zipped],{type:'application/zip'}),'workbuddy-3p-private-profile.zip');return f;};
  const flight=await request(CONTENT+'/preflight',c,{method:'POST',body:form()},true,p);
  if(flight.can_upload===false||flight.canUpload===false)fail('ACCOUNT_PREFLIGHT_BLOCKED');
  const confirmations=flight.confirmation_types||flight.confirmationTypes||[];
  if(!Array.isArray(confirmations)||confirmations.some(x=>typeof x!=='string'||x.length>256))fail('ACCOUNT_CONFIRMATIONS_INVALID');
  if((flight.need_confirmation||flight.needConfirmation)&&(!confirmations.length||confirmations.some(x=>!confirmedConfirmationTypes.includes(x))))return {ok:false,confirmationRequired:true,confirmationTypes:confirmations,accountCommitted:false};
  const latest=await metadata(c,p);if(latest?.uid!==before?.uid||(latest?.version||null)!==(before?.version||null))fail('ACCOUNT_REVISION_CHANGED');
  const attempt={status:'submitting',accountId:c.accountId,revision:next.accountRevision,configDigest:digest(cfg),expectedVersion:version,previousVersion:before?.version||null,backup};
  // Durable retry fence BEFORE upload: a timeout/crash never authorizes resubmission.
  core.writeAtomic(attemptPath(p),JSON.stringify(attempt));
  try{
   const submitted=await request(CONTENT,c,{method:'POST',body:form()},false,p);if(typeof submitted?.uid!=='string'||!submitted.uid)fail('ACCOUNT_UPLOAD_INVALID');
   attempt.uid=submitted.uid;attempt.status='pending';core.writeAtomic(attemptPath(p),JSON.stringify(attempt));
   for(let n=0;n<pollAttempts;n++){
    const d=await request(CONTENT+'/'+encodeURIComponent(submitted.uid)+'?entity_type=skill',c,{},true,p);
    if(d.status==='failed'||d.status==='invalid'){fs.rmSync(attemptPath(p),{force:true});return {ok:false,accountCommitted:false,error:'ACCOUNT_PROFILE_REJECTED'};}
    if(d.status==='ready'){
     const restored=await download(d,c,p);validateReadback(restored,c,attempt);if(d.version!==version)fail('ACCOUNT_READBACK_CONFLICT');
     const visible=await metadata(c,p);if(visible?.uid!==d.uid||visible?.version!==d.version)fail('ACCOUNT_READBACK_CONFLICT');
     await storeProfile(p,restored,d,c,false);fs.rmSync(attemptPath(p),{force:true});
     return {ok:true,accountCommitted:true,revision:next.accountRevision,version:d.version,backup};
    }
    if(n+1<pollAttempts)await new Promise(r=>setTimeout(r,pollIntervalMs));
   }
   return pendingReceipt(attempt);
  }catch{attempt.status='unknown';core.writeAtomic(attemptPath(p),JSON.stringify(attempt));return pendingReceipt(attempt);}
 }
 return {cached,cachePath,local,pull:(p,o)=>exclusive(p,()=>pullUnlocked(p,o)),begin:p=>exclusive(p,()=>beginUnlocked(p)),finish:p=>exclusive(p,()=>finishUnlocked(p)),
  publish:(p,cfg,revision,o)=>exclusive(p,()=>publishUnlocked(p,cfg,revision,o)),
  transaction:(p,fn)=>exclusive(p,()=>fn({pull:o=>pullUnlocked(p,o),publish:(cfg,rev,o)=>publishUnlocked(p,cfg,rev,o)}))};
}
module.exports={create,cached,cachePath,connectionPath,attemptPath,validateConnection,ORIGIN};
