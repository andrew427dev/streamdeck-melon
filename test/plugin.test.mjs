import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {collection,playURL} from '../local.melon.deck.sdPlugin/bin/catalog.mjs';

test('멜론 컬렉션의 종류, 이름, 재생 주소를 보존합니다',()=>{
 const items=collection('밤편지 | https://www.melon.com/song/detail.htm?songId=30314784\n앨범 | album:10047890\n목록 | playlist:1234');
 assert.deepEqual(items.map(i=>i.type),['song','album','playlist']);
 assert.deepEqual(items.map(i=>new URL(playURL(i)).searchParams.get('cflag')),['1','2','23']);
 assert.equal(items[0].title,'밤편지');
 assert.throws(()=>collection('https://example.org/song/detail.htm?songId=30314784'));
 assert.throws(()=>collection('song:abc'));
});

test('Stream Deck 이벤트를 실제 진입점에서 볼륨, 클릭, 대기열, 타이머로 연결합니다',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'melon-deck-test-'));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const bin=fileURLToPath(new URL('../local.melon.deck.sdPlugin/bin/',import.meta.url));
 const runtime=join(temp,'bin');
 await cp(bin,runtime,{recursive:true});
 await cp(join(bin,'../imgs'),join(temp,'imgs'),{recursive:true});
 await writeFile(join(runtime,'MelonBridge'),'#!/usr/bin/env node\n'+`
  const fs=require('node:fs'); const r=JSON.parse(fs.readFileSync(0,'utf8'));
  fs.appendFileSync(process.env.MELON_TEST_EVENTS,JSON.stringify(r)+'\\n');
  const data=r.op==='status'?{running:true,playing:true,volume:50}:r.op==='queue'?{index:r.index??2,title:'테스트',artist:'가수',count:10}:{};
  process.stdout.write(JSON.stringify({ok:true,data}));`,{mode:0o644});
 // Mock only the device transport. The plugin uses its real registration, dispatcher and helper path.
 await writeFile(join(temp,'transport.cjs'),`
  global.WebSocket=class {
   static OPEN=1; readyState=1;
   constructor(){this.handlers={};process.on('message',m=>this.handlers.message?.({data:JSON.stringify(m)}));setImmediate(()=>this.handlers.open());}
   addEventListener(k,fn){this.handlers[k]=fn}
   send(raw){process.send(JSON.parse(raw))}
  };`);
 const log=join(temp,'operations'),messages=[];
 const child=fork(join(runtime,'plugin.js'),['-port','1','-pluginUUID','test','-registerEvent','registerPlugin'],{
  env:{...process.env,MELON_TEST_EVENTS:log},execArgv:['--require',join(temp,'transport.cjs')],silent:true});
 t.after(()=>child.kill());
 child.on('message',v=>messages.push(v));
 async function until(predicate) {
   for(let i=0;i<100;i++){if(await predicate())return;await wait(30);}
   assert.fail('기대한 이벤트가 도착하지 않았습니다');
 }
 const ops=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').map(x=>JSON.parse(x)).filter(x=>x.op!=='status');}catch{return [];}};
 const send=(event,context,payload={},kind='multimedia')=>child.send({event,context,payload,action:'local.melon.deck.'+kind});
 await until(()=>messages.some(m=>m.event==='registerPlugin'&&m.uuid==='test'));
 send('didReceiveGlobalSettings','test',{settings:{}});
 send('willAppear','dial',{controller:'Encoder',settings:{showArtwork:false}});
 send('dialRotate','dial',{pressed:false,ticks:2});
 await until(async()=>(await ops()).some(x=>x.op==='volume'&&x.delta===10));
 send('dialDown','dial');send('dialRotate','dial',{pressed:true,ticks:-1});send('dialUp','dial');
 await until(async()=>(await ops()).some(x=>x.op==='previous'));
 for(let i=0;i<2;i++){send('dialDown','dial');send('dialUp','dial');}
 await until(async()=>(await ops()).some(x=>x.op==='next'));
 for(let i=0;i<3;i++){send('dialDown','dial');send('dialUp','dial');}
 await until(async()=>(await ops()).filter(x=>x.op==='previous').length===2);
 assert.equal((await ops()).filter(x=>x.op==='toggle').length,0);
 send('willAppear','q',{controller:'Encoder',settings:{}},'queue');
 send('dialRotate','q',{ticks:3},'queue');
 await until(()=>messages.some(m=>m.context==='q'&&m.payload?.hint?.startsWith('6 / 10')));
 send('touchTap','q',{},'queue');
 await until(async()=>(await ops()).some(x=>x.op==='queuePlay'&&x.index===5&&x.title==='테스트'));
 send('willAppear','timer',{controller:'Keypad',settings:{minutes:1}},'sleep');
 send('keyDown','timer',{},'sleep');
 await until(()=>messages.some(m=>m.event==='setGlobalSettings'&&m.payload.deadline>Date.now()));
 send('keyDown','timer',{},'sleep');
 await until(()=>messages.some(m=>m.event==='setGlobalSettings'&&m.payload.deadline===0));
 send('didReceiveGlobalSettings','test',{settings:{deadline:Date.now()-200}});
 await until(async()=>(await ops()).some(x=>x.op==='pause'));
});
