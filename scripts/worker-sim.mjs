// Simulation of the exact worker readImage logic (data path) on a real file.
import fs from 'node:fs';
import { McapIndexedReader } from '@mcap/core';
import { BlobReadable } from '@mcap/browser';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const zstd = require('@foxglove/wasm-zstd'); await zstd.isLoaded;

const U32=(v,o)=>v.getUint32(o,true), I32=(v,o)=>v.getInt32(o,true), U16=(v,o)=>v.getUint16(o,true);
function parseCompressedImage(buffer){
  const view=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength);
  const table=U32(view,0); const vtable=table-I32(view,table);
  const fo=(i)=>{const o=U16(view,vtable+4+i*2); return o? table+o : undefined;};
  const rs=(i)=>{const f=fo(i); if(f===undefined) return ''; const s=f+U32(view,f); const n=U32(view,s); return new TextDecoder().decode(buffer.subarray(s+4,s+4+n));};
  let data=new Uint8Array(0); const df=fo(2);
  if(df!==undefined){const vec=df+U32(view,df); const n=U32(view,vec); data=buffer.subarray(vec+4,vec+4+n);}
  return { format: rs(3), frameId: rs(1), data };
}
function lastIndexLE(msgs,target){let lo=0,hi=msgs.length-1,ans=-1; while(lo<=hi){const mid=(lo+hi)>>1; if(msgs[mid].logTime<=target){ans=mid;lo=mid+1;}else hi=mid-1;} return ans;}

const file = fs.readFileSync('storage/Town02_truck_collision.mcap');
const reader = await McapIndexedReader.Initialize({
  readable: new BlobReadable(new Blob([file])),
  decompressHandlers: { zstd: (b,n)=>new Uint8Array(zstd.decompress(b,Number(n))) },
});
const st = reader.statistics;
const TOPICS = [...reader.channelsById.values()].map(c=>c.topic).filter(t=>t.includes('/image/compressed'));
console.log('start:', st.messageStartTime.toString());

// rawCache per topic (same as in the worker)
const rawCache = new Map();
async function getTopicMessages(topic){
  if (rawCache.has(topic)) return rawCache.get(topic);
  const msgs=[]; for await (const m of reader.readMessages({topics:[topic]})) msgs.push(m);
  msgs.sort((a,b)=> a.logTime<b.logTime?-1:a.logTime>b.logTime?1:a.sequence-b.sequence);
  rawCache.set(topic,msgs); return msgs;
}

// playback simulation: first frame, then 5 ticks forward
const sims = [st.messageStartTime, st.messageStartTime+1n*100000000n, st.messageStartTime+2n*100000000n, st.messageStartTime+10n*100000000n];
for (const t of sims) {
  const res = [];
  for (const topic of TOPICS) {
    const msgs = await getTopicMessages(topic);
    const i = lastIndexLE(msgs, t);
    if (i < 0) { res.push(topic+': NO FRAME (i<0)'); continue; }
    const img = parseCompressedImage(msgs[i].data);
    const ok = img.format==='jpeg' && img.data[0]===0xff && img.data[1]===0xd8 && img.data[img.data.length-1]===0xd9;
    res.push(`${topic.split('/')[1]}: idx=${i} logTime=${msgs[i].logTime.toString()} ok=${ok?'YES':'NO'} jpeg=${img.data.length}B`);
  }
  console.log(`\nt=${(Number(t-st.messageStartTime)/1e8)} frame:`);
  res.forEach(r=>console.log('  ', r));
}
