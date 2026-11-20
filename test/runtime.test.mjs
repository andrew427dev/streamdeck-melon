import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {runtime} from './helpers/runtime.mjs';

test('보관함 저장과 해제는 멜론 플레이리스트를 변경하지 않습니다',async t=>{
  const app=await runtime(t,{status:{running:true,pid:1,elapsed:10,duration:180,title:'',artist:''}});
  app.appear('add','add',{destination:'favorites',list:'이전 설정'},'Keypad');
  app.send('keyDown','add','add');
  await app.until(()=>app.messages.some(m=>m.event==='setGlobalSettings'&&m.payload.favorites?.length===1));
  app.send('keyDown','add','add');
  await app.until(()=>app.messages.some(m=>m.event==='setGlobalSettings'&&m.payload.favorites?.length===0));
  assert.equal((await app.operations()).some(op=>op.op==='add'),false);
});

test('검색 설정을 바꾸면 이전 응답을 버리고 새 검색 결과를 재생합니다',async t=>{
  const app=await runtime(t,{searchDelay:300});
  app.appear('search','search',{query:'이전 검색'});
  app.send('dialRotate','search','search',{ticks:1});
  await app.until(async()=>(await app.operations()).some(op=>op.op==='fetch'&&op.query==='이전 검색'));
  app.send('didReceiveSettings','search','search',{settings:{query:'새 검색'}});
  await wait(400);
  assert.equal(app.messages.some(m=>m.context==='search'&&m.payload.value==='현재 곡'),false);
  app.send('touchTap','search','search');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='launch'&&op.args.some(a=>a.includes('cid=222&'))));
});

test('재생 제어 키만 사용할 때 커버 검색을 보내지 않습니다',async t=>{
  const app=await runtime(t);
  app.appear('play','playback',{},'Keypad');
  await app.until(()=>app.messages.some(m=>m.context==='play'&&m.event==='setTitle'));
  await wait(250);
  assert.equal((await app.operations()).some(op=>op.op==='fetch'),false);
});

test('일시정지는 진행 중인 곡 이동을 취소하고 복원 완료 후 실행합니다',async t=>{
  const app=await runtime(t,{delays:{queuePlay:5000}});
  app.appear('queue','queue');
  app.appear('pause','playback',{command:'pause'},'Keypad');
  await app.until(()=>app.messages.some(m=>m.context==='queue'&&m.payload.song==='▸ 곡 1'));
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'));
  const start=Date.now();
  app.send('keyDown','pause','playback');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='pause'),1500);
  assert.ok(Date.now()-start<1500);
  const ops=await app.operations();
  assert.ok(ops.findIndex(op=>op.op==='restored')<ops.findIndex(op=>op.op==='pause'));
  assert.ok(ops.some(op=>op.op==='cancelled'));
  assert.equal(app.messages.some(m=>m.event==='showAlert'&&m.context==='queue'),false);
});

test('새 곡 선택은 진행 중인 이동과 대기 중인 이전 선택을 취소합니다',async t=>{
  const app=await runtime(t,{delays:{queuePlay:5000}});
  app.appear('queue','queue');
  await app.until(()=>app.messages.some(m=>m.context==='queue'&&m.payload.song==='▸ 곡 1'));
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'&&op.index===1));
  await app.configure({delays:{queuePlay:0}});
  app.send('touchTap','queue','queue');
  app.send('dialRotate','queue','queue',{ticks:2});
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'&&op.index===3),1500);
  await wait(200);
  const ops=await app.operations();
  assert.deepEqual(ops.filter(op=>op.op==='queuePlay').map(op=>op.index),[1,3]);
  assert.ok(ops.findIndex(op=>op.op==='restored')<ops.findIndex(op=>op.op==='queuePlay'&&op.index===3));
  assert.equal(app.messages.some(m=>m.event==='showAlert'),false);
});

test('취침 타이머는 진행 중인 곡 이동을 중단하고 셔플 복원 후 일시정지합니다',async t=>{
  const app=await runtime(t,{delays:{queuePlay:5000}});
  app.appear('queue','queue');
  app.appear('sleep','sleep',{minutes:1},'Keypad');
  await app.until(()=>app.messages.some(m=>m.context==='queue'&&m.payload.song==='▸ 곡 1'));
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'));
  app.send('didReceiveGlobalSettings','regression','',{settings:{deadline:Date.now()-200}});
  await app.until(async()=>(await app.operations()).some(op=>op.op==='pause'),1800);
  await app.until(()=>app.messages.some(m=>m.event==='setGlobalSettings'&&m.payload.deadline===0));
  const ops=await app.operations();
  assert.ok(ops.some(op=>op.op==='cancelled'));
  assert.ok(ops.findIndex(op=>op.op==='restored')<ops.findIndex(op=>op.op==='pause'));
  assert.equal(ops.filter(op=>op.op==='queuePlay').length,1);
  assert.equal(app.messages.some(m=>m.event==='showAlert'),false);
});

test('프로필에서 대기열 동작이 사라지면 곡 이동을 취소하고 이후 입력을 무시합니다',async t=>{
  const app=await runtime(t,{delays:{queuePlay:5000}});
  app.appear('queue','queue');
  await app.until(()=>app.messages.some(m=>m.context==='queue'&&m.payload.song==='▸ 곡 1'));
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'));
  app.send('willDisappear','queue','queue');
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='restored'),1500);
  await wait(200);
  const ops=await app.operations();
  assert.ok(ops.some(op=>op.op==='cancelled'));
  assert.equal(ops.filter(op=>op.op==='queuePlay').length,1);
  assert.equal(ops.some(op=>['play','next','previous'].includes(op.op)),false);
  assert.equal(app.messages.some(m=>m.context==='queue'&&m.payload.following==='선택한 곡 재생'),false);
  assert.equal(app.messages.some(m=>m.event==='showAlert'),false);
});

for (const [operation,label] of [['trackInfo','곡 정보'],['queuePreview','대기열']]) {
  test(`곡 이동 취소 뒤에는 이전 세대 ${label} 조회보다 일시정지를 먼저 실행합니다`,async t=>{
    const app=await runtime(t,{delays:{queuePlay:5000}});
    app.appear('queue','queue');
    app.appear('pause','playback',{command:'pause'},'Keypad');
    await app.until(()=>app.messages.some(m=>m.context==='queue'&&m.payload.song==='▸ 곡 1'));
    app.send('touchTap','queue','queue');
    await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'));
    await app.configure({
      status:{running:true,pid:1,playing:true,title:'',artist:'',elapsed:0,duration:210},
      delays:{queuePlay:5000,[operation]:2200}
    });
    // This refresh queues missing credits and the queue preview behind the move.
    app.appear('display','multimedia',{showArtwork:false});
    await app.until(()=>app.messages.some(m=>m.context==='display'&&m.payload.duration==='3:30'));
    const beforePause=(await app.operations()).length;
    app.send('keyDown','pause','playback');
    await app.until(async()=>(await app.operations()).slice(beforePause).some(op=>op.op==='pause'),1500);
    const after=(await app.operations()).slice(beforePause);
    assert.ok(after.some(op=>op.op==='restored'));
    const pause=after.findIndex(op=>op.op==='pause');
    assert.equal(after.slice(0,pause).some(op=>op.op===operation),false);
    assert.equal(app.messages.some(m=>m.event==='showAlert'),false);
  });
}

test('이동 도중 중간 곡이 바뀌어도 새로 고른 곡의 위치를 유지합니다',async t=>{
  const app=await runtime(t,{delays:{queuePlay:5000}});
  app.appear('queue','queue');
  await app.until(()=>app.messages.some(m=>m.context==='queue'&&m.payload.song==='▸ 곡 1'));
  app.send('dialRotate','queue','queue',{ticks:4});
  await app.until(()=>app.messages.some(m=>m.context==='queue'&&m.payload.song==='▸ 곡 5'));
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'&&op.index===5));
  await app.configure({
    status:{running:true,pid:1,playing:true,title:'곡 2',artist:'가수',duration:210,elapsed:0},
    delays:{queuePlay:0}
  });
  app.send('dialRotate','queue','queue',{ticks:2});
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'&&op.index===7),1500);
  const operations=await app.operations();
  assert.deepEqual(operations.filter(op=>op.op==='queuePlay').map(op=>op.index),[5,7]);
  assert.ok(operations.findIndex(op=>op.op==='restored')<operations.findIndex(op=>op.op==='queuePlay'&&op.index===7));
});


test('플러그인 종료는 진행 중인 이동과 셔플 복원을 마친 뒤 완료됩니다',async t=>{
  const app=await runtime(t,{delays:{queuePlay:5000}});
  app.appear('queue','queue');
  await app.until(()=>app.messages.some(m=>m.context==='queue'&&m.payload.song==='▸ 곡 1'));
  app.send('touchTap','queue','queue');
  await app.until(async()=>(await app.operations()).some(op=>op.op==='queuePlay'));
  await app.stop();
  const ops=await app.operations();
  assert.ok(ops.some(op=>op.op==='cancelled'));
  assert.ok(ops.some(op=>op.op==='restored'));
});
