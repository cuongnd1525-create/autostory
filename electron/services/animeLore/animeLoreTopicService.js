'use strict';
const {blocked} = require('./animeLoreConfig');
function validateTopics(topics, claims) {
  const ids = new Set(claims.map(f=>f.id));
  return (topics||[]).filter(t=>t.title && Array.isArray(t.claimIds) && t.claimIds.length && t.claimIds.every(x=>ids.has(x)))
    .slice(0,12).map((t,i)=>({...t,id:'topic_'+(i+1),evidenceStrength:t.claimIds.length}));
}
function lockAngle(config, topics) {
  const locked = topics.find(x=>x.title.toLowerCase().includes(config.topic.toLowerCase()) || config.topic.toLowerCase().includes(x.title.toLowerCase()));
  if (!locked) throw blocked('needs_fact_review','No grounded Anime topic candidates.');
  return {schemaVersion:1,topic:config.topic,angle:locked.title,claimIds:locked.claimIds,
    spoilerScope:{medium:config.medium,through:config.spoilerThrough},payoffRequired:true};
}
module.exports={validateTopics,lockAngle};