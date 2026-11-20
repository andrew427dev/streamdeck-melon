import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as settle} from 'node:timers/promises';
import {trackReader} from '../local.melon.deck.sdPlugin/bin/now-playing.mjs';
import {coverFor} from '../local.melon.deck.sdPlugin/bin/catalog.mjs';
import {dialStrip} from '../local.melon.deck.sdPlugin/bin/strips.mjs';

const status = {running:true,pid:1,duration:180,elapsed:0,playing:false};
const first = {title:'첫 곡',artist:'가수',album:'첫 앨범'};
const second = {title:'다음 곡',artist:'다른 가수',album:'다음 앨범'};

test('곡 이동을 명시하면 같은 길이에서도 이전 조회와 캐시를 버립니다',async()=>{
  const jobs=[],updates=[];
  const read=trackReader(()=>new Promise(resolve=>jobs.push(resolve)),value=>updates.push(value));
  read(status,1000);
  read.invalidate();
  read(status,2000);
  jobs.shift()(first);
  await settle(0);
  assert.equal(updates.length,0);
  jobs.shift()(second);
  await settle(0);
  assert.equal(updates[0].title,second.title);
  assert.equal(read(status,3000).title,second.title);
});

test('가사에 가려진 같은 길이의 곡도 주기적으로 재확인합니다',async()=>{
  let calls=0;
  const updates=[];
  const read=trackReader(async()=>++calls===1?first:second,value=>updates.push(value));
  read(status,1000);
  await settle(0);
  assert.equal(read(status,30000).title,first.title);
  assert.equal(calls,1);
  read(status,31000);
  await settle(0);
  assert.equal(calls,2);
  assert.equal(updates.at(-1).title,second.title);
  assert.equal(read(status,32000).album,second.album);
});

test('일시적인 곡 정보 실패는 2초 후 재시도하고 성공하면 캐시합니다',async()=>{
  let calls=0;
  const read=trackReader(async()=>{
    if(++calls===1) throw Error('일시적 읽기 실패');
    return first;
  },()=>{});
  read(status,1000);
  await settle(0);
  read(status,2999);
  assert.equal(calls,1);
  read(status,3000);
  await settle(0);
  assert.equal(read(status,4000).title,first.title);
  assert.equal(calls,2);
});

test('실패 재시도 간격은 늘어나고 성공하면 초기화됩니다',async()=>{
  let calls=0;
  const read=trackReader(async()=>{
    calls++;
    if(calls<3) throw Error('일시적 읽기 실패');
    return first;
  },()=>{});
  read(status,1000);await settle(0);
  read(status,3000);await settle(0);
  read(status,6999);assert.equal(calls,2);
  read(status,7000);await settle(0);
  assert.equal(read(status,8000).title,first.title);
});

test('새 원시 곡명과 앱 종료 뒤에는 오래된 비동기 결과를 표시하지 않습니다',async()=>{
  const jobs=[],updates=[];
  const read=trackReader(()=>new Promise(resolve=>jobs.push(resolve)),value=>updates.push(value));
  read(status,1000);
  read({...status,...second},2000);
  jobs.shift()(first);await settle(0);
  assert.equal(updates.length,0);
  assert.equal(read({...status,...second},3000).title,second.title);
  read.invalidate();
  read(status,4000);
  read({running:false},5000);
  jobs.shift()(first);await settle(0);
  assert.equal(updates.length,0);
});

test('빈 커버 조회는 짧게만 캐시하고 연결 복구 뒤 같은 곡의 커버를 다시 받습니다',async t=>{
  let now=1000,calls=0;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'fetch',async url=>{
    calls++;
    if(calls===1) throw Error('일시적 연결 실패');
    if(String(url).includes('keyword')) return {
      ok:true,json:async()=>({STATUS:'0',SONGCONTENTS:[{
        SONGID:'123',SONGNAME:'커버 복구 테스트',ARTISTNAME:'가수',ALBUMNAME:'앨범',
        ALBUMIMG:'https://cdnimg.melon.co.kr/test.jpg'
      }]})
    };
    return {ok:true,headers:new Headers({'content-type':'image/png'}),arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};
  });
  const track={title:'커버 복구 테스트',artist:'가수'};
  assert.equal(await coverFor(track),'');
  now=5999;
  assert.equal(await coverFor(track),'');
  assert.equal(calls,1);
  now=6000;
  assert.match(await coverFor(track),/^data:image\/png;base64,/);
  assert.equal(calls,3);
  now=7000;
  assert.match(await coverFor(track),/^data:image\/png;base64,/);
  assert.equal(calls,3);
});

test('한 곡 반복은 숫자 1을 표시하고 셔플 탐색은 목록 순서라고 표시합니다',()=>{
  const single=dialStrip('multimedia',{...status,repeat:'한곡 반복'}).feedback;
  const all=dialStrip('multimedia',{...status,repeat:'전체 반복'}).feedback;
  const decode=value=>Buffer.from(value.split(',')[1],'base64').toString();
  assert.match(decode(single.modes),/>1<\/text>/);
  assert.doesNotMatch(decode(all.modes),/>1<\/text>/);
  const queue=dialStrip('queue',{...status,shuffle:true},{item:{title:'고른 곡',artist:'가수'}}).feedback;
  assert.match(queue.header,/목록/);
  assert.equal(queue.song,'▸ 고른 곡');
});

test('대기열에 들어간 곡 정보 조회는 실행 직전에 유효한지 검사할 수 있습니다',async()=>{
  const queued=[],updates=[];
  let lookups=0;
  const read=trackReader(isCurrent=>new Promise(resolve=>{
    queued.push(()=>{
      if (!isCurrent()) {resolve(undefined);return;}
      lookups++;
      resolve(first);
    });
  }),value=>updates.push(value));
  read(status,1000);
  read.invalidate();
  read(status,2000);
  queued.shift()();await settle(0);
  assert.equal(lookups,0);
  assert.equal(updates.length,0);
  queued.shift()();await settle(0);
  assert.equal(lookups,1);
  assert.equal(updates[0].title,first.title);
});
