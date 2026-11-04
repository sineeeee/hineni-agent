/** Read-only prompt trace; reuse the existing safe Markdown renderer (no innerHTML). */
export const promptFlowClient = String.raw`
function renderPromptFlow(trial){
 const stages=trial.stages||[];if(!stages.length)return empty('本次没有可展示的编排步骤');
 let current=0,source='prompt',raw=false;
 const steps=el('div',{class:'flow-steps',role:'navigation','aria-label':'第三层编排步骤'}),workspace=el('div',{class:'flow-workspace'}),compact=el('div',{class:'flow-compact-nav'});
 const root=el('section',{class:'panel prompt-flow'},el('div',{class:'panel-head'},el('h2',{text:'第三层 Prompt 加工过程'}),badge('只读试算','green')),el('p',{text:trial.note}),el('p',{class:'hint',text:'按加工步骤阅读；召回和灵感实际上可以并行。分支步骤读取各自的文件或状态，不一定依赖紧邻的前一步。左侧是这一步的真实产物，右侧是讲解与实际参数。只有标成主模型片段的文字才会进入最终编排；中间分数和辅助请求不是主模型Prompt。'}),compact,el('div',{class:'flow-layout'},steps,workspace));
 function draw(){
  const stage=stages[current];
  replaceContent(compact,el('div',{class:'flow-group-tabs'},...[...new Set(stages.map(s=>s.group))].map(group=>btn(group,()=>{current=stages.findIndex(s=>s.group===group);source='prompt';draw();},'quiet'+(stage.group===group?' selected':'')))),el('select',{'aria-label':'选择编排步骤',onchange:e=>{current=Number(e.target.value);source='prompt';draw();}},...stages.map((s,i)=>el('option',{value:String(i),selected:i===current,text:(i+1)+'. '+s.title}))));
  replaceContent(steps);for(const group of [...new Set(stages.map(s=>s.group))]){
   const section=el('div',{class:'flow-step-group'},el('div',{class:'flow-group-title',text:group}));
   for(const [i,s]of stages.entries())if(s.group===group){const button=btn('',()=>{current=i;source='prompt';draw();},'flow-step'+(i===current?' active':''));button.setAttribute('aria-current',i===current?'step':'false');button.append(el('span',{class:'flow-step-number',text:String(i+1)}),el('span',{},el('span',{class:'flow-step-title',text:s.title}),el('small',{text:s.kind})));section.append(button);}
   steps.append(section);
  }
  const choose=(key,label,disabled=false)=>{const b=btn(label,()=>{source=key;draw();},'quiet'+(source===key?' selected':''));b.disabled=disabled;return b;};
  const text=source==='input'?stage.input:source==='cumulative'?stage.cumulative:stage.prompt;
  const prompt=el('div',{class:'flow-scroll flow-prompt',tabIndex:0,role:'region','aria-label':'本步骤提示词内容'},raw?el('pre',{class:'flow-raw',text:text||'（空）'}):documentView(text||'（空）'));
  const params=el('div',{class:'flow-params'},...Object.entries(stage.parameters||{}).map(([key,value])=>el('div',{class:'flow-param'},el('code',{text:key}),el('pre',{text:typeof value==='string'?value:JSON.stringify(value,null,2)}))));
  const explanation=el('div',{class:'flow-scroll flow-explanation',tabIndex:0,role:'region','aria-label':'本步骤讲解和参数'},documentView(stage.explanation),el('h4',{text:'这一步实际读取的输入'}),el('pre',{class:'flow-source-input',text:stage.input||'（空）'}),el('h4',{text:'本次实际用到的值'}),params);
  const previous=btn('上一步',()=>{current--;source='prompt';draw();});previous.disabled=current===0;
  const next=btn('下一步',()=>{current++;source='prompt';draw();},'primary');next.disabled=current===stages.length-1;
  replaceContent(workspace,el('div',{class:'flow-stage-header'},el('div',{},el('p',{class:'flow-stage-position',text:stage.group+' · 第 '+(current+1)+' / '+stages.length+' 步'}),el('h3',{text:stage.title})),badge(stage.kind,stage.kind==='回退'?'amber':'')),el('div',{class:'flow-columns'},el('div',{class:'flow-output-column'},el('div',{class:'flow-column-label',text:'本步内容'}),el('div',{class:'flow-tabs',role:'group','aria-label':'切换提示词查看范围'},choose('prompt','本步产物'),choose('input','本步输入'),choose('cumulative','累积 Prompt',stage.cumulative===undefined),btn(raw?'Markdown 预览':'查看原文',()=>{raw=!raw;draw();},'quiet')),prompt,el('p',{class:'hint flow-char-count',text:(text||'').length.toLocaleString()+' 字符；这里只切换显示，不修改内容。'})),el('div',{class:'flow-guide-column'},el('div',{class:'flow-column-label',text:'输入如何变成这一步'}),explanation)),el('div',{class:'flow-bottom-actions'},previous,btn('直接看最终顺序',()=>{current=stages.length-1;source='prompt';draw();}),next));
 }
 draw();return root;
}
`;
