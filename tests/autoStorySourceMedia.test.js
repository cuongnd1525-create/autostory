const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs/promises'),os=require('os'),path=require('path');
const Ffmpeg=require('../electron/services/ffmpegService');
test('V2 proxy drops unused frames before resizing; legacy proxy filter order stays unchanged',async()=>{
  const ffmpeg=new Ffmpeg({}),calls=[];
  ffmpeg.run=async(_command,args)=>calls.push(args);
  for(const sourceClock of [true,false])await ffmpeg.createAnalysisProxyChunk({videoPath:'source.mp4',outputPath:'out.mp4',startSec:0,durationSec:3,width:640,fps:8,sourceClock});
  const filter=args=>args[args.indexOf('-vf')+1];
  assert(filter(calls[0]).startsWith('fps=8,scale=640:-2,'));
  assert.equal(filter(calls[1]),'scale=640:-2,fps=8');
});
test('real FFmpeg source-clock proxy retains source duration and audio',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-clock-'));
  const ffmpeg=new Ffmpeg({});
  try {
    const input=path.join(root,'source.mp4'),output=path.join(root,'clock.mp4');
    await ffmpeg.run(ffmpeg.ffmpegPath,['-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-preset','ultrafast','-c:a','aac',input]);
    await ffmpeg.createAnalysisProxyChunk({videoPath:input,outputPath:output,startSec:.5,durationSec:1,width:320,fps:8,sourceClock:true});
    const meta=await ffmpeg.probeVideo(output);assert(meta.hasAudio);assert(Math.abs(meta.duration-1)<.15);
    await ffmpeg.run(ffmpeg.ffmpegPath,['-v','error','-xerror','-i',output,'-f','null','-']);
    const frame=path.join(root,'clock.png');await ffmpeg.run(ffmpeg.ffmpegPath,['-y','-i',output,'-frames:v','1',frame]);
    assert((await fs.stat(frame)).size>1000);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
