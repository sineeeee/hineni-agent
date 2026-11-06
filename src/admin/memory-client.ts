/** Browser memory inspector. State and in-flight responses are scoped by agent. */
export const memoryClient = String.raw`
const memoryViews=new Map();
async function renderMemory(){
 const id=agentId,path='/v1/agents/'+encodeURIComponent(id)+'/memory',data=await api(path+'/inspect');
 const state=memoryViews.get(id)||{query:'',mode:'context',trigger:'user',sort:'occurred_at',direction:-1,filter:'',trial:null};memoryViews.set(id,state);
 const shell=el('div',{class:'memory-page'}),results=el('div'),detail=el('div'),trialView=el('div');
 const number=(v)=>v===null||v===undefined?'—':Number.isFinite(Number(v))?Number(v).toLocaleString('zh-CN',{maximumFractionDigits:5}):String(v);
 const metric=(r,k)=>({occurred_at:Date.parse(r.memory.occurred_at),importance:r.memory.importance??3,strength:r.factors.naturalStrength,stored_strength:r.stored_index?.strength,activation:r.factors.activation,familiarity:r.stored_index?.familiarity??0,emotion:r.factors.emotion,halfLifeDays:r.factors.halfLifeDays,multiplier:r.factors.multiplier,vectors:r.stored_index?.vector_count??0,feeling_vectors:r.stored_index?.feeling_vector_count??0,feeling_semantic:r.diagnostic?.feeling_semantic,score:r.diagnostic?.reranked_score,initial_score:r.diagnostic?.initial_score,selected_score:r.diagnostic?.selected_score,search_rank:r.diagnostic?.search_rank,semantic:r.diagnostic?.semantic,lexical:r.diagnostic?.lexical})[k];
 const sortNames={occurred_at:'发生时间',importance:'重要性（文件值）',strength:'当前剩余强度',stored_strength:'索引中保存的强度',activation:'当前短期激活',familiarity:'重温次数',emotion:'当前情绪联系',halfLifeDays:'长期半衰期（天）',multiplier:'状态加权倍率（不是相关性）',vectors:'事实向量分片数',feeling_vectors:'感受向量分片数',feeling_semantic:'感受语义相似度',score:'重排后检索分',initial_score:'初始检索分',selected_score:'去重后选中分',search_rank:'检索选中名次（不含时间/联想）',semantic:'试算语义相似度',lexical:'试算文字重合度'};
 const sort=el('select',{value:state.sort,onchange:e=>{state.sort=e.target.value;draw();}},...Object.entries(sortNames).map(([value,text])=>el('option',{value,text,selected:value===state.sort})));
 const direction=btn('降序 ↓',()=>{state.direction*=-1;direction.textContent=state.direction<0?'降序 ↓':'升序 ↑';draw();});direction.textContent=state.direction<0?'降序 ↓':'升序 ↑';
 const filter=el('input',{type:'search',placeholder:'筛选概括、人物或编号',value:state.filter,oninput:e=>{state.filter=e.target.value;draw();}});
 async function refreshMemory(){state.trial=null;if(agentId===id&&view==='memory')await show('memory');}
 async function rebuild(side,ids){if(!confirm('重新生成'+({both:'两侧',fact:'事实侧',feeling:'感受侧'}[side])+'向量？会调用已配置模型；原始记忆、强度和重温次数保留。'))return;await startVectorize({side,force:true,...(ids?{ids}:{})});}
 function editEntry(row){
  const source=row?structuredClone(row.memory):{occurred_at:new Date().toISOString(),type:'event',people:[],summary:'',details:'',emotion:{valence:'neutral',labels:[],intensity:0,feeling:''},importance:3};
  const input=el('textarea',{rows:20,wrap:'off',class:'memory-json-editor',value:JSON.stringify(source,null,2),'aria-label':'记忆条目 JSON'});
  const message=el('p',{class:'hint',text:'修改memory.json中的这一条。ID不可修改；其他未改字段原样保留。保存立即同步检索文字并使变化侧旧向量失效。'});
  const save=async rebuild=>{
   const entry=JSON.parse(input.value);
   await api(path+'/entries'+(row?'/'+encodeURIComponent(row.id):''),row?'PUT':'POST',{version:data.version,entry,rebuild});
   notify(rebuild?'记忆已保存，已安排补齐向量。':'记忆已保存；文字检索已更新，向量等待维护。');await refreshMemory();
  };
  replaceContent(detail,panel(row?'编辑记忆':'新增记忆',message,input,el('div',{class:'toolbar'},btn('只保存',()=>save(false)),btn('保存并补齐向量',()=>save(true),'primary'),btn('取消',()=>replaceContent(detail)))));
 }
 async function removeEntry(row){if(!confirm('删除这条记忆及两侧索引？这是删除memory.json原文，不删除历史聊天或过去的请求快照。'))return;await api(path+'/entries/'+encodeURIComponent(row.id),'DELETE',{version:data.version});notify('记忆及两侧索引已删除。');await refreshMemory();}
 async function openEntry(row){
  const card=panel('记忆详情',el('div',{class:'toolbar'},btn('编辑此条',()=>editEntry(row)),btn('删除此条',()=>removeEntry(row)),btn('重建此条事实向量',()=>rebuild('fact',[row.id])),btn('重建此条感受向量',()=>rebuild('feeling',[row.id]))),panel('事实检索内容',el('pre',{class:'reader',text:row.stored_index?.text||'尚未同步'}),el('p',{class:'hint',text:'来自summary、details、people和agent_name。向量片数：'+number(row.stored_index?.vector_count)})),panel('感受检索内容',el('pre',{class:'reader',text:row.stored_index?.feelingText||'没有labels/feeling，不制造感受'}),el('p',{class:'hint',text:'仅来自emotion.labels与emotion.feeling。向量片数：'+number(row.stored_index?.feeling_vector_count)})),el('p',{text:row.memory.summary}),el('p',{class:'hint',text:'索引保存强度 '+number(row.stored_index?.strength)+'；按时间算到现在的强度 '+number(row.factors.naturalStrength)+'；实际重温 '+number(row.stored_index?.familiarity??0)+' 次。情绪匹配：'+(row.factors.matchedEmotions.join('、')||'无')+'。factors.contributions 是本次使用的六项加分；主动搜索把用于排序的 strength 视为1，不代表记忆真的恢复。'}),jsonViewer(row,JSON.stringify(row,null,2)),btn('读取实际完整索引（含向量）',async()=>{
   const full=await api(path+'/inspect?id='+encodeURIComponent(row.id));if(agentId!==id||view!=='memory')return;
   replaceContent(detail,panel('实际原文、索引与计算值',el('p',{class:'hint',text:'stored_index 是当前实际使用的索引，vectors 可展开；factors 是按本次时间与运行配置现算的值。缺失或失效的索引不会在预览中重建。'}),jsonViewer(full.rows[0],JSON.stringify(full.rows[0],null,2))));
  }));replaceContent(detail,card);
 }
 function draw(){
  const diagnostic=new Map((state.trial?.search?.entries||[]).map(x=>[x.id,x]));
  const selected=new Set((state.trial?.output||[]).map(x=>x.id));
  const reason=new Map((state.trial?.recall?.expanded_ids||[]).map(x=>[x.id,x.reason]));
  const rows=data.rows.map(r=>({...r,factors:diagnostic.get(r.id)?.factors||r.factors,diagnostic:diagnostic.get(r.id)})).filter(r=>(r.memory.summary+' '+JSON.stringify(r.memory.people)+' '+r.id).toLowerCase().includes(state.filter.toLowerCase()));
  rows.sort((a,b)=>{const x=metric(a,state.sort),y=metric(b,state.sort);if(x==null||!Number.isFinite(x))return y==null||!Number.isFinite(y)?0:1;if(y==null||!Number.isFinite(y))return -1;return state.direction*(x-y)||a.id.localeCompare(b.id);});
  const columns=[['记忆','summary'],['重要性','importance'],['剩余强度','strength'],['短期激活','activation'],['重温次数','familiarity'],['情绪联系','emotion'],['半衰期/天','halfLifeDays'],['事实向量','vectors'],['感受向量','feeling_vectors'],['命中路线','routes'],['索引状态','indexStatus'],['重排后检索分','score'],['试算去向','result']];
  const table=el('table',{class:'memory-table'},el('thead',{},el('tr',{},...columns.map(([label,key])=>el('th',{},sortNames[key]?btn(label,()=>{if(state.sort===key)state.direction*=-1;else{state.sort=key;state.direction=-1;}sort.value=state.sort;direction.textContent=state.direction<0?'降序 ↓':'升序 ↑';draw();},'quiet'):label)))),el('tbody',{},...rows.map(r=>el('tr',{class:selected.has(r.id)?'memory-selected':''},...columns.map(([,key])=>el('td',{},key==='summary'?btn(r.memory.summary||r.id,()=>openEntry(r),'quiet memory-summary'):key==='routes'?((r.diagnostic?.matched_routes?.map(x=>x==='fact'?'事实':'感受').join(' + ')||'—')+(r.diagnostic?.allocated_route?'（占'+(r.diagnostic.allocated_route==='fact'?'事实':'感受')+'名额）':'')):key==='indexStatus'?(!r.stored_index?'未建立':!r.index_current?'内容变更待同步':!r.stored_index.vector_count?'事实待向量化':data.policy.memory.feelingRecall&&r.stored_index.feelingText&&!r.stored_index.feeling_vector_count?'感受待向量化':'可用'):key==='result'?(!state.trial?'尚未试算':selected.has(r.id)?({temporal:'时间带出',association:'随机联想',relevant:'相关检索'}[reason.get(r.id)]||'相关检索'):reason.has(r.id)?'预算未容纳':r.diagnostic?.search_rank?'被时间邻居替换':r.diagnostic?.candidate?'未排进名额':r.diagnostic?.eligible?'候选名额之外':r.diagnostic?'未过相关门槛':'未参与检索'):number(metric(r,key))))))));
  replaceContent(results,el('p',{class:'hint',text:'显示 '+rows.length+' / '+data.rows.length+' 条。点击表头排序，点击概括查看原文、实际索引和评分分项。无查询时没有相关性分，状态倍率也不是最终排名。'}),el('div',{class:'memory-table-scroll'},table));
 }
 function drawTrial(){
  if(!state.trial){replaceContent(trialView);return;}
  const t=state.trial;if(t.stages){replaceContent(trialView,renderPromptFlow(t),el('details',{class:'flow-raw-details'},el('summary',{text:'开发者数据：本次完整JSON'}),jsonViewer(t,JSON.stringify(t,null,2))));return;}replaceContent(trialView,panel('本次试算过程',el('p',{class:'hint',text:'试算时间：'+time(t.as_of)+'；输入：'+t.query.original+'。表格评分因素已切到这次试算的时间；记忆原文及索引字段仍是页面读取时的快照。'}),el('p',{text:t.note}),el('p',{text:'实际搜索材料（含query扩展）：'}),el('pre',{class:'reader',text:t.query.expanded}),el('p',{text:'感受查询（不使用当前情绪）：'}),el('pre',{class:'reader',text:t.query.feeling||'本轮跳过'}),el('p',{text:'实际带出 '+t.output.length+' 条；query 扩展 → 混合检索 → 重排/去重 → 时间联系/随机联想 → 预算取舍。主动搜索模式只做检索，不执行后续自动编排。'}),jsonViewer(t,JSON.stringify(t,null,2))));
 }
 const query=el('textarea',{rows:3,placeholder:'输入一轮想测试的话，例如：又想起那家拉面店了',value:state.query,oninput:e=>state.query=e.target.value});
 const mode=el('select',{value:state.mode,onchange:e=>{state.mode=e.target.value;triggerSelect.hidden=state.mode!=='context';}},el('option',{value:'context',text:'完整第三层：逐步查看 Prompt 加工（省略历史）',selected:state.mode==='context'}),el('option',{value:'recall',text:'自动召回：调用query扩展，继续完整记忆编排',selected:state.mode==='recall'}),el('option',{value:'search',text:'主动搜索：不调用query，绕过长期遗忘惩罚',selected:state.mode==='search'}));
 const triggerSelect=el('select',{'aria-label':'试算输入类型',hidden:state.mode!=='context',onchange:e=>state.trigger=e.target.value},el('option',{value:'user',text:'真人输入',selected:state.trigger!=='random_chat'}),el('option',{value:'random_chat',text:'内部主动联系事件',selected:state.trigger==='random_chat'}));
 const run=btn('试算一次（调用模型）',async()=>{
  if(!state.query.trim())throw Error('先填写检索材料');run.disabled=true;run.textContent='正在试算…';
  try{const t=await api(path+'/simulate','POST',{query:state.query,mode:state.mode,trigger:state.trigger||'user'});state.trial=t;if(agentId!==id||view!=='memory')return;draw();drawTrial();notify('试算完成，未改变真实记忆状态。');}
  finally{run.disabled=false;run.textContent='试算一次（调用模型）';}
 },'primary');
 shell.append(panel('记忆原文与实际运行数据',el('p',{text:'memory.json 是记忆内容的原本；数据库 kv 中的 index:'+id+' 保存检索索引和强度/重温次数，search-index.json 是同份索引的文件副本；短期激活在 state.json。同一条记忆有事实text/vectors与感受feelingText/feelingVectors两套检索内容，共用ID、强度和重温次数。没有labels/feeling的旧条目不编造感受向量。不是两个独立记忆库。'}),el('p',{class:'hint',text:'读取时间：'+time(data.as_of)+'；当前读取来源：'+(data.index_source==='database'?'数据库':'索引文件回退')+'。当前运行配置参与计算，尚未重启的配置草稿不参与。'}),el('details',{},el('summary',{text:'文件位置、当前情绪和全部记忆参数'}),jsonViewer({paths:data.paths,current_emotions:data.current_emotions,policy:data.policy},JSON.stringify({paths:data.paths,current_emotions:data.current_emotions,policy:data.policy},null,2))),el('p',{class:'hint',text:'目前 '+data.rows.filter(r=>r.configured_emotion_matches.length).length+' / '+data.rows.length+' 条记忆的emotion文字能匹配配置中的情绪名称。其余仍可文字/语义召回。匹配采用名称包含关系，不做同义词理解；记忆里的intensity、valence不直接参与此项计算。matchedEmotions显示与当前情绪的匹配，configured_emotion_matches显示与配置名称的匹配。只读查看不会增加激活或强化。'})),panel('排序与查看',el('div',{class:'toolbar'},btn('新增记忆',()=>editEntry(null),'primary'),btn('补齐缺失向量',()=>startVectorize({side:'both'})),btn('重建事实侧',()=>rebuild('fact')),btn('重建感受侧',()=>rebuild('feeling')),btn('重建两侧',()=>rebuild('both')),filter,sort,direction,btn('刷新快照并清除试算',async()=>{state.trial=null;await show('memory');})),el('p',{id:'memoryIndexProgress',class:'hint',text:'正在读取两侧索引状态…'}),results,el('details',{},el('summary',{text:'这些数字是什么意思？'}),el('p',{text:'剩余强度和短期激活是0～1；重温次数是实际强化过的次数。情绪联系也是0～1的匹配分，不是当前情绪强度。半衰期由这条重要性和当前配置计算。没有查询时，只能比较这些状态，不能得到相关性排名。试算检索分先结合文字/语义排名和状态倍率，再经过重排、相似内容去重；时间邻居和随机联想不靠这个分数选入。详情里的contributions可逐项查看基础底分和五种加分。'}))),panel('只读试算：记忆与第三层 Prompt',el('p',{text:'完整第三层模式会展示输入、query、各轮筛选、项目与Skills说明、情绪/驱动力映射、可选灵感和最终顺序。省略对话历史，不发送消息、不更新记忆或状态。点击才调用辅助/向量模型，可能产生费用；不会调用第四层主模型。原有自动召回和主动搜索模式仍可单独使用。'}),query,el('div',{class:'toolbar'},mode,triggerSelect,run,btn('清除试算',()=>{state.trial=null;draw();drawTrial();}))),trialView,detail);
 draw();drawTrial();return shell;
}
`;
