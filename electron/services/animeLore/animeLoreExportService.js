'use strict';
const fs=require('fs/promises'),path=require('path');
const {atomicJson,blocked}=require('./animeLoreConfig');
async function exportPack(root,config,canon,script,timeline,draft,review) {
 if(!review.pass)throw blocked('needs_human_review','Review must pass before final export.');
 const output=path.join(root,'anime-final.mp4');
 await fs.copyFile(draft.path,output);
 const description=script.title+'\n\n'+
  'What do you think about '+config.character+'? Explain your interpretation in the comments.\n'+
  '#anime #animelore #animeanalysis\n';
 await fs.writeFile(path.join(root,'caption.txt'),description);
 const manifest={schemaVersion:1,mode:'anime_lore',series:config.series,topic:config.topic,
  canvas:timeline.canvas,durationSec:draft.durationSec,sourceRegistry:canon.sources,shots:timeline.shots.map(s=>({
    assetId:s.assetId,path:s.path,licenseStatus:'user_confirmed',outputStartSec:s.outputStartSec,
    outputEndSec:s.outputEndSec,claimIds:s.claimIds})),rightsAttestedByUser:config.mediaRightsConfirmed,
  independentCanonVerified:false,requiresHumanFactReview:true,reviewPass:review.pass,
  generatedAt:new Date().toISOString()};
 await atomicJson(path.join(root,'manifest.json'),manifest);
 return {outputPath:output,captionPath:path.join(root,'caption.txt'),manifestPath:path.join(root,'manifest.json'),
   status:'needs_human_review',reason:'Sources are user-attested, not independently verified'};
}
module.exports={exportPack};