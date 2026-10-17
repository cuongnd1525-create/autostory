"use strict";

// Editorial quality gate on source selections BEFORE a single V1 draft is rendered.
// This can establish coverage/coherence/source evidence, not predict real virality.
const PROFILE = "viral_tiktok_crime_part1";
const num = (x) => x == null || x === "" ? NaN : Number(x);
const txt = (x) => typeof x === "string" ? x.trim() : "";
const range = (x) => ({
  start: num(x?.sourceStartSec ?? x?.source_start_sec),
  end: num(x?.sourceEndSec ?? x?.source_end_sec)
});
const overlaps = (a,b) => Number.isFinite(a.start) && Number.isFinite(b.start) &&
  a.end > b.start && b.end > a.start;
function readBeats(script) {
  if (Array.isArray(script?.narrativeBeats) && script.narrativeBeats.length) return script.narrativeBeats;
  if (Array.isArray(script?.segments)) return script.segments;
  return [];
}
function modeOf(beat) {
  const v = txt(beat.audio_mode || beat.audioMode);
  return v === "original_audio" ? v : ["voiceover_only","voiceover_with_ambient"].includes(v)
    ? "voiceover_only" : v;
}
function inspectScript(script, { source = {}, seriesPlan = null, videoDurationSec = 0 } = {}) {
  const errors = [], warnings = [];
  const beats = readBeats(script);
  const id = Number(script?.scriptId ?? script?.script_id);
  const declaredProfile = txt(script?.prompt_profile || script?.promptProfile);
  const audit = script?.v1EditorialAudit || script?.v1_editorial_audit || {};
  if (declaredProfile && declaredProfile !== PROFILE) errors.push("Sai profile: " + declaredProfile);
  if (![1,3,4].includes(id)) errors.push("scriptId không phải 1, 3 hoặc 4");
  if (!beats.length) errors.push("Không có source beats để render.");
  const selected = beats.map(range);
  let seconds = 0;
  for (let i=0;i<selected.length;i++) {
    const r=selected[i], beat=beats[i];
    const speed=num(beat.playbackSpeed ?? beat.playback_speed ?? 1);
    if (!(r.end>r.start && r.start>=0 && speed>0 && (!videoDurationSec || r.end<=videoDurationSec+1))) {
      errors.push("Beat "+(i+1)+" có source range/speed không hợp lệ.");
    } else seconds+=(r.end-r.start)/speed;
    if (modeOf(beat)==="original_audio" && txt(beat.voiceoverText||beat.voiceover_text)) {
      errors.push("Beat "+(i+1)+" phát audio gốc nhưng lại có voiceover.");
    }
    if (modeOf(beat)==="voiceover_only") {
      const speech=txt(beat.voiceoverText || beat.voiceover_text);
      const words=speech.split(/\s+/).filter(Boolean).length;
      const speedSec=(r.end-r.start)/(Number.isFinite(speed) && speed>0?speed:1);
      if (words === 0) errors.push("Beat "+(i+1)+" cần narrator nhưng voiceover trống.");
      if (words > 0 && speedSec > 0 && words/speedSec > 2.4) {
        errors.push("Beat "+(i+1)+" TTS quá dồn chữ ("+(words/speedSec).toFixed(2)+
          " từ/giây). Rút gọn câu để đọc tự nhiên.");
      }
    }
  }
  const modes=beats.map(modeOf);
  const runs=modes.filter((x,i)=>i===0||x!==modes[i-1]);
  const pattern=["original_audio","voiceover_only","original_audio","voiceover_only",
    "original_audio","voiceover_only","original_audio","voiceover_only"];
  if (runs.length!==8 || runs.some((x,i)=>x!==pattern[i]))
    errors.push("Cấu trúc 8 nhịp chưa chuẩn: "+runs.join(" -> "));
  let runLength=0, runType="", protectedRun=false;
  const flushRun=() => {
    if (runType==="original_audio" && runLength>22 && !protectedRun) {
      errors.push("Raw audio dài "+runLength.toFixed(1)+
        "s liên tục: chỉ giữ khi có high-action override có chứng cứ; bỏ đoạn chờ/xe đứng yên.");
    }
    if (runType==="voiceover_only" && runLength>22) {
      errors.push("Một nhịp narrator dài "+runLength.toFixed(1)+
        "s: chia hoặc tinh gọn câu và dùng sự kiện gốc chen giữa.");
    }
  };
  for(let i=0;i<beats.length;i++){
    const t=modeOf(beats[i]),r=selected[i];
    const speed=num(beats[i].playbackSpeed ?? beats[i].playback_speed ?? 1);
    const d=r.end>r.start&&speed>0?(r.end-r.start)/speed:0;
    if(t!==runType){if(runType)flushRun();runType=t;runLength=0;protectedRun=false;}
    if (beats[i].actionOverride===true || beats[i].sustainedBeatOverride===true ||
        beats[i].action_override===true || beats[i].sustained_beat_override===true) {
      const supported = (Array.isArray(source.storyTimeline)?source.storyTimeline:[]).some(ev => {
        const er=range(ev);
        return overlaps(er,r) && /climax|confrontation|escalation|evidence/i.test(txt(ev.eventType))
          && Number(ev.storyImportance || ev.viralValue || 0)>=5;
      });
      protectedRun=protectedRun||supported;
    }
    runLength+=d;
  }
  if(runType)flushRun();
  if (seconds < 109.5 || seconds > 125.5) {
    errors.push("Thời lượng source " + seconds.toFixed(1) +
      "s ngoài 110-125s: chọn footage có giá trị, không kéo dài cảnh trống.");
  }
  const part = seriesPlan?.parts?.find(p => Number(p.scriptId)===id);
  if (seriesPlan && !part) errors.push("Không tìm thấy Part trong locked series plan.");
  if (part && selected.length) {
    const allowed=[...(part.sceneAllocation||[]),part.hookRange,
      ...(Array.isArray(part.payoffRanges)?part.payoffRanges:[]),
      ...(seriesPlan.sharedRanges||[])].map(range).filter(r=>r.end>r.start);
    const outside=selected.filter(r=>r.end>r.start &&
      !allowed.some(a=>r.start>=a.start-.5&&r.end<=a.end+.5));
    // Spanning adjacent micro-ranges can be legitimate; flag, but don't
    // pretend all non-contiguous allowed intervals are one continuous event.
    if (outside.length) warnings.push(outside.length+" beat ngoài sceneAllocation đã khóa, cần đối chiếu.");
  }
  // Editorial audit is grounded in source timestamps: host verifies that
  // promised follow-through and ending are actually included in final V1.
  if (!txt(audit.centralViewerQuestion) || !txt(audit.hookPromise)) {
    errors.push("Thiếu v1EditorialAudit.centralViewerQuestion/hookPromise.");
  }
  if (seriesPlan?.centralViewerQuestion && txt(audit.centralViewerQuestion).toLowerCase() !==
      txt(seriesPlan.centralViewerQuestion).toLowerCase()) {
    errors.push("V1 lệch câu hỏi trung tâm đã khóa trong series-plan.json.");
  }
  if (audit.first3SecClear !== true) errors.push("Hook 0-3s chưa được xác nhận đủ rõ cho người xem mới.");
  const first = selected[0];
  if (first && audit.hookSourceSec!=null) {
    const hookT=num(audit.hookSourceSec);
    const firstSpeed=num(beats[0].playbackSpeed ?? beats[0].playback_speed ?? 1);
    if (!Number.isFinite(hookT) || !(first.start-.5<=hookT && hookT<=
        Math.min(first.end+.5,first.start+3*Math.max(0.1,firstSpeed)+.25)))
      errors.push("Trigger Hook phải nằm trong 0-3 giây đầu V1, không phải sâu trong cảnh mở đầu.");
  } else {
    errors.push("Thiếu hookSourceSec để đối chiếu Hook với source.");
  }
  const payoff=num(audit.payoffSourceSec);
  if (!Number.isFinite(payoff)) errors.push("Thiếu payoffSourceSec hoặc next-Part evidence.");
  else if (audit.payoffWithinPart===true && !selected.some(r=>r.start-.5<=payoff&&payoff<=r.end+.5))
    errors.push("Hook-payoff được hứa nhưng không xuất hiện trong V1.");
  else if (audit.payoffWithinPart!==true && audit.verifiedNextPartOpenLoop!==true)
    errors.push("Không có payoff trong Part hoặc open loop thực sự có bằng chứng.");
  if (audit.payoffWithinPart!==true && Number.isFinite(payoff)) {
    const events=Array.isArray(source.storyTimeline)?source.storyTimeline:[];
    if (!events.some(e=>{let r=range(e);return r.start<=payoff&&payoff<=r.end;}))
      errors.push("Cảnh hứa cho Part sau không khớp storyTimeline của source.");
    const nextId=id===1?3:id===3?4:null;
    const next=seriesPlan?.parts?.find(p=>Number(p.scriptId)===nextId);
    if(nextId && next){
      const targetRanges=[...(next.sceneAllocation||[]),...(next.payoffRanges||[])]
        .map(range).filter(r=>r.end>r.start);
      if(!targetRanges.some(r=>r.start-2<=payoff&&payoff<=r.end+2))
        errors.push("Open loop hứa cho Part sau nhưng payoff không nằm trong sceneAllocation Part "+nextId+".");
    }
  }
  const ending=num(audit.endingSourceSec);
  const last=selected[selected.length-1];
  if (!Number.isFinite(ending)||!last||!(last.start-.5<=ending&&ending<=last.end+.5)) {
    errors.push("Ending đã audit không nằm trong đoạn cuối V1.");
  }
  if (audit.endingUsable!==true) errors.push("Ending hình/âm thanh chưa đủ rõ.");
  if (audit.headlineMatchesHook!==true) errors.push("Headline chưa được đối chiếu với Hook thật của Part.");
  const sourceEvents=Array.isArray(source.storyTimeline)?source.storyTimeline:[];
  const indexedEvents=sourceEvents.filter(e=>txt(e.eventId));
  if(indexedEvents.length) {
    for(const [field,time] of [
      ["hookEventId",num(audit.hookSourceSec)],
      ["payoffEventId",payoff],
      ["endingEventId",ending]
    ]) {
      const idValue=txt(audit[field]);
      const event=indexedEvents.find(e=>txt(e.eventId)===idValue);
      const eventRange=range(event);
      if(!event || !Number.isFinite(time) ||
         !(eventRange.start-3<=time && time<=eventRange.end+3))
        errors.push("Không chứng minh được "+field+"="+idValue+" tại nguồn "+time+"s.");
    }
  }
  const weak = Array.isArray(audit.weakSourceRanges)?audit.weakSourceRanges:[];
  for (const w of weak) {
    const wr=range(w);
    if (selected.some(r=>overlaps(wr,r))) errors.push("V1 vẫn sử dụng source yếu " + wr.start+"-"+wr.end+"s: "+txt(w.reason));
  }
  // When Phase A explicitly knows a selected long interval contains an
  // obstructed view, warn AI for reinspection rather than fabricate visuals.
  for(const ev of sourceEvents){
    const desc=[ev.summary,...(ev.visualFacts||[])].filter(Boolean).join(" ");
    const er=range(ev);
    if (/camera (?:is |was )?(?:blocked|obstructed)|lens (?:covered|blocked)|no usable visuals|black screen/i.test(desc) &&
      selected.some(r=>overlaps(er,r))) {
      const extendsFirst3 = first && er.start<first.start+3 && er.end>first.start;
      if(extendsFirst3) errors.push("Hook che camera/mất hình theo nguồn: "+er.start+"-"+er.end+"s.");
      else warnings.push("Source có mô tả khung hình che khuất: "+er.start+"-"+er.end+"s.");
    }
    if(/\b(?:stationary|static|idle|waiting|parked patrol car|dashboard camera|routine paperwork)\b/i.test(desc)) {
      const hasCriticalExchange=(ev.dialogueFacts||[]).some(d => txt(d.quote).length>20);
      const lowValue=Number(ev.storyImportance||ev.viralValue||0)<7;
      const selectedLong=selected.some(r=>overlaps(er,r)&&r.end-r.start>=16);
      if(selectedLong && lowValue && !hasCriticalExchange)
        errors.push("Source tĩnh/ít thông tin bị giữ quá lâu: "+er.start+"-"+er.end+"s.");
    }
  }
  const result={passed:errors.length===0,scriptId:id,seconds:Number(seconds.toFixed(2)),
    errorCount:errors.length,errors,warnings,beatCount:beats.length,runCount:runs.length,
    auditPresent:Boolean(Object.keys(audit).length)};
  return result;
}
function inspectScripts(scripts,{source,seriesPlan,videoDurationSec}={}) {
  const reports=scripts.map(s=>inspectScript(s,{source,seriesPlan,videoDurationSec}));
  for(const id of [1,3,4])if(!reports.some(r=>r.scriptId===id))
    reports.push({scriptId:id,passed:false,errors:["Thiếu Script "+id],warnings:[],seconds:0});
  return {passed:reports.every(r=>r.passed),reports,
    errors:reports.flatMap(r=>(r.errors||[]).map(e=>"Script "+r.scriptId+": "+e))};
}
module.exports={PROFILE,inspectScript,inspectScripts,readBeats};
