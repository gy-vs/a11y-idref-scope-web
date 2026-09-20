import {useCallback, useEffect, useMemo, useState} from 'react';
import {FlaskConical, Play, Save, Boxes, Crosshair} from 'lucide-react';
import {locate, BOUNDARY_LABEL, summarizeSeverity, nodeLabel} from './locate';
import type {AnalysisResult, LocatedNode, SnapshotData, VDocument, VNode} from '../core/types';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

export default function App(){
  const [view,setView]=useState<'audits'|'scopes'>('scopes');
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Accessibility Review</strong><small>Local workspace</small><nav className="views"><button className={view==='audits'?'active':''} onClick={()=>setView('audits')}>Audits</button><button className={view==='scopes'?'active':''} onClick={()=>setView('scopes')}><Boxes size={14}/>ARIA scopes</button></nav></header>{view==='audits'?<Audits/>:<Scopes/>}</main>;
}

function Audits(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [status,setStatus]=useState('Ready');
  useEffect(()=>{fetch('/api/audits').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/audits/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/audits/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/audits/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  return <section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre></aside></section>;
}

// ---------------------------------------------------------------------------
// ARIA scope workbench
// ---------------------------------------------------------------------------

function Scopes(){
  const [snapshotData,setSnapshotData]=useState<SnapshotData|null>(null);
  const [result,setResult]=useState<AnalysisResult|null>(null);
  const [selectedSid,setSelectedSid]=useState<string|null>(null);
  const [located,setLocated]=useState<LocatedNode|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);

  const load = useCallback(async()=>{
    const snap=(await (await fetch('/api/snapshot')).json()) as SnapshotData;
    setSnapshotData(snap);
    setSelectedSid(null);setLocated(null);
  },[]);
  useEffect(()=>{load()},[load]);

  const run = useCallback(async()=>{
    if(!snapshotData)return;
    setBusy(true);setError(null);
    const response=await fetch('/api/snapshot/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(snapshotData)});
    if(!response.ok){setError('Analysis rejected: '+response.status);setBusy(false);return}
    setResult(await response.json());setBusy(false);
  },[snapshotData]);

  const counts=useMemo(()=>result?summarizeSeverity(result):null,[result]);

  const onLocate=useCallback((findingIndex:number,tokenIndex:number)=>{
    if(!snapshotData||!result)return;
    const finding=result.findings[findingIndex];
    const hit=locate(snapshotData,finding,tokenIndex);
    setLocated(hit);
    setSelectedSid(hit.sid||finding.sourceSid);
  },[snapshotData,result]);

  return <section className="scope-workspace">
    <div className="toolbar scope-toolbar">
      <button className="primary" onClick={run} disabled={busy||!snapshotData}><Play size={15}/>{busy?'Analyzing…':'Analyze IDREFs'}</button>
      <button onClick={load}>Reload snapshot</button>
      {snapshotData&&<span className="pill">snapshot revision {snapshotData.revision}</span>}
      {result&&<span className="pill">{result.stats.scopes} scopes · {result.stats.elements} nodes · rebuilt {result.stats.indexRebuilds} index(es)</span>}
      {error&&<span className="error">{error}</span>}
    </div>
    <div className="scope-grid">
      <section className="pane tree-pane">
        <h2>Captured tree</h2>
        {snapshotData?.documents.map(doc=><DocumentTree key={doc.scopeKey} doc={doc} depth={0} selectedSid={selectedSid}/>)}
      </section>
      <section className="pane findings-pane">
        <h2>Findings</h2>
        {!result&&<p className="muted">Run analysis to resolve ARIA IDREFs within each TreeScope.</p>}
        {counts&&<div className="counts"><span className="sev ok">ok {counts.ok}</span><span className="sev missing">missing {counts.missing}</span><span className="sev ambiguous">duplicate {counts.ambiguous}</span><span className="sev unreachable">cross-scope {counts.unreachable}</span></div>}
        {result&&result.findings.map((f,i)=><FindingCard key={f.sourceSid+f.attribute+i} finding={f} index={i} onLocate={onLocate}/>)}
      </section>
      <section className="pane locate-pane">
        <h2><Crosshair size={15}/> Located target</h2>
        {!located&&<p className="muted">Pick a token in a finding to replay its stable-id path against the snapshot. The workbench DOM is never queried.</p>}
        {located&&<pre className={located.found?'locate-ok':'locate-bad'}>{JSON.stringify(located,null,2)}</pre>}
        {located&&!located.liveRevealable&&<p className="warn">Path crosses a closed shadow root: visible in the captured snapshot, not revealable in a live browser.</p>}
      </section>
    </div>
  </section>;
}

function DocumentTree({doc,depth,selectedSid}:{doc:VDocument;depth:number;selectedSid:string|null}){
  return <div className="doc-scope"><div className="scope-marker">{doc.kind==='iframe'?'iframe document':'document'} <code>{doc.scopeKey}</code>{doc.hostSid?<> host <code>{doc.hostSid}</code></>:null}</div>{doc.children.map(n=><TreeNode key={n.sid} node={n} depth={depth+1} selectedSid={selectedSid}/>)}</div>;
}

function TreeNode({node,depth,selectedSid}:{node:VNode;depth:number;selectedSid:string|null}){
  const idRef=Object.keys(node.attrs).some(a=>a.startsWith('aria-')||a==='for');
  return <div className="tree-node" style={{paddingLeft:depth*14}}>
    <span className={selectedSid===node.sid?'node-label selected':'node-label'}>{nodeLabel(node)}{idRef&&<em className="refdot" title="carries an IDREF attribute"> ◆</em>}</span>
    {node.shadow&&<div className="scope-marker shadow" style={{paddingLeft:(depth+1)*14}}>{node.shadow.mode==='closed'?'closed':'open'} shadow root <code>{node.shadow.scopeKey}</code></div>}
    {node.shadow&&node.shadow.children.map(c=><TreeNode key={c.sid} node={c} depth={depth+2} selectedSid={selectedSid}/>)}
    {node.children.map(c=><TreeNode key={c.sid} node={c} depth={depth+1} selectedSid={selectedSid}/>)}
  </div>;
}

function FindingCard({finding,index,onLocate}:{finding:import('../core/types').IdRefFinding;index:number;onLocate:(f:number,t:number)=>void}){
  return <div className={'finding '+finding.severity}>
    <div className="finding-head"><span className="sev-badge">{finding.severity}</span><code>{finding.attribute}</code><span className="muted">on {finding.sourceSid}</span></div>
    <ol className="tokens">{finding.tokens.map((t,i)=><li key={i} className={'token '+t.status}>
      <button onClick={()=>onLocate(index,i)}><Crosshair size={12}/></button>
      <code>{t.token===''?'(empty)':t.token}</code>
      <span className="token-status">{t.status}</span>
      {t.sid&&<span className="muted"> → {t.sid}</span>}
      {t.candidates&&<span className="muted"> → {t.candidates.length} duplicates: {t.candidates.join(', ')}</span>}
      {t.blockedBy&&t.blockedBy.length>0&&<span className="muted"> blocked by: {t.blockedBy.map(b=>BOUNDARY_LABEL[b.kind]+' '+b.scopeKey).join('; ')}</span>}
    </li>)}</ol>
    <details><summary>resolution path</summary><pre>{JSON.stringify(finding.sourcePath,null,1)}</pre></details>
  </div>;
}
