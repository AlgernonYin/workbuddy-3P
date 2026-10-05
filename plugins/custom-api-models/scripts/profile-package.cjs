"use strict";
// Private bytes stay inside the caller; never return archive data to MCP/UI.
const zlib=require('node:zlib');
const limit=2*1024*1024;
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(b){let n=0xffffffff;for(const x of b)n=crcTable[(n^x)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function pack(profile,version) {
 if(!profile||profile.kind!=='workbuddy-3p-private-profile'||profile.version!==1||!profile.config||!/^\d+\.\d+\.\d+$/.test(version))throw Error('invalid account profile');
 const skill=`---\nname: workbuddy-3p-profile\ndescription: Private WorkBuddy 3P configuration consumed by the installed plugin. Do not open or quote adjacent private runtime data.\nversion: ${version}\n---\n\nUse /models-settings to manage providers, imported models and routes.\nThe adjacent JSON is private runtime data and may contain API and account sync credentials.\nDo not print or attach it to a conversation or publish it.\n`;
 const files=[['SKILL.md',Buffer.from(skill)],['workbuddy-3p.profile.json',Buffer.from(JSON.stringify(profile))]];
 const local=[],central=[];let offset=0;
 for(const [name,data]of files){const n=Buffer.from(name),crc=crc32(data),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt32LE(crc,14);h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);local.push(h,n,data);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+data.length;}
 const directory=Buffer.concat(central),tail=Buffer.alloc(22);tail.writeUInt32LE(0x06054b50);tail.writeUInt16LE(files.length,8);tail.writeUInt16LE(files.length,10);tail.writeUInt32LE(directory.length,12);tail.writeUInt32LE(offset,16);const result=Buffer.concat([...local,directory,tail]);if(result.length>limit)throw Error('account profile too large');return result;
}
const EOCD=0x06054b50,CENTRAL=0x02014b50,LOCAL=0x04034b50,DESCRIPTOR=0x08074b50;
const invalid=()=>{throw Error('invalid account package');};
function findEocd(buf){
 const min=Math.max(0,buf.length-22-0xffff);
 for(let i=buf.length-22;i>=min;i--){
  if(buf.readUInt32LE(i)!==EOCD)continue;
  const comment=buf.readUInt16LE(i+20);
  if(i+22+comment===buf.length)return i;
 }
 invalid();
}
function descriptorEnd(buf,at,end,crc,size,decoded){
 if(at+16<=end&&buf.readUInt32LE(at)===DESCRIPTOR&&buf.readUInt32LE(at+4)===crc&&
    buf.readUInt32LE(at+8)===size&&buf.readUInt32LE(at+12)===decoded)return at+16;
 if(at+12<=end&&buf.readUInt32LE(at)===crc&&buf.readUInt32LE(at+4)===size&&buf.readUInt32LE(at+8)===decoded)return at+12;
 invalid();
}
function unpack(buf) {
 if(!Buffer.isBuffer(buf)||buf.length>limit||buf.length<22)invalid();
 const end=findEocd(buf);
 if(buf.readUInt16LE(end+4)||buf.readUInt16LE(end+6))invalid();
 const count=buf.readUInt16LE(end+10),size=buf.readUInt32LE(end+12),start=buf.readUInt32LE(end+16);
 if(count!==2||start+size!==end||start>end)invalid();
 let at=start,profile=null,skill=null,total=0;const ranges=[];
 for(let k=0;k<count;k++){
  if(at+46>end||buf.readUInt32LE(at)!==CENTRAL)invalid();
  const flags=buf.readUInt16LE(at+8),method=buf.readUInt16LE(at+10),crc=buf.readUInt32LE(at+16),size=buf.readUInt32LE(at+20),decoded=buf.readUInt32LE(at+24),n=buf.readUInt16LE(at+28),extra=buf.readUInt16LE(at+30),comment=buf.readUInt16LE(at+32),pos=buf.readUInt32LE(at+42);
  if(at+46+n+extra+comment>end||flags&1||(method!==0&&method!==8)||decoded>limit||(total+=decoded)>limit)invalid();
  const centralName=buf.subarray(at+46,at+46+n),name=centralName.toString();
  if(name!=='SKILL.md'&&name!=='workbuddy-3p.profile.json')invalid();
  if(pos+30>start||buf.readUInt32LE(pos)!==LOCAL)invalid();
  const localFlags=buf.readUInt16LE(pos+6),localMethod=buf.readUInt16LE(pos+8),localCrc=buf.readUInt32LE(pos+14),localSize=buf.readUInt32LE(pos+18),localDecoded=buf.readUInt32LE(pos+22),localN=buf.readUInt16LE(pos+26),localExtra=buf.readUInt16LE(pos+28);
  const localNameStart=pos+30,localNameEnd=localNameStart+localN,dataStart=localNameEnd+localExtra;
  if(localNameEnd>start||dataStart>start||!buf.subarray(localNameStart,localNameEnd).equals(centralName)||localFlags!==flags||localMethod!==method)invalid();
  let entryEnd;
  if(flags&0x8){
   if(localCrc||localSize||localDecoded)invalid();
   entryEnd=descriptorEnd(buf,dataStart+size,start,crc,size,decoded);
  }else{
   if(localCrc!==crc||localSize!==size||localDecoded!==decoded)invalid();
   entryEnd=dataStart+size;
  }
  if(entryEnd>start)invalid();
  ranges.push([pos,entryEnd]);
  const raw=buf.subarray(dataStart,dataStart+size);let data;
  if(method===0){if(size!==decoded)invalid();data=raw;}
  else{try{data=zlib.inflateRawSync(raw,{maxOutputLength:limit});}catch{invalid();}}
  if(!data||data.length!==decoded||crc32(data)!==crc)invalid();
  if(name==='SKILL.md'){if(skill!==null)invalid();skill=data.toString();}
  else{if(profile!==null)invalid();try{profile=JSON.parse(data);}catch{invalid();}}
  at+=46+n+extra+comment;
 }
 if(at!==end)invalid();
 ranges.sort((a,b)=>a[0]-b[0]);
 let cursor=0;for(const [s,e] of ranges){if(s!==cursor||e<s)invalid();cursor=e;}
 if(cursor!==start)invalid();
 if(!skill||!/^name:\s*workbuddy-3p-profile\s*$/m.test(skill)||profile?.kind!=='workbuddy-3p-private-profile'||profile.version!==1||!profile.config)invalid();
 return profile;
}
module.exports={pack,unpack};
