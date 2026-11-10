import {execFile,spawn} from 'node:child_process';
import {chmodSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {search, exactSong, coverFor, collection, playURL} from './catalog.mjs';

import {dialStrip} from './strips.mjs';
import {keyLine,keySVG,stripFeedback} from './faces.mjs';

const execute=promisify(execFile);
const bridge=fileURLToPath(new URL('./MelonBridge',import.meta.url));
// Stream Deck extracts secondary executables without their owner-execute bit.
const bridgeMode=statSync(bridge).mode;
if (!(bridgeMode & 0o100)) chmodSync(bridge,(bridgeMode & 0o777)|0o100);
function native(op, args={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(bridge,[],{stdio:['pipe','pipe','ignore']});
    const timeoutMs=op==='queuePlay' ? 12000+3000*count(args.count,1,10000,250) : 12000;
    const timeout=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
    let out='';
    child.stdout.setEncoding('utf8').on('data',part=>out+=part);
    child.stdin.on('error',()=>{});
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',()=>{
      clearTimeout(timeout);
      try {
        const reply=JSON.parse(out);
        if (!reply.ok) throw Error(reply.error);
        resolve(reply.data);
      } catch (e) {reject(Error(out ? e.message : '멜론 연결 시간이 초과되었습니다'));}
    });
    child.stdin.end(JSON.stringify({op,...args}));
  });
}
const arg = key=>process.argv[process.argv.indexOf(key)+1];
const socket=new WebSocket('ws://127.0.0.1:'+Number(arg('-port')));
const pluginID=arg('-pluginUUID');
const actions=new Map();
let state={}, globalSettings={}, ready=false, busy=Promise.resolve(), refreshing=false, deadlineBusy=false;
let liveQueue=null, queueKey='', lastQueueRead=0, pendingQueue=null;
let restoreQueueOnLaunch=false;
let artKey='', art='', artAttempt=0;
const labels={multimedia:'멀티미디어',queue:'재생 대기열',playback:'재생 제어',volume:'볼륨',shuffle:'셔플',repeat:'반복',like:'좋아요',add:'목록에 담기',collection:'컬렉션',search:'저장된 검색',sleep:'취침 타이머',now:'지금 재생 중'};
const count=(n,min,max,defaultValue)=>Number.isFinite(Number(n)) ? Math.min(max,Math.max(min,Math.round(Number(n)))) : defaultValue;
const move=(idx,ticks,total)=>Math.max(0,Math.min(total-1,idx+ticks));
const runningTime=()=>Math.max(0,Math.ceil((Number(globalSettings.deadline || 0)-Date.now())/1000));
const clock=n=>Math.floor(n/60)+':'+String(n%60).padStart(2,'0');
const openApp=(url)=>execute('/usr/bin/open',url?['-g','-b','com.iloen.macmelon',url]:['-b','com.iloen.macmelon'],{timeout:5000});
function send(event,context,payload,action) {
  if (socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify({event,context,payload,action}));
}
function textError(error) {
  return /fetch|network|timed out|JSON|Unexpected token/i.test(error.message) ? '멜론 연결을 확인해 주세요' : error.message;
}
function serialize(c,job) {
  busy=busy.then(async()=>{
    if (c && actions.get(c.id)!==c) return;
    try {await job();}
    catch(error) {
      if (c) {
        if (c.kind === 'queue') send('logMessage',pluginID,{message:'Melon queue: '+textError(error)});
        c.notice={text:textError(error),until:Date.now()+4500};
        send('showAlert',c.id,{});
        draw(c);
      }
    }
  });
}
function putSettings(changes) {
  globalSettings={...globalSettings,...changes};
  send('setGlobalSettings',pluginID,globalSettings);
}
function usesFavorites(c) {
  return c.settings.source==='favorites' || ((!c.settings.source || c.settings.source==='auto') && !String(c.settings.entries||'').trim());
}
function savedSongs() {return Array.isArray(globalSettings.favorites)?globalSettings.favorites:[];}
async function toggleFavorite() {
  if (!ready) throw Error('보관함을 불러오는 중입니다');
  const track=await native('status');
  if (!track.title || !track.artist) throw Error('현재 곡을 찾을 수 없습니다');
  const found=await exactSong(track.title,track.artist);
  const before=savedSongs();
  const exists=before.some(item=>item.id===found.id);
  if (!exists && before.length>=500) throw Error('보관함이 가득 찼습니다');
  const entry={title:found.title,artist:found.artist,type:'song',id:found.id};
  putSettings({favorites:exists?before.filter(item=>item.id!==found.id):[...before,entry]});
  for (const instance of actions.values()) if (usesFavorites(instance)) { instance.item=null;instance.entries=null; }
  drawAll();
  return exists?'보관함에서 삭제':'보관함에 저장';
}
function draw(c) {
  let title=labels[c.kind], value='', hint='', image='', level=0;
  const s=c.settings;
  const isBrowse=c.kind==='queue'||c.kind==='collection'||c.kind==='search'||c.browsing;
  if (isBrowse) {
    title=c.browsing ? '컬렉션' : title;
    if (c.item) {
      hint=(c.item.index+1)+' / '+c.item.count+(c.item.artist?'   '+c.item.artist:'');
      value=c.item.title;
      level=(c.item.index+1)*100/c.item.count;
    } else {
      value=c.kind==='search' ? s.query || '검색어 설정' : '돌려서 탐색';
      hint='';
    }
  } else if (c.kind==='sleep') {
    const left=runningTime();
    value=left?clock(left):count(s.minutes,1,240,30)+'분';
    hint=left?'누르면 취소':'누르면 시작';
  } else if (c.kind==='volume') {
    value=state.volume==null?'—':Math.round(state.volume)+'%';
    level=state.volume??0;
    hint='';
  } else if (c.kind==='shuffle') value=state.shuffle==null?'—':state.shuffle?'켬':'끔';
  else if (c.kind==='repeat') value=state.repeat || '반복 전환';
  else if (['now','multimedia','playback'].includes(c.kind)) {
    title=state.playing?'재생 중':state.playing===false?'일시정지':'멜론';
    value=state.title || title;
    hint=state.artist||'';
    if (!state.title) title='멜론 플레이어';
    level=state.volume??0;
    if (s.showArtwork!==false) image=art;
  } else if (c.kind==='add') value=s.destination==='favorites'?'다이얼 보관함':s.list||'목록 이름 설정';
  if (state.running===false && !isBrowse && c.kind!=='sleep') value='멜론 열기';
  if (state.error && !['collection','search'].includes(c.kind)) hint=state.error;
  if (c.notice && c.notice.until>Date.now()) {value=c.notice.text;hint='';image='';}
  let event, payload;
  if (c.encoder) {
    event='setFeedback';
    const strip=dialStrip(c.kind,state,{
      cover:image, item:c.item||liveQueue, browsing:c.browsing,
      notice:c.notice?.until>Date.now()?c.notice.text:''
    });
    const layout=strip?'layouts/'+strip.layout+'.json':image?'layouts/artwork.json':'layouts/player.json';
    if (layout!==c.layout) {
      send('setFeedbackLayout',c.id,{layout});
      c.layout=layout;
      c.drawn=null;
    }
    if (!c.dialImageSent) {
      const svg=keySVG(c.kind,{dial:true});
      send('setImage',c.id,{image:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')});
      c.dialImageSent=true;
    }
    const showLevel = (c.kind==='volume' && state.volume!=null) || (isBrowse && Boolean(c.item));
    payload=strip?.feedback??stripFeedback({title,value,hint,cover:image,level,showLevel});
  } else {
    event='setTitle';
    let symbol=c.kind;
    let active=false;
    let lines;
    switch (c.kind) {
      case 'playback': {
        const op=s.command||'toggle';
        symbol=op==='toggle'?(state.playing?'pause':'play'):op;
        lines=[{play:'재생',pause:'일시정지',next:'다음 곡',previous:'이전 곡'}[symbol]];
        break;
      }
      case 'shuffle':
        active=state.shuffle===true;
        lines=[state.shuffle==null?'셔플':'셔플 '+value];
        break;
      case 'repeat':
        active=Boolean(state.repeat && state.repeat!=='반복 없음');
        lines=[state.repeat==='반복 없음'?'반복 끔':state.repeat||'반복'];
        break;
      case 'sleep':
        active=runningTime()>0;
        lines=[active?value:'취침 '+value];
        break;
      case 'now': lines=[state.title||value,state.artist].filter(Boolean);break;
      case 'search': lines=[s.query||'저장된 검색'];break;
      case 'collection':
        try {lines=[usesFavorites(c)?(savedSongs()[0]?.title||'다이얼 보관함'):collection(s.entries)[0].title];}
        catch {lines=['컬렉션 설정'];}
        break;
      case 'add': lines=[s.destination==='favorites'?'보관함 담기':'목록에 담기'];break;
      case 'volume': lines=[Number(s.direction||1)>0?'볼륨 +':'볼륨 −'];break;
      default: lines=[title];
    }
    if (c.notice && c.notice.until>Date.now()) lines=[c.notice.text];
    const params=c.titleParams||{};
    const fontSize=Number(params.fontSize)||11;
    const formatted=lines.map(line=>keyLine(line,fontSize)).join('\n');
    payload={title:formatted,target:0};
    // A custom native title can have a different alignment or number of lines.
    const visibleLines=params.showTitle===false?0:Math.max(lines.length,c.customLines||0);
    const alignment=params.titleAlignment||'bottom';
    const cover=c.kind==='now'?image:'';
    const style=[symbol,visibleLines,fontSize,alignment,active].join('/');
    if (style!==c.faceStyle || cover!==c.cover) {
      const svg=keySVG(symbol,{lines:visibleLines,fontSize,alignment,active,cover});
      send('setImage',c.id,{image:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'),target:0});
      c.faceStyle=style;
      c.cover=cover;
    }
    c.defaultTitle=formatted;
  }
  const snapshot=JSON.stringify(payload);
  if (snapshot!==c.drawn) {send(event,c.id,payload);c.drawn=snapshot;}
}
function drawAll(){for (const c of actions.values()) draw(c);}
function updateArt() {
  const enabled=[...actions.values()].some(c=>['now','multimedia','playback'].includes(c.kind)&&c.settings.showArtwork!==false);
  const album=liveQueue?.album||'';
  const key=enabled && state.title && state.artist ? JSON.stringify([state.title,state.artist,album]) : '';
  if (key===artKey && (!key || Date.now()-artAttempt<600000)) return;
  artKey=key;art='';artAttempt=Date.now();
  if (key) coverFor({...state,album}).then(uri=>{if (key===artKey){art=uri;drawAll();}}).catch(()=>{});
}
function updateQueue() {
  const enabled=state.running && [...actions.values()].some(c=>c.encoder && (c.kind==='queue' || (c.kind==='multimedia' && c.settings.showArtwork!==false)));
  const key=enabled?JSON.stringify([state.title,state.artist]):'';
  if (key!==queueKey) {
    queueKey=key;liveQueue=null;lastQueueRead=0;
    for (const c of actions.values()) if (c.kind==='queue') c.item=null;
  }
  if (!key || pendingQueue || Date.now()-lastQueueRead<10000) return;
  lastQueueRead=Date.now();
  const includeNearby=[...actions.values()].some(c=>c.encoder && c.kind==='queue');
  const restoreOnLaunch=restoreQueueOnLaunch && Boolean(state.title) && includeNearby;
  if (restoreOnLaunch) restoreQueueOnLaunch=false;
  pendingQueue=native('queuePreview',{currentIndex:liveQueue?.currentIndex,restoreOnLaunch,includeNearby})
    .then(result=>{if (key===queueKey) liveQueue={...result,readAt:Date.now()};})
    .catch(()=>{if (key===queueKey) liveQueue=null;})
    .finally(()=>{pendingQueue=null;updateArt();drawAll();});
}
async function refresh() {
  if (refreshing || !actions.size) return;
  refreshing=true;
  try { state=await native('status'); }
  catch(e){state={error:textError(e)};}
  finally {refreshing=false;}
  if (state.running===false) {
    restoreQueueOnLaunch=[...actions.values()].some(c=>c.encoder && c.kind==='queue');
    for (const c of actions.values()) {
      if (c.encoder && (c.kind==='multimedia' || c.kind==='queue')) {
        c.browsing=false;c.item=null;c.notice=null;
      }
    }
  }
  updateQueue();updateArt();drawAll();
}
async function command(op,args) {
  if (state.running===false && op!=='pause') {
    await openApp();
    for (let i=0;i<15;i++) {
      await new Promise(resolve=>setTimeout(resolve,160));
      if ((await native('status')).running) break;
    }
  }
  const result=await native(op,args);
  await refresh();
  return result;
}
// Keep rotation and taps in input order. While a lookup is running, the next
// batch resolves just its final row, preserving reversals at either end.
function turnQueue(c,ticks) {
  if (!ticks || state.running===false) return;
  if (c.queueTurns) {c.queueTurns.push(ticks);return;}
  const turns=[ticks];
  c.queueTurns=turns;
  const key=queueKey;
  serialize(c,async()=>{
    if (c.queueTurns===turns) c.queueTurns=null;
    if (state.running===false || queueKey!==key) return;
    let base=c.item || liveQueue;
    if (!base?.title) base={...await native('queue',{includeNearby:true}),readAt:Date.now()};
    const index=turns.reduce((at,step)=>move(at,step,base.count),base.index);
    const page=[liveQueue,base].filter(p=>p?.count===base.count && Date.now()-p.readAt<10000)
      .sort((a,b)=>b.readAt-a.readAt).find(p=>p.nearby?.some(song=>song.index===index));
    let selected;
    if (page) {
      const song=page.nearby.find(row=>row.index===index);
      const next=page.nearby.find(row=>row.index===index+1);
      selected={...song,count:page.count,nextTitle:next?.title,nearby:page.nearby,readAt:page.readAt};
    } else {
      selected={...await native('queue',{index,includeNearby:true}),readAt:Date.now()};
    }
    if (queueKey!==key || actions.get(c.id)!==c) return;
    c.item=selected;
    c.notice=null;
    draw(c);
  });
}
async function browse(c,ticks,commit) {
  const queue=c.kind==='queue';
  if (queue) {
    if (!c.item && c.encoder && liveQueue?.title) c.item=liveQueue;
    if (commit && c.item) {
      const {index,title,artist}=c.item;
      await native('queuePlay',{index,title,artist,currentIndex:liveQueue?.currentIndex,count:c.item.count});
      c.item=null;lastQueueRead=0;
      await refresh();
      c.notice={text:'선택한 곡 재생',until:Date.now()+900};
    } else if (!c.item) {
      c.item=await command('queue');
    }
  } else {
    if (!c.entries || (c.kind==='search' && Date.now()-c.loaded>60000)) {
      const old=c.item;
      if (c.kind==='search') c.entries=await search(String(c.settings.query||''));
      else if (usesFavorites(c)) {
        c.entries=savedSongs();
        if (!c.entries.length) throw Error('‘보관함에 담기’ 버튼으로 곡을 저장해 주세요');
      } else c.entries=collection(c.settings.entries);
      if (old && commit && c.kind==='search') {
        const same=c.entries.findIndex(item=>item.id===old.id);
        if (same<0) {c.item=null;throw Error('검색 결과가 바뀌었습니다. 다시 선택해 주세요');}
        c.item={...old,index:same};
      }
      c.loaded=Date.now();
    }
    if (!c.entries.length) throw Error('검색 결과가 없습니다');
    const index=move(c.item?.index||0,ticks,c.entries.length);
    c.item={...c.entries[index],index,count:c.entries.length};
    if (commit) {
      await openApp(playURL(c.item));
      c.notice={text:'멜론에 재생 요청',until:Date.now()+1000};
    }
  }
  draw(c);
}
async function act(c,input,ticks=0,pressed=false) {
  const s=c.settings;
  if (c.encoder && (c.kind==='multimedia' || c.kind==='queue') && state.running===false) {
    if (input!=='rotate') {await openApp();await refresh();}
    return;
  }
  if (c.kind==='multimedia' && input==='hold') {
    c.browsing=!c.browsing;c.item=null;c.entries=null;
    if (c.browsing) await browse(c,0,false);
    draw(c);return;
  }
  if (c.kind==='queue'||c.kind==='collection'||c.kind==='search'||c.browsing) {
    if (input==='hold') {c.item=null;c.entries=null;await browse(c,0,false);return;}
    // A key invokes its saved entry immediately. A fresh queue dial previews the current track first.
    await browse(c,ticks,input!=='rotate');return;
  }
  if (c.kind==='sleep') {
    if (!ready) throw Error('타이머 설정을 불러오는 중입니다');
    if (runningTime()>0) putSettings({deadline:0});
    else putSettings({deadline:Date.now()+count(s.minutes,1,240,30)*60000});
    drawAll();return;
  }
  if (input==='rotate') {
    const step=count(s.volumeSteps,1,3,1);
    const volume=c.kind==='volume' || (((s.rotate||'volume')==='volume')!==pressed);
    if (volume) {
      await command('volume',{steps:ticks*step});
      if (state.volume!=null) c.notice={text:'볼륨 '+Math.round(state.volume)+'%',until:Date.now()+950};
    } else {
      for (let i=0;i<Math.min(Math.abs(ticks),12);i++) await native(ticks>0?'next':'previous');
      await refresh();
    }
  } else if (c.kind==='multimedia' || c.kind==='now') {
    const op=input==='double'?(s.double||'next'):input==='triple'?(s.triple||'previous'):'toggle';
    await command(op);
  } else if (c.kind==='playback') await command(s.command||'toggle');
  else if (c.kind==='volume') {
    if (c.encoder) await command('toggle');
    else await command('volume',{steps:count(s.volumeSteps,1,3,1)*(Number(s.direction||1)<0?-1:1)});
  } else if (c.kind==='add') await command('add',{list:String(s.list||'')});
  else if (['repeat','shuffle','like'].includes(c.kind)) await command(c.kind);
  draw(c);
}
function flushRotation(c) {
  clearTimeout(c.turnTimer);
  if (!c.turn) return;
  const {ticks,pressed}=c.turn;c.turn=null;
  if (ticks) serialize(c,()=>act(c,'rotate',ticks,pressed));
}
function flushClicks(c) {
  clearTimeout(c.clickTimer);
  if (!c.clicks) return;
  const input=['','push','double','triple'][Math.min(c.clicks,3)];
  c.clicks=0;serialize(c,()=>act(c,input));
}
socket.addEventListener('open',()=>{
  socket.send(JSON.stringify({event:arg('-registerEvent'),uuid:pluginID}));
  send('getGlobalSettings',pluginID,{});
  // Record capability only, never the user's track, queue, settings or account.
  void native('status').then(s=>send('logMessage',pluginID,{message:'Melon Deck ready: '+(!s.running?'player closed':s.volume!=null?'player controls available':'player menu available')}))
    .catch(e=>send('logMessage',pluginID,{message:'Melon Deck ready: '+textError(e)}));
});
socket.addEventListener('message',({data})=>{
  let msg;
  try {msg=JSON.parse(data);} catch{return;}
  const {event,context,action,payload={}}=msg;
  let c=actions.get(context);
  if (event==='didReceiveGlobalSettings') {globalSettings=payload.settings||{};ready=true;drawAll();return;}
  if (event==='willDisappear' || event==='willAppear') {
    if (c){clearTimeout(c.clickTimer);clearTimeout(c.turnTimer);actions.delete(context);}
    if (event==='willDisappear') return;
    c={id:context,kind:action.split('.').pop(),settings:payload.settings||{},encoder:payload.controller==='Encoder',clicks:0};
    actions.set(context,c);draw(c);void refresh();return;
  }
  if (event==='sendToPlugin' && payload.check) {
    void native('status').then(s=>{
      const message=s.running ? s.view || (s.volume==null?'멜론 메뉴에 연결했습니다':'멜론 연결됨 · 볼륨 '+Math.round(s.volume)+'%') : '멜론을 열어 주세요';
      send('sendToPropertyInspector',context,{message},action);
    }).catch(e=>send('sendToPropertyInspector',context,{message:textError(e)+' · 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 Stream Deck을 확인해 주세요.'},action));
    return;
  }
  if (!c) return;
  if (event==='titleParametersDidChange' && !c.encoder) {
    c.titleParams=payload.titleParameters;
    c.customLines=payload.title && payload.title!==c.defaultTitle ? payload.title.split(/\r?\n/).length : 0;
    draw(c);
    return;
  }
  if (event==='didReceiveSettings') {
    c.settings=payload.settings||{};c.item=null;c.entries=null;updateArt();draw(c);return;
  }
  if (event==='dialRotate') {
    const pressed=!!payload.pressed;
    if (pressed) c.turnedWhileDown=true;
    if (c.encoder && c.kind==='queue') {turnQueue(c,Number(payload.ticks)||0);return;}
    if (c.turn && c.turn.pressed!==pressed) flushRotation(c);
    c.turn={ticks:(c.turn?.ticks||0)+(Number(payload.ticks)||0),pressed};
    clearTimeout(c.turnTimer);c.turnTimer=setTimeout(()=>flushRotation(c),55);return;
  }
  if (event==='dialDown'){c.turnedWhileDown=false;c.downAt=Date.now();return;}
  if (event==='dialUp' || event==='touchTap' || event==='keyDown') {
    c.queueTurns=null; // Subsequent rotations belong after this input.
    flushRotation(c);
    if (event==='dialUp' && c.turnedWhileDown) {c.turnedWhileDown=false;return;}
    const hold=(event==='touchTap'&&payload.hold)||(event==='dialUp'&&c.downAt&&Date.now()-c.downAt>=650);
    if (event==='dialUp' && c.kind==='multimedia' && !hold && !c.browsing) {
      c.clicks++;clearTimeout(c.clickTimer);
      if (c.clicks>=3) flushClicks(c);else c.clickTimer=setTimeout(()=>flushClicks(c),320);
    } else serialize(c,()=>act(c,hold?'hold':'push'));
  }
});
setInterval(()=>{
  if (!ready || !globalSettings.deadline || deadlineBusy || globalSettings.deadline>Date.now()) return;
  deadlineBusy=true;
  serialize(null,async()=>{
    try {
      if (!globalSettings.deadline || globalSettings.deadline>Date.now()) return;
      const late=Date.now()-globalSettings.deadline;
      if (late<90000) await native('pause');
      putSettings({deadline:0});
    } catch(e) {
      if (Date.now()-globalSettings.deadline>=90000) putSettings({deadline:0});
      for(const c of actions.values()) if(c.kind==='sleep') c.notice={text:textError(e),until:Date.now()+4500};
    } finally {deadlineBusy=false;drawAll();}
  });
},1000);
setInterval(()=>{void refresh();},1600);
setInterval(drawAll,550);
socket.addEventListener('close',()=>process.exit(0));
socket.addEventListener('error',()=>process.exit(1));
