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

// The autocomplete endpoint only returns the first few tracks; the full listing also identifies the album.
export function recordingsFromListing(html,track) {
  const label = html => normalize(text(html.replace(/<[^>]*>/g,'')).replaceAll('&nbsp;',' '));
  const matches=[];
  for (const row of html.split(/<tr\b/i)) {
    const song = [...row.matchAll(/<a\b[^>]*melon\.play\.playSong\(\s*'[^']*'\s*,\s*'?(\d+)'?\s*\)[^>]*>([\s\S]*?)<\/a>/gi)]
      .find(match=>label(match[2])===normalize(track.title));
    const album = row.match(/<a\b[^>]*melon\.link\.goAlbumDetail\('(\d+)'\)[^>]*>([\s\S]*?)<\/a>/i);
    if (!song || !album) continue;
    const artists=[...row.matchAll(/<a\b[^>]*melon\.link\.goArtistDetail\([^>]*>([\s\S]*?)<\/a>/gi)].map(match=>label(match[1]));
    if ([...new Set(artists)].join(', ')===normalize(track.artist)) matches.push({id:song[1],album:label(album[2]),albumId:album[1]});
  }
  return matches;
}
export function albumFromListing(html,track) {
  return recordingsFromListing(html,track).find(row=>row.album===normalize(track.album))?.albumId || '';
}

const listings=new Map();
export function queueRecordings(track) {
  const key=JSON.stringify([track.title,track.artist]);
  const cached=listings.get(key);
  if (cached && cached.expires>Date.now()) return cached.job;
  const url=new URL('https://www.melon.com/search/song/index.htm');
  url.searchParams.set('q',track.title+' '+track.artist);
  const job=melonFetch(url).then(r=>r.text()).then(html=>recordingsFromListing(html,track));
  if (listings.size>=48) listings.delete(listings.keys().next().value);
  listings.set(key,{job,expires:Date.now()+600000});
  job.catch(()=>{if(listings.get(key)?.job===job) listings.delete(key);});
  return job;
}
export function queueSongID(rows,album) {
  const ids=new Set(rows.filter(row=>album && row.album===normalize(album)).map(row=>row.id));
  if(ids.size!==1) throw Error('곡명·가수·앨범이 일치하는 곡 번호를 확인할 수 없습니다');
  return [...ids][0];
}

async function albumCover(track) {
  if (!track.album) return '';
  const url=new URL('https://www.melon.com/search/song/index.htm');
  url.searchParams.set('q',track.title+' '+track.artist);
  const id=albumFromListing(await (await melonFetch(url)).text(),track);
  if (!id) return '';
  const html=await (await melonFetch('https://www.melon.com/album/detail.htm?albumId='+id)).text();
  return html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)?.[1]||'';
}

const artwork = new Map();
export function coverFor(track) {
  const key = JSON.stringify([track.title,track.artist,track.album]);
  const cached = artwork.get(key);
  if (cached && cached.expires > Date.now()) return cached.job;
  const job = (async () => {
    // The official search response can include similarly named recordings. Match both fields.
    const rows=await search(track.title).catch(()=>[]);
    const matches=rows.filter(row=>normalize(row.title)===normalize(track.title) &&
      normalize(row.artist)===normalize(track.artist) && (!track.album || normalize(row.album)===normalize(track.album)));
    const covers=new Set(matches.map(row=>row.cover).filter(Boolean));
    const source=covers.size===1?[...covers][0]:await albumCover(track);
    if (!source) return '';
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.hostname !== 'cdnimg.melon.co.kr') return '';
    const resized=url.href.includes('/melon/resize/') ? url.href.replace(/\/resize\/\d+$/, '/resize/120') : url.href+'/melon/resize/120';
    const response = await melonFetch(resized);
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
