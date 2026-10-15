/* Anime Lore standalone setup controller. Keeps other modes untouched. */
(() => {
  const $ = id => document.getElementById(id);
  const set = (id,text) => {const n=$(id);if(n)n.textContent=String(text||'');};
  const read = id => $(id)?.value?.trim()||'';
  let running=false,projectId='';
  const sync = () => {
    $('anime-run').disabled=running;
    $('anime-resume').disabled=running;
    $('anime-cancel').disabled=!running;
  };
  const progress = payload => {
    if (!payload || payload.stage!=='anime_lore') return;
    if(payload.projectId){projectId=payload.projectId;$('anime-existing-project-id').value=projectId;}
    $('anime-run-progress').value=Math.min(99,Number(payload.percent)||0);
    set('anime-run-status',payload.phase||payload.step);
    set('anime-run-stage',payload.message);
  };
  async function execute(resume=false) {
    if(running)return;
    let payload={};
    if(resume) {
      const id=read('anime-existing-project-id');
      if(!id){set('anime-run-result','Vui lòng nhập Anime project ID để resume.');return;}
      payload={projectId:id};
    } else {
      const input={series:read('anime-series'),character:read('anime-character'),topic:read('anime-topic'),
        medium:$('anime-medium').value,spoilerThrough:read('anime-through'),durationSec:Number($('anime-duration').value),
        workMode:'guided',canonText:read('anime-canon'),mediaFolder:read('anime-media-folder'),
        mediaRightsConfirmed:$('anime-media-rights').checked,voiceProvider:$('anime-voice-provider').value,
        voiceId:read('anime-voice-id')};
      if(!input.series||!input.topic){set('anime-run-result','Thiếu Anime series hoặc topic.');return;}
      if(!input.canonText){set('anime-run-result','Cần ít nhất một fact kèm episode/chapter làm bằng chứng.');return;}
      if(!input.mediaRightsConfirmed){set('anime-run-result','Chưa xác nhận quyền dùng thư viện media.');return;}
      payload={input};
    }
    running=true;sync();
    $('anime-run-progress').value=0;
    set('anime-run-status','Đang chạy');
    set('anime-run-result','');
    try {
      const result=await window.cineviral.runAnimeLore(payload);
      if(result.projectId){projectId=result.projectId;$('anime-existing-project-id').value=projectId;}
      $('anime-run-progress').value=result.status==='complete'?100:Math.min(99,Number($('anime-run-progress').value)||0);
      set('anime-run-status',result.status||'unknown');
      set('anime-run-stage',result.message||result.reason||'Finished. See the result and relevant output files below.');
      set('anime-run-result',JSON.stringify(result,null,2));
    }catch(error){
      set('anime-run-status','failed');
      set('anime-run-result',String(error?.message||error));
    }finally{running=false;sync();}
  }
  $('anime-media-pick')?.addEventListener('click',async()=>{
    const folder=await window.cineviral.pickFolder();
    if(folder)$('anime-media-folder').value=folder;
  });
  $('anime-run')?.addEventListener('click',()=>execute(false));
  $('anime-resume')?.addEventListener('click',()=>execute(true));
  $('anime-cancel')?.addEventListener('click',()=>window.cineviral.cancelAnimeLore());
  window.cineviral.onAnimeLoreProgress?.(progress);
  sync();
})();