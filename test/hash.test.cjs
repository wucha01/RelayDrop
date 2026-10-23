'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const RelayHash=require('../public/sha256.js');
const expected=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('SHA-256 known vectors and million-byte vector',()=>{
  for(const [input,hex] of [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc','ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq','248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1']
  ])assert.equal(RelayHash.hex(Buffer.from(input)),hex);
  assert.equal(RelayHash.hex(Buffer.alloc(1000000,97)),'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('incremental SHA-256 matches native hash at padding and block boundaries',()=>{
  for(const length of [0,1,2,7,31,55,56,57,63,64,65,119,120,127,128,129,255,256,257,65535,65536,65537,1048575,1048576,1048577]){
    const data=crypto.randomBytes(length),hex=expected(data);assert.equal(RelayHash.hex(data),hex,`single ${length}`);
    for(const chunkSize of [1,7,55,63,64,65,127,4093,65536,1048576]){
      // Byte-sized chunks exercise small buffers without spending a million calls per vector.
      if(length>65537&&chunkSize<4093)continue;
      const digest=RelayHash.create();digest.update(new Uint8Array(0));for(let offset=0;offset<data.length;offset+=chunkSize)digest.update(data.subarray(offset,offset+chunkSize));
      assert.equal(digest.hex(),hex,`length ${length}, chunk ${chunkSize}`);assert.equal(digest.hex(),hex,'repeated finalize');assert.throws(()=>digest.update(Buffer.from([1])),/finalized/);
    }
  }
});

test('random chunk partitions and typed-array offsets preserve the byte stream',()=>{
  for(let i=0;i<24;i++){
    const length=crypto.randomInt(0,250000),buffer=crypto.randomBytes(length+29),bytes=buffer.subarray(13,13+length),digest=RelayHash.create();
    for(let offset=0;offset<bytes.length;){const n=crypto.randomInt(1,8193);const part=bytes.subarray(offset,Math.min(offset+n,bytes.length));digest.update(new DataView(part.buffer,part.byteOffset,part.byteLength));offset+=part.length;}
    assert.equal(digest.hex(),expected(bytes));
  }
});

test('streaming many fixed-size chunks matches native digest without whole-input storage',()=>{
  const piece=crypto.randomBytes(1048576),digest=RelayHash.create(),native=crypto.createHash('sha256');
  for(let i=0;i<24;i++){digest.update(piece);native.update(piece);}assert.equal(digest.hex(),native.digest('hex'));
});

test('same size and same first/last 64 KiB with changed middle produce distinct full fingerprints',()=>{
  const original=Buffer.alloc(3*1048576+11,91),changed=Buffer.from(original);changed[1048576+123]^=255;
  assert.deepEqual(original.subarray(0,65536),changed.subarray(0,65536));assert.deepEqual(original.subarray(-65536),changed.subarray(-65536));
  const a=RelayHash.create(),b=RelayHash.create();for(let p=0;p<original.length;p+=1048576){a.update(original.subarray(p,p+1048576));b.update(changed.subarray(p,p+1048576));}assert.notEqual(a.hex(),b.hex());assert.equal(a.hex(),expected(original));assert.equal(b.hex(),expected(changed));
});
