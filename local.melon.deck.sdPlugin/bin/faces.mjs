// Stream Deck composes the native, user-editable title over the key image.
const ink = '#E1EEE5';
const lime = '#ADFA70';
const surface = '#10201B';
const solid = (d, color) => '<path d="'+d+'" fill="'+color+'" stroke="none"/>';
const glyphs = {
  previous: solid('M17 5.1a.9.9 0 0 0-1.4-.7L6.8 11a1.2 1.2 0 0 0 0 2l8.8 6.6a.9.9 0 0 0 1.4-.7Z',ink)+'<path d="M5.1 5.4v13.2"/>',
  next: solid('M7 5.1a.9.9 0 0 1 1.4-.7l8.8 6.6a1.2 1.2 0 0 1 0 2l-8.8 6.6a.9.9 0 0 1-1.4-.7Z',ink)+'<path d="M18.9 5.4v13.2"/>',
  play: '<circle cx="12" cy="12" r="10" fill="'+lime+'" stroke="none"/>'+solid('M10 7.9q0-.9.8-.4l6 4q.8.5 0 1l-6 4q-.8.5-.8-.4Z',surface),
  pause: '<circle cx="12" cy="12" r="10" fill="'+lime+'" stroke="none"/><path d="M9.6 8.1v7.8m4.8-7.8v7.8" stroke="'+surface+'" stroke-width="2.3"/>',
  volume: '<path d="M3 9h3.8l4.7-4v14l-4.7-4H3zM15 8.3a5 5 0 0 1 0 7.4m2.8-10.2a8.5 8.5 0 0 1 0 13"/>',
  multimedia:'<path d="M4 10v4m4-8v12m4-15v18m4-14v10m4-7v4"/>',
  queue:'<path d="M3.5 5.7h17m-17 6h10m-10 6h8"/>'+solid('M16.1 12.9q0-.7.7-.3l4.7 3.1q.6.4 0 .8l-4.7 3.1q-.7.4-.7-.3Z',lime),
  collection:'<path d="M3 7V6q0-1.5 1.5-1.5h5l2.2 2.6h7.8q1.5 0 1.5 1.5v9.5q0 1.5-1.5 1.5h-15Q3 19.6 3 18.1V7z"/>'+solid('m10 10 5 3.3-5 3.3z',lime),
  shuffle:'<path d="M3.3 6.7h2.1c4.4 0 6.3 10.6 11.1 10.6h4m-3-3.1 3.2 3.1-3.2 3.1M3.3 17.3h2.1c1.8 0 3.3-1.9 4.6-4.1m3.4-5c1.1-1.1 2-1.5 3.2-1.5h3.9m-3-3.1 3.2 3.1-3.2 3.1"/>',
  repeat:'<path d="M3.8 10.8V10A4 4 0 0 1 7.8 6h11.8m-3.4-3.1L19.7 6l-3.5 3.2m4 4v.8a4 4 0 0 1-4 4H4.4m3.4 3.1L4.3 18l3.5-3.2"/>',
  like:'<path d="M12 20s-8.7-5.7-8.7-11.1A4.9 4.9 0 0 1 12 5.9a4.9 4.9 0 0 1 8.7 3c0 5.4-8.7 11.1-8.7 11.1Z"/>',
  add:'<path d="M3.5 5.5h16m-16 5.8h9.4m-9.4 5.8h6.4m7.8-4.3v8.4m-4.2-4.2h8.4"/>',
  sleep:'<path d="M19.9 14.5A8.3 8.3 0 0 1 9.5 4a8.3 8.3 0 1 0 10.4 10.5Z"/>',
  now:'<path d="M8.8 16.7V6.9l10-2.2v10.7M9 9.8l9.7-2.2"/><ellipse cx="6.3" cy="17.5" rx="2.5" ry="1.9"/><ellipse cx="16.3" cy="15.9" rx="2.5" ry="1.9"/>',
  search:'<circle cx="10.3" cy="10.3" r="6.4"/><path d="m15.2 15.2 5.1 5.1"/>'
};
const segmenter = new Intl.Segmenter('ko', {granularity:'grapheme'});

function advance(char) {
  if (/^\s$/u.test(char)) return 0.34;
  if (/^[ilI1.,'!:|]$/u.test(char)) return 0.38;
  if (/^[mwMW@%]$/u.test(char)) return 0.99;
  if (/^[A-Z]$/u.test(char)) return 0.76;
  if (/^[\x20-\x7e]$/u.test(char)) return 0.65;
  return 1.08;
}

// The host centers even an overlong single line, which clips its beginning.
// Budget in ems with side margins, and only remove entire grapheme clusters.
export function keyLine(value, fontSize=11) {
  const text=String(value??'').replace(/\s+/gu,' ').trim();
  const budget=60/Math.max(6,fontSize);
  let used=0, prefix='', abbreviated='';
  for (const {segment} of segmenter.segment(text)) {
    used+=advance(segment);
    if (used>budget) return abbreviated.trimEnd()+'…';
    prefix+=segment;
    if (used+1.08<=budget) abbreviated=prefix;
  }
  return text;
}

export function keySVG(symbol, {dial=false, lines=0, fontSize=11, alignment='bottom', active=false, cover=''}={}) {
  const neutral = glyphs[symbol] ?? glyphs.now;
  const band = lines ? Math.min(47, Math.ceil(lines*fontSize*1.28)+3) : 0;
  let top=5, bottom=67;
  if (!dial && band) {
    if (alignment==='top') top=band+3;
    else if (alignment==='middle') bottom=(72-band)/2-2;
    else bottom=72-band-3;
  }
  const size=Math.max(6,Math.min(dial?41:44,bottom-top));
  const x=(72-size)/2, y=(top+bottom-size)/2;
  const shape=cover && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(cover)
    ? '<image x="'+x+'" y="'+y+'" width="'+size+'" height="'+size+'" preserveAspectRatio="xMidYMid meet" xlink:href="'+cover+'"/>'
    : '<g transform="translate('+x+' '+y+') scale('+size/24+')" fill="none" stroke="'+(active||dial?lime:ink)+'" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">'+neutral+'</g>';
  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 72 72"><rect width="72" height="72" fill="'+surface+'"/>'+shape+'</svg>';
}

export function stripFeedback({title,value,hint,cover,level,showLevel}) {
  const feedback={title,value,hint,level:{enabled:showLevel,value:Math.round(level)}};
  if (cover) feedback.cover=cover;
  return feedback;
}
