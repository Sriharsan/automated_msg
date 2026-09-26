import 'dotenv/config'
import express from 'express'
import Database from 'better-sqlite3'
import multer from 'multer'
import nodemailer from 'nodemailer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.RELAY_DATA_DIR || path.join(root, 'data')
const uploadDir = process.env.RELAY_UPLOAD_DIR || path.join(root, 'uploads')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(uploadDir, { recursive: true })
const db = new Database(path.join(dataDir, 'relay.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(`
 CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, keyword TEXT NOT NULL, source TEXT NOT NULL, match_mode TEXT NOT NULL DEFAULT 'word', channels TEXT NOT NULL, message TEXT NOT NULL, asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, text TEXT NOT NULL, recipient TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(source, external_id));
 CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), automation_id TEXT NOT NULL REFERENCES automations(id), channel TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(event_id, automation_id, channel));
`)
db.prepare("UPDATE deliveries SET status='uncertain', detail='Server stopped while send was in progress', updated_at=? WHERE status='sending'").run(new Date().toISOString())

const app = express()
app.disable('x-powered-by')
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); next() })
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf) } }))
const now = () => new Date().toISOString()
const id = () => crypto.randomUUID()
const all = (sql, ...args) => db.prepare(sql).all(...args)
const get = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)
const publicBase = () => (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, '')
const secret = () => process.env.DOWNLOAD_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'local-development-only')

function secureEqual(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
function admin(req, res, next) {
  if (!process.env.ADMIN_TOKEN && process.env.NODE_ENV !== 'production') return next()
  if (secureEqual(req.get('x-admin-token'), process.env.ADMIN_TOKEN)) return next()
  res.status(401).json({ error: 'Admin token required' })
}
function normalize(text) { return String(text || '').normalize('NFKC').toLocaleLowerCase().trim() }
function matches(text, keyword, mode) {
  const haystack = normalize(text)
  const needle = normalize(keyword)
  if (!needle) return false
  if (mode === 'contains') return haystack.includes(needle)
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(haystack)
}
function signedUrl(assetId, eventId) {
  const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
  const payload = `${assetId}.${eventId}.${expiry}`
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex')
  return `${publicBase()}/api/assets/${encodeURIComponent(assetId)}/download?event=${encodeURIComponent(eventId)}&expires=${expiry}&sig=${sig}`
}
function cleanAutomation(row) { return { ...row, channels: JSON.parse(row.channels) } }
function bootstrap() {
  const automations = all('SELECT * FROM automations ORDER BY created_at DESC').map(cleanAutomation)
  const assets = all('SELECT id,name,mime,size,created_at FROM assets ORDER BY created_at DESC')
  const activity = all(`SELECT d.*, a.name AS automation_name, e.text AS trigger_text, e.source, e.recipient FROM deliveries d JOIN automations a ON a.id=d.automation_id JOIN events e ON e.id=d.event_id ORDER BY d.created_at DESC LIMIT 60`).map(x => ({ ...x, recipient: JSON.parse(x.recipient) }))
  const totals = get(`SELECT COUNT(*) AS events, (SELECT COUNT(*) FROM deliveries WHERE status='sent' OR status='simulated') AS sent, (SELECT COUNT(*) FROM deliveries WHERE status='uncertain') AS uncertain FROM events`)
  return { automations, assets, activity, totals, channels: {
    instagram: Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID && process.env.META_APP_SECRET && process.env.META_VERIFY_TOKEN),
    whatsapp: Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.META_APP_SECRET && process.env.META_VERIFY_TOKEN),
    email: Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM), linkedin: false
  } }
}
app.get('/api/bootstrap', admin, (_req, res) => res.json(bootstrap()))

function validateAutomation(body) {
  const name = String(body.name || '').trim().slice(0, 100)
  const keyword = String(body.keyword || '').trim().slice(0, 100)
  const message = String(body.message || '').trim().slice(0, 1200)
  const source = body.source
  const match_mode = body.match_mode === 'contains' ? 'contains' : 'word'
  const channels = [...new Set(Array.isArray(body.channels) ? body.channels : [])].filter(x => ['instagram','whatsapp','email'].includes(x))
  const asset_id = body.asset_id || null
  if (!name || !keyword || !message || !['instagram','whatsapp','custom'].includes(source) || !channels.length) throw new Error('Name, keyword, source, message and at least one supported destination are required')
  if (asset_id && !get('SELECT id FROM assets WHERE id=?', asset_id)) throw new Error('Selected file does not exist')
  return { name, keyword, message, source, match_mode, channels, asset_id, status: body.status === 'paused' ? 'paused' : 'active' }
}
app.post('/api/automations', admin, (req, res) => {
  try { const a = validateAutomation(req.body); const key = id(); const time = now(); run('INSERT INTO automations VALUES (?,?,?,?,?,?,?,?,?,?,?)', key,a.name,a.keyword,a.source,a.match_mode,JSON.stringify(a.channels),a.message,a.asset_id,a.status,time,time); res.status(201).json(cleanAutomation(get('SELECT * FROM automations WHERE id=?',key))) }
  catch (error) { res.status(400).json({ error: error.message }) }
})
app.patch('/api/automations/:id', admin, (req, res) => {
  const existing = get('SELECT * FROM automations WHERE id=?', req.params.id)
  if (!existing) return res.status(404).json({ error: 'Automation not found' })
  try { const a = validateAutomation({ ...cleanAutomation(existing), ...req.body }); run('UPDATE automations SET name=?,keyword=?,source=?,match_mode=?,channels=?,message=?,asset_id=?,status=?,updated_at=? WHERE id=?', a.name,a.keyword,a.source,a.match_mode,JSON.stringify(a.channels),a.message,a.asset_id,a.status,now(),req.params.id); res.json(cleanAutomation(get('SELECT * FROM automations WHERE id=?',req.params.id))) }
  catch (error) { res.status(400).json({ error: error.message }) }
})
app.delete('/api/automations/:id', admin, (req, res) => {
  const count = get('SELECT COUNT(*) AS n FROM deliveries WHERE automation_id=?', req.params.id).n
  if (count) return res.status(409).json({ error: 'This automation has delivery history. Pause it instead.' })
  run('DELETE FROM automations WHERE id=?',req.params.id); res.status(204).end()
})

const storage = multer.diskStorage({ destination: uploadDir, filename: (_req, _file, cb) => cb(null, id()) })
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: (_req, file, cb) => {
  const allowed = ['application/pdf','image/png','image/jpeg','application/zip','text/plain','video/mp4']
  cb(null, allowed.includes(file.mimetype))
} })
app.post('/api/assets', admin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PDF, image, ZIP, text file, or MP4 under 20 MB' })
  const asset = { id: id(), name: path.basename(req.file.originalname).slice(0,200), stored_name: req.file.filename, mime: req.file.mimetype, size: req.file.size, created_at: now() }
  run('INSERT INTO assets VALUES (?,?,?,?,?,?)',asset.id,asset.name,asset.stored_name,asset.mime,asset.size,asset.created_at)
  res.status(201).json(asset)
})
app.get('/api/assets/:id/download', (req, res) => {
  const asset = get('SELECT * FROM assets WHERE id=?', req.params.id)
  const expiry = Number(req.query.expires)
  const event = String(req.query.event || '')
  const expected = crypto.createHmac('sha256', secret()).update(`${req.params.id}.${event}.${expiry}`).digest('hex')
  if (!asset || !Number.isSafeInteger(expiry) || expiry < Date.now()/1000 || !secureEqual(req.query.sig, expected)) return res.status(403).end()
  res.type(asset.mime).download(path.join(uploadDir, asset.stored_name), asset.name)
})

async function send(channel, event, automation, link) {
  const recipient = JSON.parse(event.recipient)
  const body = `${automation.message}${link ? `\n\n${link}` : ''}`
  if (channel === 'email') {
    if (!recipient.email) throw Object.assign(new Error('No email address for this contact'),{definite:true})
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw Object.assign(new Error('Email is not connected'),{definite:true})
    const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined })
    const result = await transport.sendMail({ from: process.env.SMTP_FROM, to: recipient.email, subject: automation.name, text: body })
    return result.messageId
  }
  if (channel === 'whatsapp') {
    if (!recipient.phone) throw Object.assign(new Error('No opted-in WhatsApp number for this contact'),{definite:true})
    if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) throw Object.assign(new Error('WhatsApp is not connected'),{definite:true})
    if (event.source !== 'whatsapp') throw Object.assign(new Error('WhatsApp freeform replies require an inbound WhatsApp message'),{definite:true})
    const response = await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v25.0'}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type':'application/json' }, body: JSON.stringify({ messaging_product:'whatsapp', recipient_type:'individual', to:recipient.phone, type:'text', text:{ preview_url:Boolean(link), body } }), signal: AbortSignal.timeout(15000) })
    const data = await response.json()
    if (!response.ok) throw Object.assign(new Error(data.error?.message || `WhatsApp error ${response.status}`),{definite:true})
    return data.messages?.[0]?.id || 'accepted'
  }
  if (channel === 'instagram') {
    if (event.source !== 'instagram' || !recipient.comment_id) throw Object.assign(new Error('Instagram private replies require an Instagram comment'),{definite:true})
    if (!process.env.INSTAGRAM_ACCESS_TOKEN || !process.env.INSTAGRAM_ACCOUNT_ID) throw Object.assign(new Error('Instagram is not connected'),{definite:true})
    const response = await fetch(`https://graph.instagram.com/${process.env.META_GRAPH_VERSION || 'v25.0'}/${process.env.INSTAGRAM_ACCOUNT_ID}/messages`, { method:'POST', headers:{ Authorization:`Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN}`, 'Content-Type':'application/json' }, body:JSON.stringify({ recipient:{ comment_id:recipient.comment_id }, message:{ text:body } }), signal:AbortSignal.timeout(15000) })
    const data = await response.json()
    if (!response.ok) throw Object.assign(new Error(data.error?.message || `Instagram error ${response.status}`),{definite:true})
    return data.message_id || 'accepted'
  }
  throw new Error('Unsupported channel')
}

async function processEvent(input, simulate = false) {
  const source = String(input.source || '')
  const externalId = String(input.external_id || '').trim()
  const text = String(input.text || '').slice(0, 4000)
  const recipient = input.recipient && typeof input.recipient === 'object' ? input.recipient : {}
  if (!['instagram','whatsapp','custom'].includes(source) || !externalId || !text) throw new Error('source, external_id, and text are required')
  const eventId = id()
  const insert = run('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?)',eventId,source,externalId,text,JSON.stringify(recipient),now())
  if (!insert.changes) return { duplicate: true, matches: 0, deliveries: [] }
  const event = get('SELECT * FROM events WHERE id=?',eventId)
  const automations = all("SELECT * FROM automations WHERE source=? AND status='active' ORDER BY created_at",source).map(cleanAutomation).filter(a => matches(text,a.keyword,a.match_mode))
  const deliveries = []
  const usedChannels = new Set()
  for (const automation of automations) for (const channel of automation.channels) {
    if (usedChannels.has(channel)) continue
    usedChannels.add(channel)
    const deliveryId = id(); const time = now()
    const claim = run('INSERT OR IGNORE INTO deliveries VALUES (?,?,?,?,?,?,?,?,?)',deliveryId,eventId,automation.id,channel,'sending',null,null,time,time)
    if (!claim.changes) continue
    if (simulate) { run("UPDATE deliveries SET status='simulated',detail='Preview only — no message was sent',updated_at=? WHERE id=?",now(),deliveryId); deliveries.push({ channel,status:'simulated' }); continue }
    try { const link = automation.asset_id ? signedUrl(automation.asset_id,eventId) : null; const providerId = await send(channel,event,automation,link); run("UPDATE deliveries SET status='sent',provider_id=?,updated_at=? WHERE id=?",providerId,now(),deliveryId); deliveries.push({ channel,status:'sent' }) }
    catch (error) {
      // A timeout or connection loss after request submission can hide a successful send.
      // Leave it uncertain, and never retry automatically.
      const status = error.definite ? 'failed' : 'uncertain'
      run('UPDATE deliveries SET status=?,detail=?,updated_at=? WHERE id=?',status,String(error.message).slice(0,500),now(),deliveryId)
      deliveries.push({ channel,status,error:error.message })
    }
  }
  return { duplicate:false, matches:automations.length, deliveries }
}
app.post('/api/simulate', admin, async (req,res) => {
  try { const result = await processEvent({ ...req.body, external_id:req.body.external_id || id() },true); res.json(result) }
  catch(error) { res.status(400).json({ error:error.message }) }
})
app.post('/api/events', (req,res,next) => {
  if (!process.env.INGEST_TOKEN || !secureEqual(req.get('x-ingest-token'),process.env.INGEST_TOKEN)) return res.status(401).json({ error:'Ingest token required' })
  next()
}, async (req,res) => { try { res.json(await processEvent(req.body)) } catch(error) { res.status(400).json({ error:error.message }) } })

app.get('/webhooks/meta', (req,res) => {
  if (req.query['hub.mode']==='subscribe' && process.env.META_VERIFY_TOKEN && secureEqual(req.query['hub.verify_token'],process.env.META_VERIFY_TOKEN)) return res.status(200).send(req.query['hub.challenge'])
  res.status(403).end()
})
app.post('/webhooks/meta', async (req,res) => {
  if (!process.env.META_APP_SECRET) return res.status(503).end()
  const signature = String(req.get('x-hub-signature-256') || '')
  const expected = 'sha256=' + crypto.createHmac('sha256',process.env.META_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex')
  if (!secureEqual(signature,expected)) return res.status(403).end()
  res.status(200).send('EVENT_RECEIVED')
  const jobs = []
  if (req.body.object === 'instagram') for (const entry of req.body.entry || []) for (const change of entry.changes || []) {
    if (!['comments','live_comments'].includes(change.field)) continue
    const v = change.value || {}
    if (v.id && v.text) jobs.push({ source:'instagram', external_id:String(v.id), text:v.text, recipient:{ comment_id:String(v.id), instagram_user_id:v.from?.id } })
  }
  if (req.body.object === 'whatsapp_business_account') for (const entry of req.body.entry || []) for (const change of entry.changes || []) for (const m of change.value?.messages || []) {
    if (m.type==='text' && m.id && m.text?.body) jobs.push({ source:'whatsapp', external_id:String(m.id), text:m.text.body, recipient:{ phone:m.from, whatsapp_opt_in:true } })
  }
  for (const job of jobs) { try { await processEvent(job) } catch(error) { console.error('Webhook processing failed:',error) } }
})

app.use('/api', (_req,res) => res.status(404).json({ error:'Not found' }))
const dist = path.join(root,'dist')
if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('/{*path}', (_req,res) => res.sendFile(path.join(dist,'index.html'))) }
app.use((error,_req,res,_next) => { console.error(error); res.status(error instanceof multer.MulterError ? 400 : 500).json({ error:error.code==='LIMIT_FILE_SIZE' ? 'File must be under 20 MB' : 'Request failed' }) })
if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_TOKEN || !process.env.DOWNLOAD_SECRET || !process.env.PUBLIC_BASE_URL)) throw new Error('ADMIN_TOKEN, DOWNLOAD_SECRET and PUBLIC_BASE_URL are required in production')
app.listen(Number(process.env.PORT || 8787), process.env.ADMIN_TOKEN ? '0.0.0.0' : '127.0.0.1', () => console.log(`Relay API ready on :${process.env.PORT || 8787}`))

export { matches }
