/** Browser memory inspector. State and in-flight responses are scoped by agent. */
export const memoryClient = String.raw`
const memoryViews=new Map();
async function renderMemory(){
 const id=agentId,path='/v1/agents/'+encodeURIComponent(id)+'/memory',data=await api(path+'/inspect');
 const state=memoryViews.get(id)||{query:'',mode:'recall',sort:'occurred_at',direction:-1,filter:'',trial:null};memoryViews.set(id,state);
 const shell=el('div',{class:'memory-page'}),results=el('div'),detail=el('div'),trialView=el('div');
 const number=(v)=>v===null||v===undefined?'—':Number.isFinite(Number(v))?Number(v).toLocaleString('zh-CN',{maximumFractionDigits:5}):String(v);
 const metric=(r,k)=>({occurred_at:Date.parse(r.memory.occurred_at),importance:r.memory.importance??3,strength:r.factors.naturalStrength,stored_strength:r.stored_index?.strength,activation:r.factors.activation,familiarity:r.stored_index?.familiarity??0,emotion:r.factors.emotion,halfLifeDays:r.factors.halfLifeDays,multiplier:r.factors.multiplier,vectors:r.stored_index?.vector_count??0,score:r.diagnostic?.reranked_score,initial_score:r.diagnostic?.initial_score,selected_score:r.diagnostic?.selected_score,search_rank:r.diagnostic?.search_rank,semantic:r.diagnostic?.semantic,lexical:r.diagnostic?.lexical})[k];
 const sortNames={occurred_at:'发生时间',importance:'重要性（文件值）',strength:'当前剩余强度',stored_strength:'索引中保存的强度',activation:'当前短期激活',familiarity:'重温次数',emotion:'当前情绪联系',halfLifeDays:'长期半衰期（天）',multiplier:'状态加权倍率（不是相关性）',vectors:'向量分片数',score:'重排后检索分',initial_score:'初始检索分',selected_score:'去重后选中分',search_rank:'检索选中名次（不含时间/联想）',semantic:'试算语义相似度',lexical:'试算文字重合度'};
 const sort=el('select',{value:state.sort,onchange:e=>{state.sort=e.target.value;draw();}},...Object.entries(sortNames).map(([value,text])=>el('option',{value,text,selected:value===state.sort})));
 const direction=btn('降序 ↓',()=>{state.direction*=-1;direction.textContent=state.direction<0?'降序 ↓':'升序 ↑';draw();});direction.textContent=state.direction<0?'降序 ↓':'升序 ↑';
 const filter=el('input',{type:'search',placeholder:'筛选概括、人物或编号',value:state.filter,oninput:e=>{state.filter=e.target.value;draw();}});
 async function openEntry(row){
  const card=panel('记忆详情',el('p',{text:row.memory.summary}),el('p',{class:'hint',text:'索引保存强度 '+number(row.stored_index?.strength)+'；按时间算到现在的强度 '+number(row.factors.naturalStrength)+'；实际重温 '+number(row.stored_index?.familiarity??0)+' 次。情绪匹配：'+(row.factors.matchedEmotions.join('、')||'无')+'。factors.contributions 是本次使用的六项加分；主动搜索把用于排序的 strength 视为1，不代表记忆真的恢复。'}),jsonViewer(row,JSON.stringify(row,null,2)),btn('读取实际完整索引（含向量）',async()=>{
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
  const columns=[['记忆','summary'],['重要性','importance'],['剩余强度','strength'],['短期激活','activation'],['重温次数','familiarity'],['情绪联系','emotion'],['半衰期/天','halfLifeDays'],['向量片数','vectors'],['索引状态','indexStatus'],['重排后检索分','score'],['试算去向','result']];
  const table=el('table',{class:'memory-table'},el('thead',{},el('tr',{},...columns.map(([label,key])=>el('th',{},sortNames[key]?btn(label,()=>{if(state.sort===key)state.direction*=-1;else{state.sort=key;state.direction=-1;}sort.value=state.sort;direction.textContent=state.direction<0?'降序 ↓':'升序 ↑';draw();},'quiet'):label)))),el('tbody',{},...rows.map(r=>el('tr',{class:selected.has(r.id)?'memory-selected':''},...columns.map(([,key])=>el('td',{},key==='summary'?btn(r.memory.summary||r.id,()=>openEntry(r),'quiet memory-summary'):key==='indexStatus'?(!r.stored_index?'未建立':!r.index_current?'内容变更待同步':!r.stored_index.vector_count?'待向量化':'可用'):key==='result'?(!state.trial?'尚未试算':selected.has(r.id)?({temporal:'时间带出',association:'随机联想',relevant:'相关检索'}[reason.get(r.id)]||'相关检索'):reason.has(r.id)?'预算未容纳':r.diagnostic?.search_rank?'被时间邻居替换':r.diagnostic?.candidate?'未排进名额':r.diagnostic?.eligible?'候选名额之外':r.diagnostic?'未过相关门槛':'未参与检索'):number(metric(r,key))))))));
  replaceContent(results,el('p',{class:'hint',text:'显示 '+rows.length+' / '+data.rows.length+' 条。点击表头排序，点击概括查看原文、实际索引和评分分项。无查询时没有相关性分，状态倍率也不是最终排名。'}),el('div',{class:'memory-table-scroll'},table));
 }
 function drawTrial(){
  if(!state.trial){replaceContent(trialView);return;}
  const t=state.trial;replaceContent(trialView,panel('本次试算过程',el('p',{class:'hint',text:'试算时间：'+time(t.as_of)+'；输入：'+t.query.original+'。表格评分因素已切到这次试算的时间；记忆原文及索引字段仍是页面读取时的快照。'}),el('p',{text:t.note}),el('p',{text:'实际搜索材料（含query扩展）：'}),el('pre',{class:'reader',text:t.query.expanded}),el('p',{text:'实际带出 '+t.output.length+' 条；query 扩展 → 混合检索 → 重排/去重 → 时间联系/随机联想 → 预算取舍。主动搜索模式只做检索，不执行后续自动编排。'}),jsonViewer(t,JSON.stringify(t,null,2))));
 }
 const query=el('textarea',{rows:3,placeholder:'输入想测试的检索材料，例如：上次提过的那家店',value:state.query,oninput:e=>state.query=e.target.value});
 const mode=el('select',{value:state.mode,onchange:e=>state.mode=e.target.value},el('option',{value:'recall',text:'自动召回：调用query扩展，继续完整记忆编排',selected:state.mode==='recall'}),el('option',{value:'search',text:'主动搜索：不调用query，绕过长期遗忘惩罚',selected:state.mode==='search'}));
 const run=btn('试算一次（调用模型）',async()=>{
  if(!state.query.trim())throw Error('先填写检索材料');run.disabled=true;run.textContent='正在试算…';
  try{const t=await api(path+'/simulate','POST',{query:state.query,mode:state.mode});state.trial=t;if(agentId!==id||view!=='memory')return;draw();drawTrial();notify('试算完成，未改变真实记忆状态。');}
  finally{run.disabled=false;run.textContent='试算一次（调用模型）';}
 },'primary');
 shell.append(panel('记忆原文与实际运行数据',el('p',{text:'memory.json 是记忆内容的原本；数据库 kv 中的 index:'+id+' 保存检索索引和强度/重温次数，search-index.json 是同份索引的文件副本；短期激活在 state.json。不是数据库里一条记忆一行，而是每个 agent 一份索引对象。'}),el('p',{class:'hint',text:'只读快照：'+time(data.as_of)+'；当前读取来源：'+(data.index_source==='database'?'数据库':'索引文件回退')+'。当前运行配置参与计算，尚未重启的配置草稿不参与。'}),el('details',{},el('summary',{text:'文件位置、当前情绪和全部记忆参数'}),jsonViewer({paths:data.paths,current_emotions:data.current_emotions,policy:data.policy},JSON.stringify({paths:data.paths,current_emotions:data.current_emotions,policy:data.policy},null,2))),el('p',{class:'hint',text:'目前 '+data.rows.filter(r=>r.configured_emotion_matches.length).length+' / '+data.rows.length+' 条记忆的emotion文字能匹配配置中的情绪名称。其余仍可文字/语义召回。匹配采用名称包含关系，不做同义词理解；记忆里的intensity、valence不直接参与此项计算。matchedEmotions显示与当前情绪的匹配，configured_emotion_matches显示与配置名称的匹配。只读查看不会增加激活或强化。'})),panel('排序与查看',el('div',{class:'toolbar'},filter,sort,direction,btn('刷新快照并清除试算',async()=>{state.trial=null;await show('memory');})),results,el('details',{},el('summary',{text:'这些数字是什么意思？'}),el('p',{text:'剩余强度和短期激活是0～1；重温次数是实际强化过的次数。情绪联系也是0～1的匹配分，不是当前情绪强度。半衰期由这条重要性和当前配置计算。没有查询时，只能比较这些状态，不能得到相关性排名。试算检索分先结合文字/语义排名和状态倍率，再经过重排、相似内容去重；时间邻居和随机联想不靠这个分数选入。详情里的contributions可逐项查看基础底分和五种加分。'}))),panel('模拟一次记忆召回',el('p',{text:'这里直接测试记忆服务，不制造聊天事件，不自动带入最近聊天；请把需要检索的材料填写完整。点击才会调用当前辅助/向量模型并可能产生费用。自动模式遵循memory.enabled；时间邻居和随机联想也照当前配置运行。'}),query,el('div',{class:'toolbar'},mode,run,btn('清除试算',()=>{state.trial=null;draw();drawTrial();}))),trialView,detail);
 draw();drawTrial();return shell;
}
`;
