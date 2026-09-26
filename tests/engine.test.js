import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('matches whole words and records an incoming event only once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'))
  const port = 20000 + Math.floor(Math.random() * 20000)
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.js'], { cwd:process.cwd(), env:{...process.env,PORT:String(port),RELAY_DATA_DIR:directory,RELAY_UPLOAD_DIR:path.join(directory,'uploads'),INGEST_TOKEN:'test-ingest',ADMIN_TOKEN:'test-admin',NODE_ENV:'test'}, stdio:'ignore' })
  const request = async (url,body,token='test-admin') => {
    const response = await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(url==='/api/events'?{'x-ingest-token':token}:{'x-admin-token':token})},body:body?JSON.stringify(body):undefined})
    return {status:response.status,body:await response.json()}
  }
  try {
    let ready = false
    for(let i=0;i<50;i++) { try { const r=await request('/api/bootstrap'); if(r.status===200){ready=true;break} } catch {} await new Promise(resolve=>setTimeout(resolve,100)) }
    assert.ok(ready,'server started')
    const rule={name:'Guide',keyword:'guide',source:'instagram',match_mode:'word',channels:['instagram'],message:'Here is your guide'}
    assert.equal((await request('/api/automations',rule)).status,201)
    assert.equal((await request('/api/automations',{...rule,name:'Another guide flow'})).status,201)
    const form=new FormData()
    form.append('file',new Blob(['sample resource'],{type:'text/plain'}),'guide.txt')
    const uploaded=await fetch(base+'/api/assets',{method:'POST',headers:{'x-admin-token':'test-admin'},body:form})
    assert.equal(uploaded.status,201)
    assert.equal((await uploaded.json()).name,'guide.txt')
    const miss=await request('/api/simulate',{source:'instagram',external_id:'miss',text:'The guidance is here'})
    assert.equal(miss.body.matches,0)
    const event={source:'instagram',external_id:'comment-123',text:'Please send the GUIDE!',recipient:{comment_id:'comment-123'}}
    const first=await request('/api/events',event,'test-ingest')
    assert.equal(first.body.matches,2)
    assert.equal(first.body.deliveries.length,1)
    assert.equal(first.body.deliveries[0].status,'failed')
    const second=await request('/api/events',event,'test-ingest')
    assert.equal(second.body.duplicate,true)
    assert.equal(second.body.deliveries.length,0)
    const state=await request('/api/bootstrap')
    assert.equal(state.body.totals.events,2)
    assert.equal(state.body.activity.length,1)
    assert.equal(state.body.assets.length,1)
  } finally {
    child.kill()
    if (child.exitCode === null) await new Promise(resolve => child.once('exit',resolve))
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  }
})
