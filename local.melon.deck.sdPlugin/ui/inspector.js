let ws, uuid, action, settings={},kind,encoder;
const fields={
 source:['컬렉션',[['auto','등록 목록 우선'],['favorites','다이얼 보관함'],['entries','등록한 목록']],'auto'],
 destination:['저장 위치',[['playlist','멜론 플레이리스트'],['favorites','다이얼 보관함 (저장 / 해제)']],'playlist'],
 rotate:['회전', [['volume','볼륨 조절'],['tracks','이전 / 다음 곡']],'volume'],
 step:['볼륨 간격 (%)','number',5,1,10],
 double:['두 번 누르기',[['next','다음 곡'],['previous','이전 곡'],['toggle','재생 / 일시정지']],'next'],
 triple:['세 번 누르기',[['previous','이전 곡'],['next','다음 곡'],['toggle','재생 / 일시정지']],'previous'],
 showArtwork:['앨범 커버','checkbox',true],
 command:['재생 동작',[['toggle','재생 / 일시정지'],['previous','이전 곡'],['next','다음 곡'],['play','재생'],['pause','일시정지']],'toggle'],
 direction:['버튼 방향',[['1','볼륨 높이기'],['-1','볼륨 낮추기']],'1'],
 query:['검색어','text',''],list:['목록 이름','text',''],entries:['저장할 항목','textarea',''],
 minutes:['타이머 (분)','number',30,1,240]
};
const options={multimedia:['rotate','step','double','triple','showArtwork','source','entries'],now:['showArtwork'],playback:['command'],volume:['step','direction'],search:['query'],add:['destination','list'],collection:['source','entries'],sleep:['minutes']};
const tips={
 multimedia:'누르면 재생하거나 멈춥니다. 누른 채 돌리면 반대 동작을 합니다. 길게 눌러 등록한 컬렉션을 열거나 닫습니다.',
 queue:'처음 돌리면 멜론의 곡 목록을 엽니다. 돌려서 고른 뒤 누르거나 터치하면 그 곡부터 재생합니다.',
 now:'앨범 커버를 켜면 곡명을 멜론에서 검색하고 제목과 가수가 일치하는 이미지를 표시합니다.',
 search:'버튼은 첫 곡을 재생합니다. 다이얼에서는 검색 결과를 돌려 고를 수 있습니다.',
 collection:'버튼은 첫 항목을 재생합니다. 다이얼에서는 등록 순서대로 돌려 고를 수 있습니다.',
 add:'멜론 목록을 선택하면 이름이 일치하는 플레이리스트에 담습니다. 다이얼 보관함은 현재 곡을 멜론에서 찾아 이 Mac에 저장하고 다시 누르면 해제합니다.',
 sleep:'한 번 눌러 시작하고 다시 눌러 취소합니다. 타이머는 이 플러그인 전체에서 하나이며 Stream Deck 앱이 실행 중이어야 합니다.',
 like:'멜론 기본모드의 현재 재생목록에서 재생 중인 곡에 적용합니다.'
};
function send(event,payload){ws.send(JSON.stringify({event,context:uuid,action,payload}));}
function render(){
 const root=document.getElementById('fields');root.replaceChildren();
 for(const key of options[kind]||[]){
  if(encoder && key==='direction')continue;
  if(key==='list'&&settings.destination==='favorites')continue;
  if(key==='entries'&&settings.source==='favorites')continue;
  const [name,type,def,min,max]=fields[key];
  const label=document.createElement('label');label.textContent=name;const el=document.createElement(Array.isArray(type)?'select':type==='textarea'?'textarea':'input');
  if(Array.isArray(type)){for(const [val,text] of type) el.add(new Option(text,val));}
  else if(type!=='textarea') el.type=type;
  if(type==='number'){el.min=min;el.max=max;}
  if(type==='checkbox')el.checked=settings[key]??def;else el.value=settings[key]??def;
  if(key==='entries')el.placeholder='밤편지 | song:30314784\n내 앨범 | album:10047890';
  el.addEventListener('change',()=>{
   const value=type==='checkbox'?el.checked:type==='number'?Math.round(Math.max(min,Math.min(max,Number(el.value)||def))):el.value;
   settings={...settings,[key]:value};if(type==='number')el.value=value;send('setSettings',settings);
  });
  label.append(el);root.append(label);
 }
 const help=[tips[kind]||''];
 if(['collection','multimedia'].includes(kind))help.push('등록 목록 우선은 입력된 항목이 없으면 다이얼 보관함을 엽니다. 등록 목록은 한 줄에 이름 | 멜론 상세 주소 또는 song:번호, album:번호, playlist:번호를 입력해 주세요.');
 if(kind==='multimedia')help.push('커버를 켜면 현재 곡명으로 멜론의 공개 검색을 조회합니다.');
 document.getElementById('help').textContent=help.join(' ');
}
function connectElgatoStreamDeckSocket(port,id,event,info,raw){
 const data=JSON.parse(raw);uuid=id;action=data.action;kind=action.split('.').pop();settings=data.payload.settings||{};encoder=data.payload.controller==='Encoder';render();
 ws=new WebSocket('ws://127.0.0.1:'+port);
 ws.onopen=()=>{ws.send(JSON.stringify({event,uuid}));send('getSettings',{});};
 ws.onmessage=({data})=>{const msg=JSON.parse(data);if(msg.event==='didReceiveSettings'){settings=msg.payload.settings||{};render();}
 if(msg.event==='sendToPropertyInspector')document.getElementById('result').textContent=msg.payload.message;};
}
document.getElementById('check').onclick=()=>{if(ws?.readyState===1){document.getElementById('result').textContent='확인 중…';send('sendToPlugin',{check:true});}};
