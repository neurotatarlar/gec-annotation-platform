import {useEffect,useRef} from 'react';
import { tokenizeToTokens } from './TokenEditorModel';
import {TokenEditorGroup} from './TokenEditorGroup';
import { chipStyles } from './TokenEditorStyles';
import type {ErrorType} from '../types';
export type ReviewAuthor = {author_id:string;username:string;full_name?:string|null;target:string;annotations:any[]};
type Edit={start:number;end:number;ann:any;author:ReviewAuthor;original?:string};
const noop=()=>{};
function Details({items,children,t,source}:{items:Edit[];children:React.ReactNode;t:(key:string)=>string;source:string}){
 const ref=useRef<HTMLDetailsElement>(null);
 useEffect(()=>{const close=(event:Event)=>{if(event.type==='keydown'&&(event as KeyboardEvent).key!=='Escape')return;if(event.type==='keydown'||!ref.current?.contains(event.target as Node))ref.current?.removeAttribute('open');};document.addEventListener('pointerdown',close);document.addEventListener('keydown',close);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',close);};},[]);
 const place=()=>{if(!ref.current?.open)return;const box=ref.current.getBoundingClientRect();const panel=ref.current.querySelector<HTMLElement>('[role="dialog"]');if(!panel)return;panel.style.position='fixed';panel.style.left=`${Math.max(12,Math.min(box.left,window.innerWidth-panel.offsetWidth-12))}px`;panel.style.top=`${Math.max(12,Math.min(box.bottom+6,window.innerHeight-panel.offsetHeight-12))}px`;};
 return <details ref={ref} onToggle={place} style={{display:'inline-block',position:'relative',verticalAlign:'top',margin:3}}>
 <summary style={{listStyle:'none',cursor:'pointer'}} title={items.map(e=>`${e.author.full_name||e.author.username} · ${e.ann.error_type_name}`).join('\n')}>{children}</summary>
 <div role="dialog" aria-label={t('annotationReview.corrections')} style={{position:'absolute',zIndex:20,top:'100%',left:0,width:340,maxWidth:'calc(100vw - 24px)',boxSizing:'border-box',maxHeight:'50vh',overflow:'auto',padding:12,border:'1px solid #475569',borderRadius:10,background:'#0f172a',boxShadow:'0 8px 25px #0008',fontSize:14,color:'#e2e8f0'}}>
 {items.map(e=><div key={`${e.author.author_id}-${e.ann.id}`} style={{padding:8,borderBottom:'1px solid #334155'}}><strong>{e.author.full_name||e.author.username}</strong><div>{e.ann.error_type_name}{e.ann.payload?.operation==='move'?' ↪':''}</div><div style={{whiteSpace:'pre-wrap'}}><del>{e.original??(source.slice(e.start,e.end)||'⬚')}</del> → <ins>{e.ann.replacement||'⬚'}</ins></div></div>)}
 </div></details>;
}
export function CombinedTokenReview({source,authors,errorTypes=[],tokenFontSize=24,tokenGap=8,t=(key:string)=>key}:{source:string;authors:ReviewAuthor[];errorTypes?:ErrorType[];tokenFontSize?:number;tokenGap?:number;t?:(key:string)=>string}) {
 const edits:Edit[]=[];
 for(const author of authors)for(const ann of author.annotations){
  const p=ann.payload??{};if(p.operation==='noop')continue;
  const snapshot=p.text_tokens?.length?p.text_tokens:tokenizeToTokens(source).map(t=>t.text);
  const positions:{start:number;end:number}[]=[];let cursor=0;let valid=true;
  for(const value of snapshot){const start=source.indexOf(value,cursor);if(start<0||source.slice(cursor,start).trim())valid=false;positions.push({start,end:start+value.length});if(start>=0)cursor=start+value.length;}
  if(source.slice(cursor).trim())valid=false;
  const ids=(p.before_tokens??[]).map((id:string)=>/^base-(\d+)$/.exec(id)).filter(Boolean).map((m:any)=>Number(m[1]));
  // Legacy coordinates are retained only against a verified monotonic snapshot.
  const i=p.operation==='insert'?ann.start_token:ids.length?Math.min(...ids):p.operation==='move'?p.move_from:ann.start_token;
  const j=ids.length?Math.max(...ids):p.operation==='move'?i+(p.move_len??1)-1:ann.end_token;
  const start=valid?(positions[i]?.start??(i===positions.length?source.length:-1)):-1;
  const end=p.operation==='insert'?start:valid?(positions[j]?.end??-1):-1;
  if(p.operation==='move'&&start>=0&&end>=start){
   const original=source.slice(start,end);
   edits.push({start,end,ann:{...ann,reviewMoveRole:'source'},author,original});
   const destination=valid?(positions[p.move_to]?.start??(p.move_to===positions.length?source.length:-1)):-1;
   edits.push({start:destination,end:destination,ann:{...ann,reviewMoveRole:'destination'},author,original});
  }else edits.push({start,end,ann,author});
 }
 const groups:{start:number;end:number;items:Edit[]}[]=[];
 for(const e of edits.filter(e=>e.start>=0&&e.end>=e.start).sort((a,b)=>a.start-b.start||a.end-b.end)){
  const last=groups[groups.length-1];if(last&&(e.start<last.end||e.start===last.start)){last.end=Math.max(last.end,e.end);last.items.push(e);}else groups.push({start:e.start,end:e.end,items:[e]});
 }
 const plain=(value:string,key:string)=>{let cursor=0;return tokenizeToTokens(value).map((tok,i)=>{const start=value.indexOf(tok.text,cursor);const gap=value.slice(cursor,start);cursor=start+tok.text.length;return <span key={key+i}><span style={{whiteSpace:'pre-wrap'}}>{gap}</span><span style={{...chipStyles[tok.kind],fontSize:tokenFontSize}}>{tok.text}</span></span>;});};
 const signature=(e:Edit)=>JSON.stringify([e.start,e.end,e.ann.error_type_id,e.ann.payload?.operation,e.ann.replacement,e.ann.payload?.move_from,e.ann.payload?.move_to,e.ann.payload?.move_len,(e.ann.payload?.after_tokens??[]).map((x:any)=>[x.text,x.space_before,x.line_breaks_before,x.whitespace_before])]);
 let cursor=0;const content=[];
 for(const [index,g]of groups.entries()){
  content.push(...plain(source.slice(cursor,g.start),`plain-${index}`));
  const primary=g.items.find(e=>e.author.author_id===authors[0]?.author_id)??g.items[0];
  const variants=new Set(g.items.map(signature));
  const moveSource=primary.ann.reviewMoveRole==='source';
  const replacement=source.slice(g.start,primary.start)+(moveSource?'':(primary.ann.replacement??''))+source.slice(primary.end,g.end);
  const tokens=tokenizeToTokens(replacement);if(!tokens.length)tokens.push({id:'empty',text:'⬚',kind:'empty',selected:false});
  const history=tokenizeToTokens(source.slice(g.start,g.end));
  const type=errorTypes.find(x=>x.id===primary.ann.error_type_id)??{id:primary.ann.error_type_id,en_name:primary.ann.error_type_name,default_color:'#475569',is_active:true};
  content.push(<Details key={`group-${index}`} items={g.items} t={t} source={source}>
   <TokenEditorGroup group={{tokens,start:index,end:index}} groupIndex={index} tokenFontSize={tokenFontSize} t={t} historyTokens={history} hasHistory showHistoryTokens showBorder={false} showUndo={false}
    moveId={primary.ann.payload?.operation==='move'?`${primary.author.author_id}:${primary.ann.id}`:null} isMoveGroup={primary.ann.payload?.operation==='move'} isMoveDestination={primary.ann.reviewMoveRole==='destination'} isMoveSource={moveSource} isMoveHover={false}
    isPurePunctGroup={tokens.every(x=>x.kind==='punct')} typeObj={moveSource?null:type} badgeText={primary.ann.error_type_name??type.en_name??''} badgeColor={type.default_color} badgeFontSize={Math.max(8,tokenFontSize*.45)} badgePaddingY={1} badgePaddingX={3} badgeRadius={6} groupPadX={2} movePlaceholderHeight={28} dropIndex={null} markerStyle={{}} previousTokenStyle={chipStyles.previous} previousTokenFontStyle="italic"
    measureTextWidth={(text,size)=>text.length*(size??tokenFontSize)*.6} getGapMetrics={(_prev,next)=>({width:next?.spaceBefore?tokenGap:0,markerChar:null})}
    renderToken={(tok,i)=><span key={i} style={{...chipStyles[tok.kind],...chipStyles.changed,fontSize:tokenFontSize}}>{tok.text}</span>}
    onHandleDragOverGap={noop} onHandleDropAt={noop} onHandleRevert={noop} onRevertMove={noop} onSelectRange={noop} onMoveEnter={noop} onMoveLeave={noop} setGroupRef={noop}/>
   {variants.size>1&&<small aria-label={t('annotationReview.alternatives')} style={{position:'absolute',right:-8,top:0,borderRadius:8,background:'#334155',padding:'0 4px',fontSize:10}}>+{variants.size-1}</small>}
  </Details>);cursor=g.end;
 }
 content.push(...plain(source.slice(cursor),'tail'));
 const unplaced=edits.filter(e=>e.start<0||e.end<e.start);
 return <div data-testid="combined-token-review" style={{padding:12,color:'#e2e8f0',lineHeight:1.7}}>{content}{unplaced.length>0&&<details><summary>{t('annotationReview.unplaced')} ({unplaced.length})</summary>{unplaced.map(e=><div key={`${e.author.author_id}-${e.ann.id}`}>{e.author.full_name||e.author.username}: {e.ann.replacement} · {e.ann.error_type_name}</div>)}</details>}</div>;
}
