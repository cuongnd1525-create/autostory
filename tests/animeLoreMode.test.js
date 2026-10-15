'use strict';
const assert=require('assert/strict');
const fs=require('fs/promises'),os=require('os'),path=require('path');
const {normalize}=require('../electron/services/animeLore/animeLoreConfig');
const Canon=require('../electron/services/animeLore/animeLoreCanonService');
const Ledger=require('../electron/services/animeLore/animeLoreFactLedgerService');
const Topics=require('../electron/services/animeLore/animeLoreTopicService');
const Hooks=require('../electron/services/animeLore/animeLoreHookService');
const Visual=require('../electron/services/animeLore/animeLoreVisualMatcher');
const Timeline=require('../electron/services/animeLore/animeLoreTimelineService');
const Repair=require('../electron/services/animeLore/animeLoreReviewRepair');
const {makeAss}=require('../electron/services/animeLore/animeLoreRenderer');
const ProjectStore=require('../electron/services/projectStore');
const Engine=require('../electron/services/animeLore/animeLorePipelineService');
const reject=(f,status)=>{assert.throws(f,e=>e.animeStatus===status);};
async function main() {
 const config=normalize({series:'Mushoku Tensei',topic:'Power ceiling',character:'Rudeus',
  medium:'anime',spoilerThrough:'Season 2',mediaRightsConfirmed:true,mediaFolder:'X:/anime'});
 assert.equal(config.durationSec,75);assert.equal(config.version,1);
 assert.throws(()=>normalize({topic:'x'}),/series/);
 const canon=Canon.parseCanon('anime | S2 E03 | A mage cannot cast through sealed barriers.\n'+
  'light_novel | V20 | This is a late-novel spoiler.',config.medium,config.spoilerThrough);
 assert.equal(canon.facts.length,1);assert.equal(canon.disputed.length,1);
 reject(()=>Canon.requireGroundedCanon(canon),'needs_fact_review');
 const valid=Canon.requireGroundedCanon(Canon.parseCanon('anime | S2 E03 | A mage cannot cast through sealed barriers.',config.medium,'S2'));
 const ledger=Ledger.validateLedger(valid,valid.facts);
 assert.equal(ledger.requiresHumanFactReview,true);
 assert.equal(ledger.claims[0].independentlyVerified,false);
 reject(()=>Ledger.validateClaimIds([{text:'Uncited lore',claimIds:['invented']}],ledger),'needs_fact_review');
 Ledger.validateClaimIds([{text:'Grounded lore',claimIds:[valid.facts[0].id]}],ledger);
 const topics=Topics.validateTopics([{title:config.topic,reason:'Supported',claimIds:[valid.facts[0].id]},
 {title:'Fake',reason:'No citations',claimIds:['false']}],valid.facts);
 assert.equal(topics.length,1);assert.equal(Topics.lockAngle(config,topics).angle,config.topic);
 const hooks=Hooks.audition([
 {id:'1',text:'A secret changes how this magician fights.',payoffClaimIds:['claim_001'],visualIntent:['mage']},
 {id:'2',text:'What this magician cannot cast matters most.',payoffClaimIds:['claim_001'],visualIntent:['casting']},
 {id:'3',text:'There is a hidden constraint behind this power.',payoffClaimIds:['claim_001'],visualIntent:['barrier']}
 ],ledger);
 assert.equal(hooks.candidates.length,3);
 reject(()=>Hooks.audition([{text:'invented',payoffClaimIds:['fake'],visualIntent:['barrier']}],ledger),'needs_fact_review');
 const segment={id:'beat_01',text:'A mage uses magic at a barrier',durationSec:5,offsetSec:0,claimIds:['claim_001'],visualIntent:['mage','magic','barrier'],
  wordAlignment:[{word:'A',startSec:0,endSec:0.3},{word:'mage',startSec:0.3,endSec:1.2}]};
 const media={assets:[{assetId:'a',path:'/a.png',mediaType:'image',durationSec:0,characters:['rudeus'],
 tags:['mage','magic','barrier'],description:'magic barrier',licenseStatus:'user_confirmed',startSec:0,endSec:0},
 {assetId:'b',path:'/b.mp4',mediaType:'video',characters:['wrong person'],tags:['mage','magic','barrier'],
 licenseStatus:'user_confirmed',startSec:0,endSec:8}]};
 const voice={segments:[segment],durationSec:5};
 const m=Visual.match(config,voice,media);assert(m.edits.length>=2,'Split narration into multiple shots');
 assert(m.edits.every(x=>x.assetId==='a'),'Do not choose wrong character');
 const t=Timeline.create(config,voice,m,media);assert.equal(t.shots[0].outputStartSec,0);
 assert(Math.abs(t.shots.at(-1).outputEndSec-5)<0.1);
 assert(makeAss(voice).includes('Dialogue:'));
 reject(()=>Visual.match(config,voice,{assets:[]}), 'needs_assets');
 const patch=Repair.repairVisualEdits(t,{issues:[{timeSec:1,category:'visual',severity:'error'}]},media);
 assert.equal(patch.patched,false,'Do not claim repair with no valid alternatives');
 // Branch feature must permit topic-only project creation.
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'anime-lore-test-'));
 try {
  const store=new ProjectStore();
  const proj=await store.createProject(root,{title:'Anime Test',mode:'anime_lore',animeLoreConfig:{
   series:'Mushoku Tensei',topic:'Rudeus',canonText:'',medium:'anime',mediaRightsConfirmed:true}});
  assert.equal(proj.sourceVideoPath,'');
  assert.equal(proj.mode,'anime_lore');
  const engine=new Engine({},store);
  const result=await engine.run({workspaceRoot:root,projectId:proj.id});
  assert.equal(result.status,'needs_fact_review','Never hallucinate missing canon or call AI without evidence');
 }finally{await fs.rm(root,{recursive:true,force:true});}
 console.log('PASS: Anime Lore canon/claims/hooks/matching/timeline/project/blocker');
}
main().catch(err=>{console.error(err);process.exitCode=1;});