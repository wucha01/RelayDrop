/* Incremental SHA-256 for LAN HTTP. Fixed-size state; no whole-file allocation. */
(function(root){'use strict';
  const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const rotate=(x,n)=>(x>>>n)|(x<<(32-n));
  function asBytes(input){if(input instanceof Uint8Array)return input;if(ArrayBuffer.isView(input))return new Uint8Array(input.buffer,input.byteOffset,input.byteLength);return new Uint8Array(input);}
  function create(){
    const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const words=new Uint32Array(64),pending=new Uint8Array(64);let used=0,total=0,result=null;
    function compress(bytes,offset){
      for(let i=0;i<16;i++){const p=offset+i*4;words[i]=(bytes[p]<<24)|(bytes[p+1]<<16)|(bytes[p+2]<<8)|bytes[p+3];}
      for(let i=16;i<64;i++){const a=words[i-15],b=words[i-2];words[i]=(words[i-16]+(rotate(a,7)^rotate(a,18)^(a>>>3))+words[i-7]+(rotate(b,17)^rotate(b,19)^(b>>>10)))>>>0;}
      let a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],j=h[7];
      for(let i=0;i<64;i++){const t1=(j+(rotate(e,6)^rotate(e,11)^rotate(e,25))+((e&f)^(~e&g))+K[i]+words[i])>>>0;const t2=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&b)^(a&c)^(b&c)))>>>0;j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+j)>>>0;
    }
    const api={
      update(input){
        if(result!==null)throw new Error('SHA-256 has already been finalized');const bytes=asBytes(input);const next=total+bytes.length;if(!Number.isSafeInteger(next)||next>Number.MAX_SAFE_INTEGER/8)throw new RangeError('SHA-256 input is too large');total=next;let offset=0;
        if(used){const take=Math.min(64-used,bytes.length);pending.set(bytes.subarray(0,take),used);used+=take;offset+=take;if(used===64){compress(pending,0);used=0;}}
        while(offset+64<=bytes.length){compress(bytes,offset);offset+=64;}
        if(offset<bytes.length){pending.set(bytes.subarray(offset),0);used=bytes.length-offset;}
        return api;
      },
      hex(){
        if(result!==null)return result;const tail=new Uint8Array(used<56?64:128);tail.set(pending.subarray(0,used));tail[used]=128;const view=new DataView(tail.buffer),bits=total*8;view.setUint32(tail.length-8,Math.floor(bits/4294967296));view.setUint32(tail.length-4,bits>>>0);compress(tail,0);if(tail.length===128)compress(tail,64);result=Array.from(h,v=>v.toString(16).padStart(8,'0')).join('');return result;
      }
    };return api;
  }
  function hex(input){return create().update(input).hex();}
  root.RelayHash={create,hex};if(typeof module!=='undefined')module.exports=root.RelayHash;
})(typeof globalThis!=='undefined'?globalThis:this);
