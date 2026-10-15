'use strict';
const fs=require('fs/promises');
const path=require('path');
const {spawn}=require('child_process');
const {blocked}=require('./animeLoreConfig');
const VIDEO=new Set(['.mp4','.mov','.mkv','.webm']);
const IMAGE=new Set(['.png','.jpg','.jpeg','.webp']);
async function probe(file,ffprobe) {
  return new Promise((resolve,reject)=>{
    const p=spawn(ffprobe||'ffprobe',['-v','error','-show_entries','format=duration:stream=width,height','-of','json',file],{windowsHide:true});
    let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);
    p.on('error',reject);p.on('close',code=>{try{if(code!==0)throw Error(err);const x=JSON.parse(out);resolve({durationSec:Number(x.format?.duration)||0,width:x.streams?.[0]?.width,height:x.streams?.[0]?.height});}catch(e){reject(e);}});
  });
}
async function index(config,settings) {
  if(!config.mediaFolder) throw blocked('needs_assets','Please choose a folder of licensed Anime media.');
  if(!config.mediaRightsConfirmed) throw blocked('needs_assets','Confirm that you have permission to use every imported media asset.');
  const root=path.resolve(config.mediaFolder);
  const entries=await fs.readdir(root,{withFileTypes:true});
  const assets=[];
  for(const entry of entries) {
    if(!entry.isFile())continue;
    const ext=path.extname(entry.name).toLowerCase();
    if(!VIDEO.has(ext)&&!IMAGE.has(ext))continue;
    const full=path.join(root,entry.name);
    const sidecar=full+'.anime.json';
    let metadata={};try{metadata=JSON.parse(await fs.readFile(sidecar,'utf8'));}catch(_e){}
    if(metadata.licenseStatus==='restricted' || metadata.licenseStatus==='unknown')continue;
    const kind=VIDEO.has(ext)?'video':'image';
    const info=kind==='video'?await probe(full,settings.ffprobePath):{durationSec:0};
    const characters=(metadata.characters||[]).map(x=>String(x).toLowerCase());
    const tags=(metadata.tags||[]).map(x=>String(x).toLowerCase());
    assets.push({assetId:'asset_'+String(assets.length+1).padStart(4,'0'),path:full,
      mediaType:kind,durationSec:info.durationSec,characters,tags,
      spoilerLevel:metadata.spoilerLevel||config.medium,provenance:metadata.provenance||'user_import',
      licenseStatus:metadata.licenseStatus||'user_confirmed',description:String(metadata.description||''),
      startSec:Number(metadata.startSec)||0,endSec:Number(metadata.endSec)||info.durationSec});
  }
  if(!assets.length)throw blocked('needs_assets','No suitable image/video assets with acceptable rights metadata.');
  return {schemaVersion:1,root,assets,skipped:entries.length-assets.length};
}
module.exports={index,probe};