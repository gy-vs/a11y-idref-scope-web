import {useCallback, useEffect, useState} from 'react';
import {FlaskConical, Layers, Play, RefreshCw, Save} from 'lucide-react';
import type {MutationOp, SnapshotNode} from '../core/types';
import {findSnapshotNode, type AnalysisResult, type CacheStats, type Finding, type TokenResolution} from '../core/resolver';

type PageInfo = {id:string;name:string;revision:number};
type PageDetail = PageInfo & {snapshot:{root:SnapshotNode;revision:number}};
type AnalysisResponse = {id:string;revision:number;result:AnalysisResult;cache:CacheStats};

export default function App(){
  const [pages,setPages]=useState<PageInfo[]>([]);
  const [selected,setSelected]=useState('page-demo');
  const [detail,setDetail]=useState<PageDetail|null>(null);
  const [analysis,setAnalysis]=useState<AnalysisResponse|null>(null);
  const [activeSource,setActiveSource]=useState<string|null>(null);
  const [activeTargets,setActiveTargets]=useState<string[]>([]);
  const [status,setStatus]=useState('Ready');

  useEffect(()=>{
    Promise.all([
      fetch('/api/audits').then(r=>r.json()),
      fetch('/api/pages').then(r=>r.json()),
    ]).then(([,pageList])=>setPages(pageList));
  },[]);

  const load = useCallback((id:string)=>{
    setStatus('Loading');
    setAnalysis(null);
    setActiveSource(null);
    setActiveTargets([]);
    fetch('/api/pages/'+id).then(r=>r.json()).then((value:PageDetail)=>{
      setDetail(value);
      setStatus('Snapshot rev '+value.revision);
      // Analyze immediately so findings are always visible.
      return fetch('/api/pages/'+id+'/analyze',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({revision:value.revision}),
      }).then(r=>r.json()).then((a:AnalysisResponse)=>{setAnalysis(a);setStatus('Analyzed rev '+a.revision)});
    });
  },[]);

  useEffect(()=>{load(selected)},[selected,load]);

  const analyze = async ()=>{
    if(!detail)return;
    setStatus('Analyzing');
    const response = await fetch('/api/pages/'+detail.id+'/analyze',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({revision:detail.revision}),
    });
    const value = await response.json();
    if(!response.ok){setStatus('Revision conflict - reloading');load(detail.id);return}
    setAnalysis(value);
    setStatus('Analyzed rev '+value.revision);
  };

  const mutate = async (op:MutationOp)=>{
    if(!detail)return;
    setStatus('Mutating');
    const response = await fetch('/api/pages/'+detail.id+'/mutate',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({revision:detail.revision,op}),
    });
    const value = await response.json();
    if(!response.ok){setStatus('Revision conflict - reloading');load(detail.id);return}
    setDetail({id:value.id,name:detail.name,revision:value.revision,snapshot:value.snapshot});
    setAnalysis({id:value.id,revision:value.revision,result:value.result,cache:value.cache});
    setStatus('Mutation applied · rev '+value.revision);
  };

  const focusFinding = (finding:Finding)=>{
    setActiveSource(finding.sourceNid);
    setActiveTargets(finding.tokens.flatMap(t=>t.targets.map(x=>x.nid)).concat(finding.tokens.flatMap(t=>t.unreachable.map(x=>x.nid))));
  };

  const snapshot = detail?.snapshot.root ?? null;
  const highlighted = new Set([...(activeSource?[activeSource]:[]),...activeTargets]);

  return <main className="shell">
    <header className="topbar"><Layers size={20}/><strong>Accessibility Review · Scoped IDREFs</strong><small>document / iframe / shadow-root scopes</small></header>
    <section className="workspace">
      <aside className="pane">
        <h2>Snapshots</h2>
        <div className="list">
          {pages.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
        <div className="hint">The server owns IDREF resolution. The UI only walks the returned snapshot JSON — it never queries its own DOM by id.</div>
      </aside>

      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={analyze}><Play size={15}/>Re-analyze</button>
          <button onClick={()=>load(selected)}><RefreshCw size={15}/>Reload</button>
          <span>{status}</span>
        </div>
        {analysis && <SummaryBar result={analysis.result} cache={analysis.cache}/>}
        {snapshot && <SnapshotTree root={snapshot} highlighted={highlighted} onPick={nid=>{setActiveSource(nid);setActiveTargets([])}} selectedNid={activeSource}/>}
      </section>

      <aside className="pane findings">
        <h2><FlaskConical size={16}/> Findings</h2>
        {analysis?.result.duplicateIds.length? <DuplicateSection result={analysis.result}/>:null}
        <div className="findings-list">
          {analysis?.result.findings.map((finding,i)=><FindingCard key={finding.sourceNid+finding.attribute+i} finding={finding} active={finding.sourceNid===activeSource} onFocus={()=>focusFinding(finding)}/>)}
        </div>
        <MutationPanel onMutate={mutate}/>
      </aside>
    </section>
  </main>;
}

function SummaryBar({result,cache}:{result:AnalysisResult;cache:CacheStats}){
  return <div className="summary">
    <Stat label="scopes" value={result.summary.scopes}/>
    <Stat label="shadow" value={result.summary.shadowScopes}/>
    <Stat label="iframes" value={result.summary.frameScopes}/>
    <Stat label="ok" value={result.summary.ok} tone="ok"/>
    <Stat label="ambiguous" value={result.summary.ambiguous} tone="ambiguous"/>
    <Stat label="missing" value={result.summary.missing} tone="missing"/>
    <span className="cache" title="Scope index cache activity for the last analysis">
      rebuilt {cache.rebuilt.length} · reused {cache.reused.length}
    </span>
  </div>;
}

function Stat({label,value,tone}:{label:string;value:number;tone?:string}){
  return <span className={`stat ${tone??''}`}>{value} <em>{label}</em></span>;
}

function DuplicateSection({result}:{result:AnalysisResult}){
  return <section className="dup-section">
    <h3>Duplicate ids</h3>
    {result.duplicateIds.map(group=><div className="dup-group" key={group.scopeNid+group.id}>
      <code>#{group.id}</code>
      <small>{scopeLabel(group.scopeBoundary)||'top document'} · {group.nodes.length} matches</small>
      <ul>{group.nodes.map(n=><li key={n.nid}><code>{n.nid}</code> {n.tag} <span className="path">{n.path.join(' › ')}</span></li>)}</ul>
    </div>)}
  </section>;
}

function scopeLabel(boundary:Finding['scopeBoundary']):string{
  return boundary.map(b=>b.kind==='shadow'?`shadow(${b.mode})@${b.host}`:`iframe@${b.iframe}`).join(' › ');
}

function FindingCard({finding,active,onFocus}:{finding:Finding;active:boolean;onFocus:()=>void}){
  return <button className={`finding ${finding.severity} ${active?'active':''}`} onClick={onFocus}>
    <div className="finding-head">
      <code>{finding.attribute}</code>
      <span className={`badge ${finding.severity}`}>{finding.severity}</span>
    </div>
    <div className="finding-source">{finding.sourceTag} <code>{finding.sourceNid}</code></div>
    <div className="path">{finding.sourcePath.join(' › ')}</div>
    {finding.scopeBoundary.length>0 && <div className="boundary">scope: {scopeLabel(finding.scopeBoundary)}</div>}
    <div className="tokens">
      {finding.tokens.map(token=><TokenRow key={token.index+token.token} token={token}/>)}
    </div>
  </button>;
}

function TokenRow({token}:{token:TokenResolution}){
  return <div className={`token ${token.status}`}>
    <span className="token-name">"{token.token}"{token.duplicateToken?<em className="repeat" title="repeated token">↺</em>:null}</span>
    {token.targets.map(t=><span className={`target ${t.effective?'effective':'alt'}`} key={t.nid} title={t.path.join(' › ')}>
      → <code>{t.nid}</code> {t.tag}{!t.effective?' (duplicate)':''}
    </span>)}
    {token.status==='missing' && <span className="no-target">no target in scope</span>}
    {token.unreachable.map(u=><span className="blocked" key={u.nid} title={u.path.join(' › ')}>
      blocked by {u.blockedBy.kind} {u.blockedBy.kind==='shadow'?`(${u.blockedBy.mode}) @${u.blockedBy.host}`:`@${u.blockedBy.iframe}`}: <code>{u.nid}</code>
    </span>)}
  </div>;
}

function SnapshotTree({root,highlighted,onPick,selectedNid}:{root:SnapshotNode;highlighted:Set<string>;onPick:(nid:string)=>void;selectedNid:string|null}){
  return <div className="tree"><TreeNode node={root} depth={0} highlighted={highlighted} onPick={onPick} selectedNid={selectedNid}/></div>;
}

function TreeNode({node,depth,highlighted,onPick,selectedNid}:{node:SnapshotNode;depth:number;highlighted:Set<string>;onPick:(nid:string)=>void;selectedNid:string|null}){
  const isHi = highlighted.has(node.nid);
  const isSel = selectedNid===node.nid;
  const refAttrs = ['id','aria-labelledby','aria-describedby','aria-errormessage','aria-controls','aria-flowto','aria-owns','aria-details','aria-activedescendant','for','list'];
  return <div className={`tree-node ${node.kind} ${isHi?'hit':''} ${isSel?'selected':''}`} style={{marginLeft:depth*14}}>
    <button className="node-label" onClick={()=>onPick(node.nid)}>
      {node.kind==='element'&&<><span className="tag">{node.tag}</span>{node.attrs?.id?<span className="idval">#{node.attrs.id}</span>:null}</>}
      {node.kind==='shadow'&&<span className="scope-root">▧ #shadow-root ({node.shadowMode})</span>}
      {node.kind==='document'&&<span className="scope-root">▤ #document</span>}
      {node.kind==='text'&&<span className="textval">"{node.data}"</span>}
      <code className="nid">{node.nid}</code><small className="rev">r{node.rev}</small>
    </button>
    {node.kind==='element'&&node.attrs&&Object.entries(node.attrs).filter(([k])=>refAttrs.includes(k)).map(([k,v])=><div className="attr" key={k}>{k}="{v}"</div>)}
    {node.shadow&&<TreeNode node={node.shadow} depth={depth+1} highlighted={highlighted} onPick={onPick} selectedNid={selectedNid}/>}
    {node.contentDocument&&<TreeNode node={node.contentDocument} depth={depth+1} highlighted={highlighted} onPick={onPick} selectedNid={selectedNid}/>}
    {node.children?.map(child=><TreeNode key={child.nid} node={child} depth={depth+1} highlighted={highlighted} onPick={onPick} selectedNid={selectedNid}/>)}
  </div>;
}

/**
 * Dev/verification toolbar: drives the server-side mutator so the cache
 * invalidation behaviour can be exercised from the UI.
 */
function MutationPanel({onMutate}:{onMutate:(op:MutationOp)=>void}){
  const [nid,setNid]=useState('page-title');
  const [parent,setParent]=useState('open-host');
  return <section className="mutations">
    <h3><Save size={13}/> Node moves / edits</h3>
    <label>nid <input value={nid} onChange={e=>setNid(e.target.value)}/></label>
    <div className="mut-actions">
      <button onClick={()=>onMutate({type:'set-attr',nid,name:'class',value:null})} title="unrelated attr edit: no scope index rebuilt">drop class</button>
      <button onClick={()=>onMutate({type:'set-attr',nid,name:'id',value:'renamed-'+Math.random().toString(36).slice(2,6)})} title="id edit: only owning scope rebuilt">rename id</button>
      <label>parent <input value={parent} onChange={e=>setParent(e.target.value)}/></label>
      <button onClick={()=>onMutate({type:'move',nid,parent})}>move</button>
      <button onClick={()=>onMutate({type:'remove',nid})}>remove</button>
    </div>
  </section>;
}
