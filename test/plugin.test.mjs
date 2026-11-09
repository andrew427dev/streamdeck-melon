import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {keyLine,keySVG,stripFeedback} from '../local.melon.deck.sdPlugin/bin/faces.mjs';
import {albumFromListing,collection,playURL} from '../local.melon.deck.sdPlugin/bin/catalog.mjs';

test('실행 및 종료 화면에서 같은 깊이의 요소가 서로 겹치지 않습니다',async()=>{
 for(const layout of ['launch','queue','transport']){
   const path=new URL('../local.melon.deck.sdPlugin/layouts/'+layout+'.json',import.meta.url);
   const {items}=JSON.parse(await readFile(path,'utf8'));
   for(const [index,a] of items.entries()){
     for(const b of items.slice(index+1)){
       if((a.zOrder??0)!==(b.zOrder??0)) continue;
       const [x,y,w,h]=a.rect, [bx,by,bw,bh]=b.rect;
       assert.ok(x+w<=bx || bx+bw<=x || y+h<=by || by+bh<=y,layout+' / '+a.key+' / '+b.key);
     }
   }
 }
});

test('멜론 컬렉션의 종류, 이름, 재생 주소를 보존합니다',()=>{
 const items=collection('밤편지 | https://www.melon.com/song/detail.htm?songId=30314784\n앨범 | album:10047890\n목록 | playlist:1234');
 assert.deepEqual(items.map(i=>i.type),['song','album','playlist']);
 assert.deepEqual(items.map(i=>new URL(playURL(i)).searchParams.get('cflag')),['1','2','23']);
 assert.equal(items[0].title,'밤편지');
 assert.throws(()=>collection('https://example.org/song/detail.htm?songId=30314784'));
 assert.throws(()=>collection('song:abc'));
});

test('동명곡의 커버는 가수와 앨범이 일치하는 행에서만 선택합니다',()=>{
 const listing = `<tr><td><a href="javascript:melon.play.playSong('x',12);">Song&nbsp;One</a></td>
 <td><a href="javascript:melon.link.goArtistDetail('5');">Singer</a></td>
 <td><a href="javascript:melon.link.goAlbumDetail('120');">Record</a></td></tr>`;
 const track={title:'Song One',artist:'Singer',album:'Record'};
 assert.equal(albumFromListing(listing,track),'120');
 assert.equal(albumFromListing(listing,{...track,album:'Other'}),'');
 assert.equal(albumFromListing(listing,{...track,artist:'Other'}),'');
});

test('키 제목과 긴 곡명은 첫 글자와 글자 단위를 보존합니다',()=>{
 assert.equal(keyLine('전체 반복'),'전체 반복');
 assert.equal(keyLine('취침 30분'),'취침 30분');
 assert.match(keyLine("Making Believe, You're Here"),/^Making.*…$/);
 assert.match(keyLine('🎧'.repeat(14)),/^🎧+…$/u);
 assert.match(keyLine('가'.repeat(15)),/^가+…$/u);
 assert.ok(keyLine('Wide WWWWWWWW',18).length<keyLine('Wide WWWWWWWW',10).length);
 const cover='data:image/png;base64,AA==';
 assert.match(keySVG('now',{lines:2,cover}),/<image .*height="(?!72)[0-9.]+"/);
 const plain=stripFeedback({title:'재생 중',value:'곡',hint:'가수',level:50,showLevel:false});
 const withArt=stripFeedback({title:'재생 중',value:'곡',hint:'가수',cover,level:50,showLevel:false});
 assert.equal(plain.cover,undefined);
 assert.equal(withArt.cover,cover);
 assert.equal(plain.level.enabled,false);
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
  const data=r.op==='status' && fs.existsSync(process.env.MELON_TEST_EVENTS+'.closed')?{running:false}:r.op==='status'?{elapsed:93,duration:300,running:true,playing:true,volume:50,title:'오래 기억하고 싶은 노래',artist:'긴 이름의 아티스트'}:r.op==='queuePreview'?{index:2,title:'대기 곡',artist:'다음 가수',count:10,nextTitle:'다다음 곡'}:r.op==='queue'?{index:r.index??2,title:'테스트',artist:'가수',count:10}:{};
  process.stdout.write(JSON.stringify({ok:true,data}));`,{mode:0o644});
 // Mock only the device transport. The plugin uses its real registration, dispatcher and helper path.
 await writeFile(join(temp,'transport.cjs'),`
  const fs=require('node:fs'),cp=require('node:child_process');
  const exec=cp.execFile;
  cp.execFile=(file,args,options,callback)=>{
    if(file!=='/usr/bin/open') return exec(file,args,options,callback);
    fs.appendFileSync(process.env.MELON_TEST_EVENTS,JSON.stringify({op:'launch',args})+'\\n');
    fs.unlinkSync(process.env.MELON_TEST_EVENTS+'.closed');
    callback(null,'','');
  };
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
 send('willAppear','track',{controller:'Keypad',settings:{showArtwork:false}},'now');
 await until(()=>messages.some(m=>m.event==='setTitle' && m.context==='track' &&
   m.payload.title===keyLine('오래 기억하고 싶은 노래')+'\n'+keyLine('긴 이름의 아티스트')));
 assert.ok(messages.some(m=>m.event==='setFeedbackLayout' && m.context==='dial' && m.payload.layout==='layouts/transport.json'));
 send('dialRotate','dial',{pressed:false,ticks:2});
 await until(async()=>(await ops()).some(x=>x.op==='volume'&&x.delta===10));
 send('dialDown','dial');send('dialRotate','dial',{pressed:true,ticks:-1});send('dialUp','dial');
 await until(async()=>(await ops()).some(x=>x.op==='previous'));
 for(let i=0;i<2;i++){send('dialDown','dial');send('dialUp','dial');}
 await until(async()=>(await ops()).some(x=>x.op==='next'));
 for(let i=0;i<3;i++){send('dialDown','dial');send('dialUp','dial');}
 await until(async()=>(await ops()).filter(x=>x.op==='previous').length===2);
 assert.equal((await ops()).filter(x=>x.op==='toggle').length,0);
 assert.ok(messages.some(m=>m.context==='dial' && m.payload?.elapsed==='1:33' && m.payload.duration==='5:00' && m.payload.progress.value===31));
 send('willAppear','q',{controller:'Encoder',settings:{}},'queue');
 await until(()=>messages.some(m=>m.context==='q' && m.payload?.song==='▸ 대기 곡' && m.payload.following==='↳ 다다음 곡'));
 send('dialRotate','q',{ticks:3},'queue');
 await until(()=>messages.some(m=>m.context==='q'&&m.payload?.song==='▸ 테스트'));
 send('touchTap','q',{},'queue');
 await until(async()=>(await ops()).some(x=>x.op==='queuePlay'&&x.index===5&&x.title==='테스트'));
 send('willAppear','timer',{controller:'Keypad',settings:{minutes:1}},'sleep');
 send('keyDown','timer',{},'sleep');
 await until(()=>messages.some(m=>m.event==='setGlobalSettings'&&m.payload.deadline>Date.now()));
 send('keyDown','timer',{},'sleep');
 await until(()=>messages.some(m=>m.event==='setGlobalSettings'&&m.payload.deadline===0));
 send('didReceiveGlobalSettings','test',{settings:{deadline:Date.now()-200}});
 await until(async()=>(await ops()).some(x=>x.op==='pause'));
 for(const [id,kind,event] of [['q','queue','touchTap'],['dial','multimedia','dialUp']]){
   messages.length=0;
   await writeFile(log+'.closed','');
   await until(()=>['dial','q'].every(id=>messages.some(m=>m.context===id && m.payload?.launch==='멜론 열기' && m.payload.status==='실행 중 아님')));
   const countBefore=(await ops()).length;
   send('dialRotate',id,{ticks:1},kind);
   await wait(150);
   assert.equal((await ops()).length,countBefore);
   send(event,id,{},kind);
   await until(async()=>(await ops()).slice(countBefore).some(x=>x.op==='launch'));
   await until(()=>messages.some(m=>m.context===id && m.payload?.layout==='layouts/'+(kind==='queue'?'queue':'transport')+'.json'));
   await until(async()=>(await ops()).slice(countBefore).some(x=>x.op==='queuePreview' && x.restoreOnLaunch===true));
   const launched=(await ops()).slice(countBefore).filter(x=>x.op!=='queuePreview');
   assert.deepEqual(launched,[{op:'launch',args:['-b','com.iloen.macmelon']}]);
 }
});
