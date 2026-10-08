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
  }
  const modes=beats.map(modeOf);
  const runs=modes.filter((x,i)=>i===0||x!==modes[i-1]);
  const pattern=["original_audio","voiceover_only","original_audio","voiceover_only",
    "original_audio","voiceover_only","original_audio","voiceover_only"];
  if (runs.length!==8 || runs.some((x,i)=>x!==pattern[i]))
    errors.push("Cấu trúc 8 nhịp chưa chuẩn: "+runs.join(" -> "));
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
  if (audit.first3SecClear !== true) errors.push("Hook 0-3s chưa được xác nhận đủ rõ cho người xem mới.");
  const first = selected[0];
  if (first && audit.hookSourceSec!=null) {
    const hookT=num(audit.hookSourceSec);
    if (!Number.isFinite(hookT)||!(first.start-.5<=hookT&&hookT<=first.end+.5))
      errors.push("Hook được audit không nằm trong cảnh mở đầu V1.");
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
  }
  const ending=num(audit.endingSourceSec);
  const last=selected[selected.length-1];
  if (!Number.isFinite(ending)||!last||!(last.start-.5<=ending&&ending<=last.end+.5)) {
    errors.push("Ending đã audit không nằm trong đoạn cuối V1.");
  }
  if (audit.endingUsable!==true) errors.push("Ending hình/âm thanh chưa đủ rõ.");
  const weak = Array.isArray(audit.weakSourceRanges)?audit.weakSourceRanges:[];
  for (const w of weak) {
    const wr=range(w);
    if (selected.some(r=>overlaps(wr,r))) errors.push("V1 vẫn sử dụng source yếu " + wr.start+"-"+wr.end+"s: "+txt(w.reason));
  }
  // When Phase A explicitly knows a selected long interval contains an
  // obstructed view, warn AI for reinspection rather than fabricate visuals.
  for(const ev of Array.isArray(source.storyTimeline)?source.storyTimeline:[]){
    const desc=[ev.summary,...(ev.visualFacts||[])].filter(Boolean).join(" ");
    const er=range(ev);
    if (/camera (?:is |was )?(?:blocked|obstructed)|lens (?:covered|blocked)|no usable visuals|black screen/i.test(desc) &&
      selected.some(r=>overlaps(er,r))) {
      warnings.push("Source có mô tả khung hình che khuất: "+er.start+"-"+er.end+"s.");
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
