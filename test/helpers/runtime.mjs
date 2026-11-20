import {fork} from 'node:child_process';
import {mkdtemp,cp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import assert from 'node:assert/strict';

export async function runtime(t, configuration={}) {
  const root=await mkdtemp(join(tmpdir(),'melon-regression-'));
  const bin=join(root,'bin');
  await cp(fileURLToPath(new URL('../../local.melon.deck.sdPlugin/bin/',import.meta.url)),bin,{recursive:true});
  await cp(fileURLToPath(new URL('../../local.melon.deck.sdPlugin/imgs/',import.meta.url)),join(root,'imgs'),{recursive:true});
  const configPath=join(root,'configuration.json'), log=join(root,'operations');
  let config={status:{running:true,pid:1,playing:true,title:'현재 곡',artist:'가수',elapsed:10,duration:180,volume:70},...configuration};
  await writeFile(configPath,JSON.stringify(config));
  await writeFile(join(bin,'MelonBridge'),`#!/usr/bin/env node
const fs=require('node:fs');
const request=JSON.parse(fs.readFileSync(0,'utf8'));
const config=JSON.parse(fs.readFileSync(process.env.MELON_CONFIGURATION,'utf8'));
const log=entry=>fs.appendFileSync(process.env.MELON_OPERATIONS,JSON.stringify(entry)+'\\n');
log(request);
const songs=Array.from({length:10},(_,index)=>({index,title:'곡 '+index,artist:'가수'}));
let response=request.op==='status'?config.status:request.op==='trackInfo'?config.track||{title:'현재 곡',artist:'가수'}:request.op==='queuePreview'?{...songs[1],currentIndex:0,count:10,nearby:songs}:request.op==='queue'?{...songs[request.index??1],count:10,nearby:songs}:{};
const reply=data=>{process.stdout.write(JSON.stringify(data));process.exit(0);};
if(request.op==='queuePlay') process.on('SIGTERM',()=>{
 log({op:'cancelled',index:request.index});
 setTimeout(()=>{log({op:'restored'});reply({ok:false,cancelled:true,error:'곡 이동을 취소했습니다'});},50);
});
setTimeout(()=>reply({ok:true,data:response}),config.delays?.[request.op]||0);
`,{mode:0o755});
  await writeFile(join(root,'transport.cjs'),`
const fs=require('node:fs'),cp=require('node:child_process');
const log=entry=>fs.appendFileSync(process.env.MELON_OPERATIONS,JSON.stringify(entry)+'\\n');
global.fetch=async url=>{
 const config=JSON.parse(fs.readFileSync(process.env.MELON_CONFIGURATION,'utf8'));
 const query=new URL(url).searchParams.get('query');
 log({op:'fetch',query});
 await new Promise(resolve=>setTimeout(resolve,config.searchDelay||0));
 return {ok:true,json:async()=>({STATUS:'0',SONGCONTENTS:[{SONGID:query==='새 검색'?'222':'111',SONGNAME:query==='새 검색'?'새 검색 결과':'현재 곡',ARTISTNAME:'가수'}]}),text:async()=>''};
};
const execute=cp.execFile;
cp.execFile=(file,args,options,callback)=>{
 if(file!=='/usr/bin/open') return execute(file,args,options,callback);
 log({op:'launch',args});callback(null,'','');
};
global.WebSocket=class {
 static OPEN=1;readyState=1;
 constructor(){this.handlers={};process.on('message',m=>this.handlers.message?.({data:JSON.stringify(m)}));setImmediate(()=>this.handlers.open());}
 addEventListener(event,handler){this.handlers[event]=handler;}
 send(raw){process.send(JSON.parse(raw));}
};
`);
  const messages=[],errors=[];
  const child=fork(join(bin,'plugin.js'),['-port','1','-pluginUUID','regression','-registerEvent','registerPlugin'],{
    env:{...process.env,MELON_CONFIGURATION:configPath,MELON_OPERATIONS:log},
    execArgv:['--require',join(root,'transport.cjs')],silent:true
  });
  child.on('message',message=>messages.push(message));
  child.stderr.on('data',part=>errors.push(String(part)));
  const stop=()=>new Promise(resolve=>{
    if (child.exitCode!==null || child.signalCode!==null) {resolve();return;}
    child.once('exit',resolve);child.kill();
  });
  t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});
  const operations=async()=>{try{return (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}};
  async function until(predicate,timeout=4000) {
    const end=Date.now()+timeout;
    while(Date.now()<end){if(await predicate())return;await wait(15);}
    assert.fail('기대한 결과가 도착하지 않았습니다. '+errors.join(''));
  }
  const send=(event,id,kind,payload={})=>child.send({event,context:id,action:'local.melon.deck.'+kind,payload});
  const appear=(id,kind,settings={},controller='Encoder')=>send('willAppear',id,kind,{controller,settings});
  await until(()=>messages.some(m=>m.event==='registerPlugin'));
  send('didReceiveGlobalSettings','regression','',{settings:config.settings||{}});
  return {messages,operations,until,send,appear,stop,async configure(changes){config={...config,...changes};await writeFile(configPath,JSON.stringify(config));}};
}
