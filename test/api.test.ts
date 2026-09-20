import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';

describe('service',()=>{it('loads and conditionally updates a record',async()=>{const app=createApp();const before=await request(app).get('/api/audits/alpha').expect(200);await request(app).put('/api/audits/alpha').send({content:'updated',revision:before.body.revision}).expect(200);await request(app).put('/api/audits/alpha').send({content:'stale',revision:before.body.revision}).expect(409)})});

describe('snapshot idref api',()=>{
  it('returns scoped analysis with stable nids and boundary-aware paths',async()=>{
    const app=createApp();
    const page = await request(app).get('/api/pages/page-demo').expect(200);
    expect(page.body.revision).toBe(1);

    const analyzed = await request(app).post('/api/pages/page-demo/analyze').send({revision:1}).expect(200);
    const {result,cache} = analyzed.body;
    expect(result.summary.scopes).toBe(4);
    // First analysis builds every scope index.
    expect(cache.rebuilt.length).toBe(4);

    const multi = result.findings.find((f:any)=>f.sourceNid==='multi-btn');
    expect(multi.tokens.map((t:any)=>[t.token,t.status])).toEqual([
      ['title','ok'],['dup-title','ambiguous'],['gone-token','missing'],
    ]);
    const dup = multi.tokens.find((t:any)=>t.token==='dup-title');
    expect(dup.targets.map((t:any)=>t.nid)).toEqual(['dup-a','dup-b']);
    expect(dup.targets[0].effective).toBe(true);
    // Result carries stable ids and full resolution paths.
    expect(dup.targets[0].path[0]).toBe('html');
    expect(dup.targets[0].path).toContain('section#dup-title.card');

    const closed = result.findings.find((f:any)=>f.sourceNid==='closed-btn');
    expect(closed.scopeBoundary).toContainEqual({kind:'shadow',host:'closed-host',mode:'closed'});
    expect(closed.tokens[0].targets[0].nid).toBe('closed-heading');
  });

  it('reports cross-boundary same-id nodes as blocked, not resolved',async()=>{
    const app=createApp();
    const {body} = await request(app).post('/api/pages/page-demo/analyze').send({revision:1}).expect(200);
    const inner = body.result.findings.find((f:any)=>f.sourceNid==='open-shadow-btn');
    expect(inner.tokens[0].status).toBe('missing');
    expect(inner.tokens[0].unreachable[0]).toMatchObject({
      nid:'page-title', blockedBy:{kind:'shadow',host:'open-host',mode:'open'},
    });
  });

  it('rejects stale revisions and mutates with precise cache invalidation',async()=>{
    const app=createApp();
    // Warm the persistent scope-index cache before mutating.
    const warm = await request(app).post('/api/pages/page-demo/analyze').send({revision:1}).expect(200);
    expect(warm.body.cache.rebuilt.length).toBe(4);

    // Stale analyze revision.
    await request(app).post('/api/pages/page-demo/analyze').send({revision:999}).expect(409);

    // Unrelated attribute edit: zero index rebuilds.
    let r = await request(app).post('/api/pages/page-demo/mutate')
      .send({revision:1,op:{type:'set-attr',nid:'page-title',name:'class',value:'x'}}).expect(200);
    expect(r.body.revision).toBe(2);
    expect(r.body.cache.rebuilt).toEqual([]);
    expect(r.body.cache.reused.length).toBe(4);

    // Id edit inside closed shadow: exactly one scope rebuilt.
    r = await request(app).post('/api/pages/page-demo/mutate')
      .send({revision:2,op:{type:'set-attr',nid:'closed-heading',name:'id',value:'h2'}}).expect(200);
    expect(r.body.revision).toBe(3);
    expect(r.body.cache.rebuilt).toHaveLength(1);
    expect(r.body.result.summary.scopes).toBe(4);

    // Stale mutation rejected, store untouched.
    await request(app).post('/api/pages/page-demo/mutate')
      .send({revision:2,op:{type:'remove',nid:'frame'}}).expect(409);

    // Removing the iframe drops its scoped indexes from the cache.
    r = await request(app).post('/api/pages/page-demo/mutate')
      .send({revision:3,op:{type:'remove',nid:'frame'}}).expect(200);
    expect(r.body.result.summary.scopes).toBe(3);
    expect(r.body.result.summary.frameScopes).toBe(0);
  });

  it('resolves a cross-boundary move and keeps nids stable',async()=>{
    const app=createApp();
    await request(app).post('/api/pages/page-demo/analyze').send({revision:1}).expect(200);
    // Move light-DOM title into the host's light children (still top scope).
    let r = await request(app).post('/api/pages/page-demo/mutate')
      .send({revision:1,op:{type:'move',nid:'page-title',parent:'open-host'}}).expect(200);
    expect(r.body.cache.rebuilt).toHaveLength(1);
    expect(r.body.snapshot.root).toBeTruthy();
    const shadowNid = r.body.snapshot.root.children[0].children
      .find((n:any)=>n.nid==='open-host').shadow.nid;

    // Move again, into the shadow root: both scopes invalidate.
    r = await request(app).post('/api/pages/page-demo/mutate')
      .send({revision:r.body.revision,op:{type:'move',nid:'page-title',parent:shadowNid}}).expect(200);
    expect(new Set(r.body.cache.rebuilt).size).toBe(2);
    // Stable id survived.
    const titles = collectNids(r.body.snapshot.root);
    expect(titles).toContain('page-title');
    // Shadow button now resolves; top document button no longer does.
    const ok = r.body.result.findings.find((f:any)=>f.sourceNid==='open-shadow-btn');
    expect(ok.tokens[0].status).toBe('ok');
    const multi = r.body.result.findings.find((f:any)=>f.sourceNid==='multi-btn');
    expect(multi.tokens.find((t:any)=>t.token==='title').status).toBe('missing');
  });
});

function collectNids(node:any):string[]{
  const out=[node.nid];
  for(const child of node.children??[])out.push(...collectNids(child));
  if(node.shadow)out.push(...collectNids(node.shadow));
  if(node.contentDocument)out.push(...collectNids(node.contentDocument));
  return out;
}
