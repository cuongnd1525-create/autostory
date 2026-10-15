'use strict';
const creativeSchema = {type:'object',required:['topicCandidates','hooks','beats','title'],properties:{
 title:{type:'string'},
 topicCandidates:{type:'array',items:{type:'object',required:['title','reason','claimIds'],properties:{title:{type:'string'},reason:{type:'string'},claimIds:{type:'array',items:{type:'string'}}}}},
 hooks:{type:'array',minItems:3,items:{type:'object',required:['id','text','payoffClaimIds','visualIntent'],properties:{
 id:{type:'string'},text:{type:'string'},payoffClaimIds:{type:'array',items:{type:'string'}},visualIntent:{type:'array',items:{type:'string'}},score:{type:'number'}}}},
 beats:{type:'array',minItems:4,items:{type:'object',required:['role','text','claimIds','visualIntent'],properties:{
 role:{type:'string'},text:{type:'string'},claimIds:{type:'array',items:{type:'string'}},visualIntent:{type:'array',items:{type:'string'}}}}}
}};
const reviewSchema = {type:'object',required:['accessAudit','pass','issues','summary'],properties:{
 accessAudit:{type:'object',required:['watchedVideo','checkedAgainstClaims'],properties:{watchedVideo:{type:'boolean'},checkedAgainstClaims:{type:'boolean'}}},
 pass:{type:'boolean'},summary:{type:'string'},issues:{type:'array',items:{type:'object',required:['timeSec','severity','category','reason'],properties:{
 timeSec:{type:'number'},severity:{type:'string'},category:{type:'string'},reason:{type:'string'},suggestedFix:{type:'string'}}}}
}};
module.exports={creativeSchema,reviewSchema};