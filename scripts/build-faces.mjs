import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {keySVG} from '../local.melon.deck.sdPlugin/bin/faces.mjs';

const plugin=new URL('../local.melon.deck.sdPlugin/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('manifest.json',plugin),'utf8'));
await mkdir(new URL('imgs/faces/',plugin),{recursive:true});
for (const action of manifest.Actions) {
  const kind=action.UUID.split('.').pop();
  const symbol=kind==='playback'?'play':kind;
  const files=[[action.States[0].Image,{lines:kind==='now'?2:1}]];
  if (action.Encoder) files.push([action.Encoder.Icon,{dial:true}]);
  for (const [path,layout] of files) await writeFile(new URL(path+'.svg',plugin),keySVG(symbol,layout)+'\n');
}
