import express from 'express';
import {fileURLToPath} from 'node:url';
import type {MutationOp, Snapshot, SnapshotNode} from '../core/types';
import {ScopeAnalyzer, type AnalysisResult, type CacheStats} from '../core/resolver';
import {applyMutation} from '../core/builder';
import {demoPage} from '../core/fixtures';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary review findings',revision:3,content:'review findings: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary review findings',revision:5,content:'review findings: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

interface SnapshotRecord {
  id: string;
  name: string;
  snapshot: Snapshot;
  /** Persistent analyzer: scope indexes survive between requests/revisions. */
  analyzer: ScopeAnalyzer;
  lastAnalysis: AnalysisResult | null;
  lastStats: CacheStats | null;
}

// --- Legacy text-audit records (unchanged) ---

export function createApp(){
  const app=express();
  app.use(express.json({limit:'2mb'}));
  // Fresh in-memory store per app instance (tests create isolated apps).
  const pages: SnapshotRecord[] = [
    {id: 'page-demo', name: 'Scoped IDREF demo page', snapshot: demoPage(), analyzer: new ScopeAnalyzer(), lastAnalysis: null, lastStats: null},
  ];

  app.get('/api/bootstrap',(_req,res)=>res.json({family:"accessibility-review",count:rows.length}));

  // --- Legacy text-audit records (unchanged) ---
  app.get('/api/audits',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/audits/:id',(req,res)=>{
    if(req.params.id.startsWith('page-')) {
      const page = pages.find(p=>p.id===req.params.id);
      if(!page)return res.status(404).json({error:'not_found'});
      return res.json({id:page.id,name:page.name,revision:page.snapshot.revision});
    }
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    res.set('ETag',String(row.revision)).json(row);
  });
  app.put('/api/audits/:id',(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});
    row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();
    res.json(row);
  });
  app.post('/api/audits/:id/analyze',async(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));
    res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]});
  });

  // --- Snapshot pages: server is the sole IDREF authority ---
  app.get('/api/pages',(_req,res)=>{
    res.json(pages.map(p=>({id:p.id,name:p.name,revision:p.snapshot.revision})));
  });
  app.get('/api/pages/:id',(req,res)=>{
    const page = pages.find(p=>p.id===req.params.id);
    if(!page)return res.status(404).json({error:'not_found'});
    res.json({id:page.id,name:page.name,revision:page.snapshot.revision,snapshot:page.snapshot});
  });
  app.post('/api/pages/:id/analyze',(req,res)=>{
    const page = pages.find(p=>p.id===req.params.id);
    if(!page)return res.status(404).json({error:'not_found'});
    const expected = Number(req.body.revision);
    if(Number.isFinite(expected) && expected !== page.snapshot.revision) {
      return res.status(409).json({error:'revision_conflict',current:page.snapshot.revision});
    }
    const result = page.analyzer.analyze(page.snapshot);
    page.lastAnalysis = result;
    page.lastStats = {...page.analyzer.stats};
    res.json({id:page.id,revision:page.snapshot.revision,result,cache:page.lastStats});
  });
  app.post('/api/pages/:id/mutate',(req,res)=>{
    const page = pages.find(p=>p.id===req.params.id);
    if(!page)return res.status(404).json({error:'not_found'});
    const expected = Number(req.body.revision);
    if(Number.isFinite(expected) && expected !== page.snapshot.revision) {
      return res.status(409).json({error:'revision_conflict',current:page.snapshot.revision});
    }
    let op: MutationOp;
    try {
      op = parseMutation(req.body.op);
    } catch (error) {
      return res.status(400).json({error:'invalid_mutation',message:(error as Error).message});
    }
    try {
      page.snapshot = applyPageMutation(page.snapshot, op);
    } catch (error) {
      return res.status(400).json({error:'mutation_failed',message:(error as Error).message});
    }
    const result = page.analyzer.analyze(page.snapshot);
    page.lastAnalysis = result;
    page.lastStats = {...page.analyzer.stats};
    res.json({id:page.id,revision:page.snapshot.revision,snapshot:page.snapshot,result,cache:page.lastStats});
  });

  return app;
}

// applyMutation always bumps snapshot revision; the server only forwards ops.
function applyPageMutation(snapshot: Snapshot, op: MutationOp): Snapshot {
  return applyMutation(snapshot, op);
}

function parseMutation(op: unknown): MutationOp {
  if (typeof op !== 'object' || op === null) throw new Error('op is required');
  const body = op as Record<string, unknown>;
  const type = body.type;
  switch (type) {
    case 'set-attr':
      if(typeof body.nid!=='string'||typeof body.name!=='string')throw new Error('nid and name are required');
      if(body.value!==null&&typeof body.value!=='string')throw new Error('value must be a string or null');
      return {type, nid:body.nid, name:body.name, value:body.value};
    case 'move':
      if(typeof body.nid!=='string'||typeof body.parent!=='string')throw new Error('nid and parent are required');
      return {type, nid:body.nid, parent:body.parent, index: typeof body.index==='number'?body.index:undefined};
    case 'insert':
      if(typeof body.parent!=='string'||(typeof body.node!=='object'||body.node===null))throw new Error('parent and node are required');
      return {type, parent:body.parent, node:body.node as SnapshotNode, index: typeof body.index==='number'?body.index:undefined};
    case 'remove':
      if(typeof body.nid!=='string')throw new Error('nid is required');
      return {type, nid:body.nid};
    default:
      throw new Error(`unknown mutation type: ${String(type)}`);
  }
}

if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
