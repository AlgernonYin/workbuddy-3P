const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../plugins/custom-api-models/scripts/sync-models.cjs');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb3p-profile-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env={...process.env,CODEBUDDY_CONFIG_DIR:dir};
  for(const k of Object.keys(env)) if(/^(WB3P_|CODEBUDDY_PLUGIN_OPTION_|CLAUDE_PLUGIN_OPTION_)/.test(k)) delete env[k];
  env.WB3P_PARAMETER_PRIORITY='native';
  function put(folder,value) {
    fs.mkdirSync(path.join(dir,'skills',folder),{recursive:true});
    fs.writeFileSync(path.join(dir,'skills',folder,'SKILL.md'),'---\nname: workbuddy-3p-profile\n---\n');
    fs.writeFileSync(path.join(dir,'skills',folder,'workbuddy-3p.profile.json'),typeof value==='string'?value:JSON.stringify(value));
  }
  const config={mode:'explicit',providers:{p:{baseUrl:'https://test.invalid/v1',apiKey:'fake-profile-secret'}},routes:{'glm-5.3':'foo'}};
  return {dir,env,put,profile:{kind:'workbuddy-3p-private-profile',version:1,config},run:(...args)=>spawnSync(process.execPath,[script,...args],{env,encoding:'utf8'})};
}
test('cloud private profile routes and survives official/third-party switching without exposing key',t=>{
  const f=fixture(t); f.put('server-assigned-skill-id',f.profile);
  let r=f.run(); assert.equal(r.status,0,r.stderr); assert.ok(!r.stdout.includes('fake-profile-secret'));
  assert.equal(JSON.parse(r.stdout).active,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir,'models.json'))).models[0].id,'foo');
  assert.equal(JSON.parse(f.run('--official').stdout).active,false);
  assert.equal(JSON.parse(f.run('--third-party').stdout).active,true);
});
test('multiple cloud profiles fail closed and leave models untouched',t=>{
  const f=fixture(t);f.put('a',f.profile);f.put('b',f.profile);
  const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/multiple cloud profiles/);
  assert.equal(fs.existsSync(path.join(f.dir,'models.json')),false);
});
test('malformed profile errors never quote secret JSON fragments',t=>{
  const f=fixture(t);f.put('a','{"apiKey":"fake-profile-secret",BROKEN');
  const r=f.run();assert.notEqual(r.status,0);assert.ok(!r.stderr.includes('fake-profile-secret'));
});
test('repeated switches preserve models inode for CodeBuddy fs.watch',t=>{
  const f=fixture(t); f.put('a',f.profile); assert.equal(f.run().status,0);
  const target=path.join(f.dir,'models.json'), inode=fs.statSync(target).ino;
  for(const mode of ['--official','--third-party','--official','--third-party']) {
    const r=f.run(mode);assert.equal(r.status,0,r.stderr);
    assert.equal(fs.statSync(target).ino,inode,'rename would detach the host watcher');
    JSON.parse(fs.readFileSync(target));
  }
});

test('profile requires its skill name in YAML front matter, not body text',t=>{
  const f=fixture(t); f.put('a',f.profile);
  for(const skill of ['---\nname: other-skill\n---\nname: workbuddy-3p-profile\n','plain body\nname: workbuddy-3p-profile\n']) {
    fs.writeFileSync(path.join(f.dir,'skills','a','SKILL.md'),skill);
    const r=f.run();assert.notEqual(r.status,0);assert.match(r.stderr,/must belong/);
    assert.equal(fs.existsSync(path.join(f.dir,'models.json')),false);
  }
});
