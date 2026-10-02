const {schemas}=require('./autoStorySourceContracts');
const gates=require('./autoStorySourceGates');
const {range}=require('./autoStoryTimelineCompiler');
const {StoryError}=require('./autoStoryRepairRouter');
const VERSION = 3;
const instruction=`Audition the strongest hook inside each candidate window.
score MUST be a number from 0 to 10, never a percentage or 0-100 score. audio.confidence MUST be 0 to 1.
The hook MUST be a concise opening beat between 3 and 20 seconds (No fixed 3-5 second limit, but keep it punchy). Never return the entire candidate window as the hook.

VIRAL HOOK ARCHETYPES (Pick the strongest that fits the footage):
1. The Physical Friction & Barricade Suspense: Active struggle against a locked barrier, violent door rattling, window pounding, or physical standoff before entry (creates massive curiosity gap; never open with casual door opening or routine approach).
2. The Absurd Contradiction: Defiant denial or bizarre claim directly contradicted by obvious physical reality (e.g., suspect on floor insists "I never passed out").
3. In Medias Res: Drop directly into the peak moment of physical struggle, shouting, flying objects, or decisive confrontation. Zero introductory lead-in.
4. Instant Karma / The Fatal Mistake: The exact moment of arrogant provocation or aggression immediately meeting an instant counter-attack or takedown.
5. Unbelievable Stakes: An outrageous or bizarre trigger that reveals the absurd premise of the altercation (e.g., throwing food over sauce).

NEGATIVE DIRECTIVES (STRICTLY FORBIDDEN FOR HOOKS):
- NEVER open with polite greetings, casual chatter, asking for ID, routine traffic questions, casual door opening, or officers walking slowly.
- NEVER start with silent or low-energy lead-ins. Start on the first punchy word, metallic rattle, barrier thud, impact, or scream.
- NEVER spoiler-hook with the final aftermath or empty scene that answers the mystery before the story even begins. Hook the friction/question, not the outcome.

completeBeat means a LOCAL, intelligible quote/action and its necessary immediate response, NOT the resolution of the whole story. A bite and the officer's reaction can be complete while charges are unknown. Taking a patrol car and driving away can be complete while the chase remains unresolved. Never mark a hook incomplete merely because the later investigation, pursuit, punishment or final consequences are absent. Preserve curiosity. Mark false for a genuinely cut-off sentence/action or an unintelligible setup.
Listen to the EXACT returned range, not the entire candidate window. external_narrator means the source channel's added host/commentary. mixed means that host/commentary is audible together with on-scene speech/sound. Several officers/suspects speaking, radio, sirens or engine sounds are NOT by themselves external narration or mixed. Use uncertain when speaker provenance cannot be verified.
If the strongest moment contains external narration or mixed audio, YOU MAY STILL USE IT (it will be muted and dubbed). SOURCE seconds must lie inside attached evidence. Return at most one best hook per candidate.`;
function needsRefresh(plan){return !plan?.stories?.length && plan?.hookPolicyVersion !== VERSION;}
async function assess(engine,candidates,hooks,evidence,target=Infinity){
  const good=[],rejected=[],deferred=[];
  const optionsFor=c=>{const cr=range(c,engine.mediaIndex,engine.duration);return hooks.filter(h=>{try{const hr=range(h,engine.mediaIndex,engine.duration);return hr.start>=cr.start-2 && hr.end<=cr.end+2;}catch(_){return false;}}).sort((a,b)=>b.score-a.score);};
  const ready=c=>optionsFor(c).some(h=>h.completeBeat && h.score>=6 && h.score<=10 && require('./autoStoryAudioClassifier').disposition(h.audio)!=='VERIFY');
  const ordered=candidates.slice().sort((a,b)=>Number(ready(b))-Number(ready(a)));
  for(const candidate of ordered){
    if(good.length>=target){deferred.push(candidate);continue;}
    const options=optionsFor(candidate);
    const reasons=[];let chosen;
    for(const h of options){
      try{
        const hr=range(h,engine.mediaIndex,engine.duration);
        gates.score(h.score);
        if(!evidence.some(e=>hr.start>=e.sourceStart && hr.end<=e.sourceStart+e.duration))throw new StoryError('BAD_CANDIDATE','Hook ngoài media đã xem.');
        // Do not pay for extra audio verification of an already incomplete beat.
        if(!h.completeBeat)throw new StoryError('BAD_CANDIDATE',`Hook chưa trọn nhịp: ${h.completenessReason}`);
        const intent = require('./autoStoryAudioClassifier').disposition(h.audio) === 'CLEAN' ? 'original' : 'narration';
        const verified=await engine.verifyAudio({...h,audioIntent:intent},evidence);
        gates.audition(verified,engine.mediaIndex,engine.duration);chosen=verified;break;
      }catch(error){
        if(engine.signal?.aborted)throw error;
        if(require('./autoStoryProviderErrors').isRateLimit(error))throw error;
        reasons.push(error.message);
      }
    }
    if(chosen)good.push({...candidate,hook:chosen});
    else rejected.push({...candidate,rejection:reasons.join(' | ')||'AI chưa chọn hook trong cửa sổ ứng viên.'});
  }
  return {good,rejected,deferred};
}
async function select(engine,candidates,evidence,outputCount){
  const input=cs=>cs.map(c=>({title:c.title,sourceStartSec:c.sourceStartSec,sourceEndSec:c.sourceEndSec,trigger:c.trigger}));
  const check=v=>{gates.access(v);if(v.hooks.length>candidates.length)throw new StoryError('INVALID_RESPONSE','Too many hook auditions.');};
  const first=await engine.ask('v2-audition',{candidates:input(candidates)},schemas.audition,instruction,evidence,check,'auto_story_plan',{hookSchema:true});
  const initial=await assess(engine,candidates,first.hooks,evidence,outputCount);
  let good=initial.good,rejected=initial.rejected,deferred=initial.deferred;
  if(good.length<outputCount && rejected.length){
    engine.onProgress?.({stage:'hook_reselect',message:`${good.length}/${outputCount} hook đạt; tìm đoạn âm gốc khác cho ${rejected.length} ứng viên (tối đa 1 lượt).`});
    try{
      const retry=await engine.ask('v2-hook_reselect',{candidates:input(rejected),rejections:rejected.map(c=>({title:c.title,reason:c.rejection})),previousHooks:first.hooks},
        schemas.audition,`${instruction}\nRe-audition only rejected candidates. Reevaluate completeness using the local-beat definition; extend a cut-off beat or select another clean moment. Do not blindly flip completeBeat or relabel mixed audio. Verify the revised choice from the video.`,evidence,check,'auto_story_plan',{hookSchema:true});
      const next=await assess(engine,rejected,retry.hooks,evidence,outputCount-good.length);
      good=[...good,...next.good];rejected=next.rejected;deferred=[...deferred,...next.deferred];
    }catch(error){if(engine.signal?.aborted || require('./autoStoryProviderErrors').isRateLimit(error))throw error;rejected=rejected.map(c=>({...c,rejection:`${c.rejection} | Kiểm tra lại: ${error.message}`}));}
  }
  for(const c of rejected)engine.onProgress?.({stage:'hook_rejected',message:`${c.title}: ${c.rejection}`});
  return {good:good.sort((a,b)=>b.hook.score-a.hook.score||b.viralScore-a.viralScore),rejected,deferred};
}
module.exports={instruction,needsRefresh,select,assess,VERSION};
