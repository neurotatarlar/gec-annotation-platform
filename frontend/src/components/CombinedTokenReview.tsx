import { tokenizeToTokens } from './TokenEditorModel';
import { chipStyles } from './TokenEditorStyles';

export type ReviewAuthor = {author_id:string;username:string;full_name?:string|null;target:string;annotations:any[]};
export function CombinedTokenReview({source,authors}:{source:string;authors:ReviewAuthor[]}) {
  const edits: {start:number;end:number;ann:any;author:ReviewAuthor}[]=[];
  for(const author of authors) for(const ann of author.annotations) {
    const p=ann.payload ?? {};if(p.operation==='noop')continue;
    const snapshot=p.text_tokens?.length?p.text_tokens:tokenizeToTokens(source).map(t=>t.text);
    const positions:{start:number;end:number}[]=[];let cursor=0;
    for(const value of snapshot){const start=source.indexOf(value,cursor);positions.push({start,end:start+value.length});if(start>=0)cursor=start+value.length;}
    const ids=(p.before_tokens??[]).map((id:string)=>/^base-(\d+)$/.exec(id)).filter(Boolean).map((m:any)=>Number(m[1]));
    const startIndex=p.operation==='insert'?ann.start_token:ids.length?Math.min(...ids):p.operation==='move'?p.move_from:ann.start_token;
    const endIndex=p.operation==='insert'?startIndex:ids.length?Math.max(...ids):p.operation==='move'?startIndex+(p.move_len??1)-1:ann.end_token;
    const valid=positions.every(x=>x.start>=0)&&(!p.text_sha256||p.text_tokens?.length);
    const start=valid?(positions[startIndex]?.start??(startIndex===positions.length?source.length:-1)):-1;
    const end=p.operation==='insert'?start:positions[endIndex]?.end??-1;
    edits.push({start,end,ann,author});
  }
  const groups:{start:number;end:number;items:typeof edits}[]=[];
  for(const e of edits.filter(e=>e.start>=0&&e.end>=e.start).sort((a,b)=>a.start-b.start||a.end-b.end)){
    const last=groups[groups.length-1];
    if(last&&(e.start<last.end||e.start===last.start)){last.end=Math.max(last.end,e.end);last.items.push(e);}else groups.push({start:e.start,end:e.end,items:[e]});
  }
  const plain=(s:string,key:string)=>{
    let cursor=0;
    return tokenizeToTokens(s).map((t,i)=>{
      const start=s.indexOf(t.text,cursor);const gap=s.slice(cursor,start);cursor=start+t.text.length;
      return <span key={key+i}><span style={{whiteSpace:'pre-wrap'}}>{gap}</span><span style={{...chipStyles[t.kind],display:'inline-block',padding:'5px 8px'}}>{t.text}</span></span>;
    });
  };
  const variant=(e:typeof edits[number])=><div key={`${e.author.author_id}-${e.ann.id}`} style={{padding:4}}>
    <small style={{color:'#94a3b8'}}>{e.author.full_name||e.author.username} · {e.ann.payload?.operation}</small><br/>
    <span style={{...chipStyles.changed,display:'inline-block',padding:'5px 8px',whiteSpace:'pre-wrap'}}>{e.ann.replacement||'⬚'}</span>
    <small style={{display:'block',color:'#cbd5e1'}}>{e.ann.error_type_name}</small>
  </div>;
  let cursor=0;const content=[];
  for(const [i,g]of groups.entries()){
    content.push(...plain(source.slice(cursor,g.start),`plain-${i}`));
    content.push(<span key={`group-${i}`} style={{display:'inline-flex',verticalAlign:'top',flexDirection:'column',border:'1px solid #475569',borderRadius:8,margin:4,padding:4}}>
      {g.items.map(variant)}<span style={{color:'#94a3b8',borderTop:'1px solid #334155',padding:4,whiteSpace:'pre-wrap'}}>{source.slice(g.start,g.end)||'⬚'}</span>
    </span>);cursor=g.end;
  }
  content.push(...plain(source.slice(cursor),'tail'));
  return <div data-testid="combined-token-review" style={{padding:12,color:'#e2e8f0'}}>{content}
    {edits.filter(e=>e.start<0||e.end<e.start).map(e=><div key={`unplaced-${e.author.author_id}-${e.ann.id}`}><small>Saved position unavailable</small>{variant(e)}</div>)}
  </div>;
}
