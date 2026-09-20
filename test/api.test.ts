import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
describe('service',()=>{it('loads and conditionally updates a record',async()=>{const app=createApp();const before=await request(app).get('/api/audits/alpha').expect(200);await request(app).put('/api/audits/alpha').send({content:'updated',revision:before.body.revision}).expect(200);await request(app).put('/api/audits/alpha').send({content:'stale',revision:before.body.revision}).expect(409)})});

describe('aria scope api',()=>{
  it('serves the demo snapshot and analyzes idrefs with stable paths',async()=>{
    const app=createApp();
    const snap=await request(app).get('/api/snapshot').expect(200);
    const analyzed=await request(app).post('/api/snapshot/analyze').send(snap.body).expect(200);
    expect(analyzed.body.revision).toBe(snap.body.revision);
    expect(Array.isArray(analyzed.body.findings)).toBe(true);
    const closed=analyzed.body.findings.find((f:any)=>f.sourceSid==='closed-ref');
    expect(closed.tokens[0].status).toBe('resolved');
    expect(closed.tokens[0].path.some((s:any)=>s.boundary==='shadow-closed')).toBe(true);
    // Scopes include document, frame and both shadow modes.
    const kinds=analyzed.body.scopes.map((s:any)=>s.kind);
    expect(kinds).toContain('frame');
    expect(kinds).toContain('shadow-open');
    expect(kinds).toContain('shadow-closed');
  });

  it('rejects a malformed snapshot',async()=>{
    const app=createApp();
    await request(app).post('/api/snapshot/analyze').send({nope:true}).expect(400);
  });
});
