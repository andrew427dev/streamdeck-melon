import {readFileSync} from 'node:fs';

const svgURI = svg => 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
const logo = svgURI(readFileSync(new URL('../imgs/melon-category.svg', import.meta.url),'utf8').replaceAll('#ddd','#04e632'));
const time = seconds => Number.isFinite(seconds) ? Math.floor(seconds/60)+':'+String(Math.floor(seconds)%60).padStart(2,'0') : '';

function controls(state) {
  const color = enabled => enabled ? '#04e632' : '#aaaaaa';
  const playback = state.playing
    ? '<path d="M43 8v12m6-12v12" stroke="#fff" stroke-width="3"/>'
    : '<path d="m42 7 11 7-11 7z" fill="#fff" stroke="none"/>';
  return svgURI('<svg xmlns="http://www.w3.org/2000/svg" width="92" height="28" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path stroke="'+color(state.shuffle)+'" d="M7 9h3c5 0 8 10 13 10h3m-3-3 3 3-3 3M7 19h3c2 0 3-1 5-4m4-5 3-1h4m-3-3 3 3-3 3"/>'+playback+'<path stroke="'+color(state.repeat && state.repeat!=='반복 없음')+'" d="M67 13v-2q0-3 4-3h13l-3-3m3 3-3 3m4 4v2q0 3-4 3H68l3 3m-3-3 3-3"/></svg>');
}

export function dialStrip(kind,state,{item,cover,notice,browsing}={}) {
  if (kind!=='multimedia' && kind!=='queue') return;
  if (state.running===false) return {layout:'launch',feedback:{logo,launch:'멜론 열기',status:'실행 중 아님'}};
  if (browsing) return;
  if (kind==='queue') {
    const song=item?.title;
    return {layout:'queue',feedback:{
      header:'☰  재생 대기열', song:song?'▸ '+song:state.error||'재생 대기열',
      artist:song?item.artist||'':item?.end?'다음 곡 없음':'돌려서 목록 열기',
      following:notice||(item?.nextTitle?'↳ '+item.nextTitle:'')
    }};
  }
  const hasTime=Number.isFinite(state.elapsed) && state.duration>0;
  return {layout:'transport',feedback:{
    cover:cover||logo, song:state.title||state.error||'멜론 플레이어',
    artist:notice||state.artist||state.view||(state.playing?'재생 중':'재생 대기'),
    modes:controls(state),elapsed:time(state.elapsed),duration:time(state.duration),
    progress:{enabled:hasTime,value:hasTime?Math.min(100,Math.round(state.elapsed*100/state.duration)):0}
  }};
}
