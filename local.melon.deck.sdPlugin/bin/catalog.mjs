const endpoint = 'https://www.melon.com/search/keyword/index.json';
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
const text = value => String(value ?? '').replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>');

async function melonFetch(url) {
  const response = await fetch(url, {
    headers: {Accept: '*/*', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) StreamDeckMelon/1.0', Referer:'https://www.melon.com/'},
    redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw Error('멜론 검색 연결을 확인해 주세요');
  return response;
}

export async function search(query) {
  if (!query.trim()) throw Error('설정에서 검색어를 입력해 주세요');
  const url = new URL(endpoint);
  url.searchParams.set('query',query.trim().slice(0,160));
  const data = await (await melonFetch(url)).json();
  if (String(data.STATUS) !== '0') throw Error('멜론 검색을 이용할 수 없습니다');
  return (data.SONGCONTENTS || []).filter(row => /^\d+$/.test(row.SONGID)).map(row => ({
    id:String(row.SONGID), type:'song', title:text(row.SONGNAME), artist:text(row.ARTISTNAME),
    cover:row.ALBUMIMG, album:text(row.ALBUMNAME)
  }));
}

export async function exactSong(title,artist) {
  const match=rows=>rows.filter(row=>normalize(row.title)===normalize(title) && normalize(row.artist)===normalize(artist));
  let hits=match(await search(title));
  if (!hits.length) hits=match(await search(title+' '+artist));
  if (hits.length!==1) throw Error('같은 녹음을 특정할 수 없습니다. 곡 번호로 등록해 주세요');
  return hits[0];
}

const artwork = new Map();
export function coverFor(track) {
  const key = JSON.stringify([track.title,track.artist]);
  const cached = artwork.get(key);
  if (cached && cached.expires > Date.now()) return cached.job;
  const job = (async () => {
    // The official search response can include similarly named recordings. Match both fields.
    const matches = (await search(track.title)).filter(row => normalize(row.title) === normalize(track.title) && normalize(row.artist) === normalize(track.artist));
    if (!matches.length || new Set(matches.map(row=>row.cover)).size !== 1 || !matches[0].cover) return '';
    const url = new URL(matches[0].cover);
    if (url.protocol !== 'https:' || url.hostname !== 'cdnimg.melon.co.kr') return '';
    const response = await melonFetch(url.href.replace(/\/resize\/40$/, '/resize/120'));
    const mime = response.headers.get('content-type')?.split(';')[0];
    if (!['image/jpeg','image/png','image/webp'].includes(mime)) return '';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 256000) return '';
    return 'data:'+mime+';base64,'+bytes.toString('base64');
  })();
  if (artwork.size >= 80) artwork.delete(artwork.keys().next().value);
  artwork.set(key,{job,expires:Date.now()+600000});
  job.catch(()=>artwork.delete(key));
  return job;
}

export function parseEntry(raw) {
  const [first,...rest] = raw.split('|');
  const input = (rest.length ? rest.join('|') : first).trim();
  let id, type;
  const typed = /^(?:(song|album|playlist):)?(\d{1,14})$/.exec(input);
  if (typed) { type = typed[1] || 'song'; id = typed[2]; }
  else {
    let url;
    try { url = new URL(input); } catch { throw Error('곡·앨범·목록 주소 또는 번호를 확인해 주세요'); }
    if (!['www.melon.com','m2.melon.com','m.app.melon.com','melon.com'].includes(url.hostname)) throw Error('멜론 상세 주소나 번호를 입력해 주세요');
    for (const [param,kind] of [['songId','song'],['albumId','album'],['plylstSeq','playlist']]) {
      if (url.searchParams.has(param)) {id=url.searchParams.get(param);type=kind;break;}
    }
    if (!id) {
      const mobile = /^\/(song|album|playlist)(?:\/detail)?\/(\d+)\/?$/i.exec(url.pathname);
      if (mobile) [,type,id]=mobile;
    }
  }
  if (!/^\d{1,14}$/.test(id || '')) throw Error('멜론 상세 주소나 번호를 입력해 주세요');
  const label = {song:'곡',album:'앨범',playlist:'플레이리스트'}[type];
  return {id,type,title: rest.length ? first.trim() || label+' '+id : label+' '+id,artist:label};
}

export function collection(raw) {
  const lines=String(raw||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (!lines.length) throw Error('설정에서 곡·앨범·목록을 등록해 주세요');
  return lines.map(parseEntry);
}

export function playURL(item) {
  const flag={song:1,album:2,playlist:23}[item.type];
  if (!flag || !/^\d{1,14}$/.test(item.id)) throw Error('재생할 항목을 확인해 주세요');
  return 'melonplayer://play?menuid=1000000558&cid='+item.id+'&cflag='+flag+'&isHifiMenu=N';
}
