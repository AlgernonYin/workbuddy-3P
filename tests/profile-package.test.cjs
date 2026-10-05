"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const packages=require('../plugins/custom-api-models/scripts/profile-package.cjs');
const profile=()=>({kind:'workbuddy-3p-private-profile',version:1,config:{mode:'explicit',enabled:'official',providers:{}}});
const skill='---\nname: workbuddy-3p-profile\ndescription: test\nversion: 1.0.0\n---\n\nUse /models-settings.\n';
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(b){let n=0xffffffff;for(const x of b)n=crcTable[(n^x)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
function entries(){return [{name:'SKILL.md',data:Buffer.from(skill)},{name:'workbuddy-3p.profile.json',data:Buffer.from(JSON.stringify(profile()))}];}
function makeZip(files,opts={}){
 const method=opts.method==='deflate'?8:0,descriptor=opts.descriptor===true,comment=Buffer.from(opts.comment||''),locals=[],central=[];let offset=0;
 for(const file of files){
  const name=Buffer.from(file.name),raw=Buffer.from(file.data),data=method===8?zlib.deflateRawSync(raw):raw,crc=crc32(raw),flags=descriptor?0x8:0;
  const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50);lh.writeUInt16LE(20,4);lh.writeUInt16LE(flags,6);lh.writeUInt16LE(method,8);
  lh.writeUInt32LE(descriptor?0:crc,14);lh.writeUInt32LE(descriptor?0:data.length,18);lh.writeUInt32LE(descriptor?0:raw.length,22);lh.writeUInt16LE(name.length,26);
  const local=[lh,name,data];
  if(descriptor){
   const dd=Buffer.alloc(opts.descriptorSignature===false?12:16);let at=0;
   if(opts.descriptorSignature!==false){dd.writeUInt32LE(0x08074b50,at);at+=4;}
   dd.writeUInt32LE(crc,at);dd.writeUInt32LE(data.length,at+4);dd.writeUInt32LE(raw.length,at+8);local.push(dd);
  }
  const rawLocal=Buffer.concat(local);locals.push(rawLocal);
  const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(flags,8);ch.writeUInt16LE(method,10);
  ch.writeUInt32LE(crc,16);ch.writeUInt32LE(data.length,20);ch.writeUInt32LE(raw.length,24);ch.writeUInt16LE(name.length,28);ch.writeUInt32LE(offset,42);
  central.push(Buffer.concat([ch,name]));offset+=rawLocal.length;
 }
 const directory=Buffer.concat(central),eocd=Buffer.alloc(22);
 eocd.writeUInt32LE(0x06054b50);eocd.writeUInt16LE(files.length,8);eocd.writeUInt16LE(files.length,10);eocd.writeUInt32LE(directory.length,12);eocd.writeUInt32LE(offset,16);eocd.writeUInt16LE(comment.length,20);
 return Buffer.concat([...locals,directory,eocd,comment]);
}
function eocdOffset(buf){
 for(let i=buf.length-22;i>=Math.max(0,buf.length-22-0xffff);i--)if(buf.readUInt32LE(i)===0x06054b50&&i+22+buf.readUInt16LE(i+20)===buf.length)return i;
 throw Error('test ZIP has no EOCD');
}
test('keeps pack roundtrip and valid archive comment compatibility',()=>{
 const p=profile(),packed=packages.pack(p,'1.0.0');
 assert.deepEqual(packages.unpack(packed),p);
 assert.deepEqual(packages.unpack(makeZip(entries(),{comment:'ordinary archive comment'})),p);
});
test('accepts stored and deflated entries, including data descriptors',()=>{
 for(const opts of [{},{method:'deflate'},{method:'deflate',descriptor:true},{method:'deflate',descriptor:true,descriptorSignature:false}])
  assert.deepEqual(packages.unpack(makeZip(entries(),opts)),profile());
});
test('rejects EOCD comment, central directory and trailing-byte tampering',()=>{
 const base=packages.pack(profile(),'1.0.0'),end=eocdOffset(base);
 const badComment=Buffer.from(base);badComment.writeUInt16LE(1,end+20);assert.throws(()=>packages.unpack(badComment));
 assert.throws(()=>packages.unpack(Buffer.concat([base,Buffer.from('JUNK')])));
 const badOffset=Buffer.from(base);badOffset.writeUInt32LE(badOffset.readUInt32LE(end+16)+1,end+16);assert.throws(()=>packages.unpack(badOffset));
 const badSize=Buffer.from(base);badSize.writeUInt32LE(badSize.readUInt32LE(end+12)+1,end+12);assert.throws(()=>packages.unpack(badSize));
});
test('rejects local and central filename, flags, method, CRC and size mismatches',()=>{
 const base=makeZip(entries()),cases=[];
 let copy=Buffer.from(base);copy[30]^=1;cases.push(copy);
 copy=Buffer.from(base);copy.writeUInt16LE(0x800,6);cases.push(copy);
 copy=Buffer.from(base);copy.writeUInt16LE(8,8);cases.push(copy);
 copy=Buffer.from(base);copy.writeUInt32LE(copy.readUInt32LE(14)^1,14);cases.push(copy);
 copy=Buffer.from(base);copy.writeUInt32LE(copy.readUInt32LE(18)-1,18);cases.push(copy);
 for(const item of cases)assert.throws(()=>packages.unpack(item));
});
test('rejects extra entries and unreferenced data before the central directory',()=>{
 assert.throws(()=>packages.unpack(makeZip([...entries(),{name:'extra.txt',data:Buffer.from('x')}])));
 const base=makeZip(entries()),end=eocdOffset(base),central=base.readUInt32LE(end+16);
 const withGap=Buffer.concat([base.subarray(0,central),Buffer.from([0xaa]),base.subarray(central)]);
 withGap.writeUInt32LE(central+1,eocdOffset(withGap)+16);assert.throws(()=>packages.unpack(withGap));
});
test('rejects overlapping local entry ranges',()=>{
 const base=makeZip(entries()),end=eocdOffset(base),central=base.readUInt32LE(end+16);
 const firstDataStart=30+base.readUInt16LE(26)+base.readUInt16LE(28),firstSize=base.readUInt32LE(18);
 const secondCentral=central+46+base.readUInt16LE(central+28)+base.readUInt16LE(central+30)+base.readUInt16LE(central+32);
 const secondLocal=base.readUInt32LE(secondCentral+42);assert.equal(secondLocal,firstDataStart+firstSize);
 const overlapSize=firstSize+1,crc=crc32(base.subarray(firstDataStart,firstDataStart+overlapSize)),bad=Buffer.from(base);
 bad.writeUInt32LE(crc,14);bad.writeUInt32LE(overlapSize,18);bad.writeUInt32LE(overlapSize,22);
 bad.writeUInt32LE(crc,central+16);bad.writeUInt32LE(overlapSize,central+20);bad.writeUInt32LE(overlapSize,central+24);
 assert.throws(()=>packages.unpack(bad));
});
test('rejects invalid deflate data descriptors',()=>{
 const base=makeZip(entries(),{method:'deflate',descriptor:true}),end=eocdOffset(base),central=base.readUInt32LE(end+16);
 const dataStart=30+base.readUInt16LE(26)+base.readUInt16LE(28),descriptor=dataStart+base.readUInt32LE(central+20),bad=Buffer.from(base);
 bad.writeUInt32LE(bad.readUInt32LE(descriptor+4)^1,descriptor+4);assert.throws(()=>packages.unpack(bad));
});
