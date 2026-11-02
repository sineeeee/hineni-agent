/** Browser-only renderer. Branches are lazy and strings stay textContent, never HTML. */
export const jsonViewerClient = String.raw`
function jsonViewer(value,raw){
 const tree=el('div',{class:'json-tree',role:'region','aria-label':'可折叠 JSON 上下文',tabIndex:0});
 const preview=v=>{if(Array.isArray(v))return '['+v.length+' 项]';if(v&&typeof v==='object')return '{'+Object.keys(v).length+' 个字段}';return typeof v==='string'?JSON.stringify(v.slice(0,120))+(v.length>120?' …':''):JSON.stringify(v);};
 function node(key,v,depth){
  const label=el('span',{class:'json-key',text:key});
  if(v!==null&&typeof v==='object'){
   const entries=Object.entries(v),body=el('div',{class:'json-children'});let cursor=0;
   const d=el('details',{class:'json-node',open:depth===0},el('summary',{},label,el('span',{class:'json-count',text:preview(v)})),body);
   const more=btn('显示后续项目',()=>batch(),'quiet json-more');
   function batch(){more.remove();const end=Math.min(entries.length,cursor+50);while(cursor<end){const [k,x]=entries[cursor++];body.append(node(Array.isArray(v)?'['+k+']':k,x,depth+1));}if(cursor<entries.length){more.textContent='再显示 '+Math.min(50,entries.length-cursor)+' 项（剩余 '+(entries.length-cursor)+' 项）';body.append(more);}}
   d.addEventListener('toggle',()=>{if(d.open&&!cursor&&entries.length)batch();});if(depth===0)batch();return d;
  }
  if(typeof v==='string'&&(v.length>240||v.includes('\n'))){
   const d=el('details',{class:'json-node json-string'},el('summary',{},label,el('span',{class:'json-count',text:v.length.toLocaleString()+' 字符'}),el('span',{class:'json-snippet',text:v.slice(0,100).replace(/\s+/g,' ')+'…'})));
   let loaded=false;d.addEventListener('toggle',()=>{if(d.open&&!loaded){loaded=true;d.append(el('pre',{class:'json-text',tabIndex:0,text:v}));}});return d;
  }
  return el('div',{class:'json-leaf'},label,el('span',{class:'json-value json-'+(v===null?'null':typeof v),text:JSON.stringify(v)}));
 }
 const root=node('context',value,0);tree.append(root);
 const original=el('pre',{class:'reader json-original',hidden:true});
 const toggle=btn('查看 JSON 原文',()=>{const isTree=!tree.hidden;tree.hidden=isTree;original.hidden=!isTree;if(isTree)original.textContent=raw;toggle.textContent=isTree?'返回折叠视图':'查看 JSON 原文';});
 return el('div',{class:'json-viewer'},el('div',{class:'toolbar json-actions'},btn('展开一层',()=>{tree.hidden=false;original.hidden=true;toggle.textContent='查看 JSON 原文';const pending=[...tree.querySelectorAll('details:not([open])')].filter(d=>!d.parentElement.closest('details:not([open])'));if(!pending.length)root.open=true;else for(const d of pending)d.open=true;}),btn('收起内容',()=>{for(const d of tree.querySelectorAll('details'))d.open=d===root;}),toggle),tree,original);
}
`;
