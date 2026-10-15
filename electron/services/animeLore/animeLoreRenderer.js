'use strict';
const fs=require('fs/promises'),path=require('path'),{spawn}=require('child_process');
const {blocked}=require('./animeLoreConfig');
function stamp(t){const ms=Math.max(0,Math.round(t*1000)),cs=Math.floor(ms/10)%100;return [Math.floor(ms/3600000),Math.floor(ms/60000)%60,Math.floor(ms/1000)%60].map(String).join(':')+'.'+String(cs).padStart(2,'0');}
function escapeAss(x){return String(x).replace(/\\/g,'').replace(/[{}]/g,'').replace(/\r?\n/g,' ');}
async function command(binary,args,opts={}) {
 return new Promise((resolve,reject)=>{
  const p=spawn(binary,args,{windowsHide:true});let stderr='';
  p.stderr.on('data',x=>{stderr=(stderr+String(x)).slice(-5000);});
  let done=false;const finish=(error)=>{if(done)return;done=true;opts.signal?.removeEventListener?.('abort',abort);
    if(error)reject(error);else resolve();};
  const abort=()=>{p.kill('SIGKILL');finish(new Error('Anime Lore render cancelled'));};
  if(opts.signal?.aborted){abort();return;}
  opts.signal?.addEventListener?.('abort',abort,{once:true});
  p.on('error',finish);
  p.on('close',code=>finish(code===0?null:new Error('FFmpeg failed ['+code+']: '+stderr)));
 });
}
function makeAss(voice) {
 const events=[];
 for(const segment of voice.segments){
  const words=segment.wordAlignment||[];
  for(let i=0;i<words.length;i+=3){
   const chunk=words.slice(i,i+3);
   if(!chunk.length)continue;
   const start=segment.offsetSec+chunk[0].startSec,end=segment.offsetSec+chunk.at(-1).endSec;
   events.push('Dialogue: 0,'+stamp(start)+','+stamp(Math.max(start+0.15,end))+',Default,,0,0,0,,'+escapeAss(chunk.map(w=>w.word).join(' ')));
  }
 }
 return '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\n'+
 '[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n'+
 'Style: Default,Arial,74,&H00FFFFFF,&H00FFFFFF,&H00000000,&H88000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,410,1\n'+
 '[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n'+events.join('\n')+'\n';
}
const concatLine=x=>"file '"+x.replace(/\\/g,'/').replace(/'/g,"'\\''")+"'";
function assFilter(file){let value=path.resolve(file).replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");return 'ass='+value;}
async function render(config,timeline,voice,root,settings={},options={}) {
 const ffmpeg=settings.ffmpegPath||'ffmpeg',ffprobe=settings.ffprobePath||'ffprobe';
 const work=path.join(root,'render-work');await fs.mkdir(work,{recursive:true});
 const clips=[];const count=timeline.shots.length;
 for(let i=0;i<count;i++){
  const shot=timeline.shots[i];
  const file=path.join(work,'clip-'+String(i+1).padStart(4,'0')+'.mp4');
  const seconds=Math.max(0.3,shot.outputEndSec-shot.outputStartSec);
  const filter='scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p';
  const args=['-y','-hide_banner','-loglevel','error'];
  if(shot.mediaType==='image')args.push('-loop','1','-framerate','30','-t',String(seconds),'-i',shot.path);
  else args.push('-ss',String(shot.sourceStartSec),'-t',String(Math.max(0.3,shot.sourceEndSec-shot.sourceStartSec)),'-i',shot.path);
  args.push('-an','-vf',filter+(shot.mediaType==='video'?',tpad=stop_mode=clone:stop_duration='+Math.max(0,seconds-(shot.sourceEndSec-shot.sourceStartSec)).toFixed(3):''),
    '-t',String(seconds),'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-r','30',file);
  await command(ffmpeg,args,options);clips.push(file);
  options.onProgress?.({stage:'render_segments',percent:70+Math.round(15*(i+1)/count),message:'Anime scene '+(i+1)+'/'+count});
 }
 const concat=path.join(work,'video-list.txt');
 await fs.writeFile(concat,clips.map(concatLine).join('\n'));
 const visual=path.join(work,'visual.mp4');
 await command(ffmpeg,['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',concat,'-c','copy',visual],options);
 const voiceList=path.join(work,'voice-list.txt');
 await fs.writeFile(voiceList,voice.segments.map(x=>concatLine(x.audioPath)).join('\n'));
 const speech=path.join(work,'speech.wav');
 await command(ffmpeg,['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',voiceList,'-ac','2','-ar','44100','-c:a','pcm_s16le',speech],options);
 const ass=path.join(work,'captions.ass');await fs.writeFile(ass,makeAss(voice),'utf8');
 const output=path.join(root,'anime-draft-v1.mp4');
 const inputs=['-i',visual,'-i',speech],map=['-map','0:v:0','-map','1:a:0'];
 const args=['-y','-hide_banner','-loglevel','error',...inputs,...map,'-vf',assFilter(ass),
  '-c:v','libx264','-preset','medium','-crf','20','-r','30','-pix_fmt','yuv420p',
  '-c:a','aac','-b:a','192k','-movflags','+faststart','-shortest',output];
 await command(ffmpeg,args,options);
 const info=await new Promise((resolve,reject)=>{
  const p=spawn(ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',output],{windowsHide:true});
  let data='';p.stdout.on('data',c=>data+=c);p.on('error',reject);p.on('close',c=>{try{if(c)throw Error('ffprobe failed');resolve(JSON.parse(data));}catch(e){reject(e);}});
 });
 const streams=info.streams||[],v=streams.find(x=>x.codec_type==='video'),a=streams.find(x=>x.codec_type==='audio');
 if(!v||!a||v.width!==1080||v.height!==1920||Math.abs(Number(info.format?.duration)-voice.durationSec)>1.5)
  throw blocked('failed','Draft failed 9:16 / A-V / duration validation.',{info});
 return {schemaVersion:1,path:output,durationSec:Number(info.format?.duration),width:v.width,height:v.height,
  captionFile:ass,technicalPass:true};
}
module.exports={command,makeAss,render,stamp};