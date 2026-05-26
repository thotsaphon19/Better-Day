// ╔═══════════════════════════════════════════════════════════════╗
// ║  Better Day v4.0 — AI Slip Analyzer Edition                 ║
// ║  LINE Bot + AI สลิปอัตโนมัติ + Dashboard real-time           ║
// ╚═══════════════════════════════════════════════════════════════╝
require('dotenv').config();
const express    = require('express');
const crypto     = require('crypto');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const path       = require('path');
const { MongoClient } = require('mongodb');

const app = express();

// ─── ENV ──────────────────────────────────────────────────────
let   SECRET        = process.env.LINE_CHANNEL_SECRET       || '';
let   TOKEN         = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const ADMIN_PW      = process.env.ADMIN_PASSWORD            || 'admin1234';
const PORT          = process.env.PORT                      || 3000;
let   ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY         || '';
let   MONGO_URI     = process.env.MONGODB_URI               || '';

// ─── DB (MongoDB) ─────────────────────────────────────────────
const DEFAULT_DB = {
  players: {},
  bets: [],
  rounds: [],
  deposits: [],
  logs: [],
  slips: [],
  currentRound: 155,
  isOpen: false,
  defaultGroupId: '',
  settings: {
    startBalance: 0,
    botName: 'Better Day',
    autoReply: true,
    autoTopupSlip: true,
    slipMinAmount: 1,
  }
};

let _mongoClient = null;
let _db          = null;
let _mongoOk     = false;

async function loadCredentialsFromDB() {
  try {
    const col = await getMongoCol(); if (!col) return;
    const doc = await col.findOne({ _id:'main' });
    const cr = doc?.settings?.credentials || {};
    if (cr.lineSecret)   SECRET        = cr.lineSecret;
    if (cr.lineToken)    TOKEN         = cr.lineToken;
    if (cr.anthropicKey) ANTHROPIC_KEY = cr.anthropicKey;
    console.log('🔑 credentials loaded: secret=%s token=%s ai=%s', !!SECRET, !!TOKEN, !!ANTHROPIC_KEY);
  } catch(e) { console.warn('loadCreds:', e.message); }
}

async function getMongoCol() {
  if (!MONGO_URI) return null;
  if (_mongoClient && !_mongoOk) { try { await _mongoClient.close(); } catch {} _mongoClient=null; _db=null; }
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS:8000, connectTimeoutMS:8000 });
    await _mongoClient.connect();
    _db = _mongoClient.db('himangkorn');
    _mongoOk = true;
    _mongoClient.on('close', () => { _mongoOk=false; console.warn('⚠️ MongoDB disconnected'); });
    _mongoClient.on('error', () => { _mongoOk=false; });
    console.log('✅ MongoDB connected:', _db.databaseName);
  }
  return _db.collection('gamedata');
}

async function readDB() {
  try {
    const col = await getMongoCol();
    if (col) {
      const doc = await col.findOne({ _id:'main' });
      if (!doc) {
        const fresh = { ...DEFAULT_DB };
        await col.replaceOne({ _id:'main' }, { _id:'main', ...fresh }, { upsert:true });
        return fresh;
      }
      const { _id, ...data } = doc;
      return { ...DEFAULT_DB, ...data, settings:{ ...DEFAULT_DB.settings, ...(data.settings||{}) } };
    }
  } catch(e) { _mongoOk=false; console.error('❌ MongoDB readDB:', e.message); }
  const DB_PATH = path.join(__dirname, 'db.json');
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  try { const raw = JSON.parse(fs.readFileSync(DB_PATH,'utf8')); return { ...DEFAULT_DB, ...raw, settings:{ ...DEFAULT_DB.settings, ...(raw.settings||{}) } }; }
  catch { return { ...DEFAULT_DB }; }
}

async function saveDB(db) {
  try {
    const col = await getMongoCol();
    if (col) { await col.replaceOne({ _id:'main' }, { _id:'main', ...db }, { upsert:true }); return; }
  } catch(e) { _mongoOk=false; console.error('❌ MongoDB saveDB:', e.message); }
  const DB_PATH = path.join(__dirname, 'db.json');
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch(e) { console.error('saveDB file:', e.message); }
}

function addLog(db, type, msg, uid = '') {
  db.logs.unshift({ ts: new Date().toISOString(), type, msg, uid });
  if (db.logs.length > 1000) db.logs.length = 1000;
}

// ─── อัตราจ่าย ────────────────────────────────────────────────
const PAYOUT = { 4:50,5:18,6:14,7:12,8:8,9:6,10:6,11:6,12:6,13:8,14:12,15:14,16:18,17:50 };

function calcBet(type, amt, d1, d2, d3) {
  const sum    = d1 + d2 + d3;
  const sorted = [d1, d2, d3].sort((a, b) => a - b);
  const triple = d1 === d2 && d2 === d3;
  const t      = type.toString().trim();

  if (/^(สูง|high)$/i.test(t))  return triple ? -amt : sum >= 11 ? +amt : -amt;
  if (/^(ต่ำ|low)$/i.test(t))   return triple ? -amt : sum <= 10 ? +amt : -amt;
  if (/^(คู่|even)$/i.test(t))  return sum % 2 === 0 ? +amt : -amt;
  if (/^(คี่|odd)$/i.test(t))   return sum % 2 !== 0 ? +amt : -amt;
  if (/^\d+ส$/.test(t)) { const n = parseInt(t); return [d1,d2,d3].includes(n) && n >= 4 ? amt*2 : -amt; }
  if (/^\d+ต$/.test(t)) { const n = parseInt(t); return [d1,d2,d3].includes(n) && n <= 3 ? amt*2 : -amt; }
  if (/^\d{3}$/.test(t) && new Set(t).size === 1) { const n=+t[0]; return triple&&n===d1 ? amt*10 : -amt; }
  if (/^\d{3}$/.test(t)) { const ts=t.split('').map(Number).sort((a,b)=>a-b).join(''); return ts===sorted.join('') ? amt*7 : -amt; }
  if (/^\d{2}$/.test(t)) {
    const ns = t.split('').map(Number).sort((a,b)=>a-b);
    const ok = ns[0]!==ns[1] ? [d1,d2,d3].includes(ns[0])&&[d1,d2,d3].includes(ns[1])
                              : [d1,d2,d3].filter(x=>x===ns[0]).length>=2;
    return ok ? amt*5 : -amt;
  }
  const n = parseInt(t);
  if (!isNaN(n) && n>=4 && n<=17) return sum===n ? amt*(PAYOUT[n]||6) : -amt;
  return 0;
}

function parseBets(text) {
  const regular = [], extra = [];
  let m;
  const extraRe = /เพิ่ม\s+([ก-๙a-zA-Z0-9]+[สต]?)\s*[=\/]\s*(\d+)/gi;
  while ((m = extraRe.exec(text)) !== null) {
    const amt = parseInt(m[2]); if (amt > 0) extra.push({ type: m[1].trim(), amt });
  }
  const re = /([ก-๙a-zA-Z0-9]+[สต]?|สูง|ต่ำ|คู่|คี่)\s*[=\/]\s*(\d+)/gi;
  while ((m = re.exec(text)) !== null) {
    const amt = parseInt(m[2]); if (amt > 0) regular.push({ type: m[1].trim(), amt });
  }
  return { regular, extra };
}

function settleRound(db, round, d1, d2, d3) {
  const results = [];
  const pending = db.bets.filter(b => b.round === round && b.status === 'pending');
  for (const bet of pending) {
    let net = 0;
    for (const b of bet.items) {
      b.net = calcBet(b.type, b.amt, d1, d2, d3);
      b.result = b.net >= 0 ? 'ชนะ' : 'แพ้';
      net += b.net;
    }
    bet.net = net; bet.status = 'settled';
    const p = db.players[bet.uid];
    if (p) {
      p.balance += net;
      if (net > 0) p.totalWin += net; else p.totalLoss += Math.abs(net);
    }
    results.push({ uid:bet.uid, name:bet.name, memberId:bet.memberId, net, balance:db.players[bet.uid]?.balance||0 });
  }
  return results;
}

// ─── LINE API ─────────────────────────────────────────────────
function linePost(urlPath, body) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname: 'api.line.me', path: urlPath, method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${TOKEN}`, 'Content-Length':Buffer.byteLength(data) }
    }, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ try{res(JSON.parse(b));}catch{res(b);} }); });
    req.on('error', rej); req.write(data); req.end();
  });
}
const replyMsg = (tk, msgs) => TOKEN&&tk  ? linePost('/v2/bot/message/reply', { replyToken:tk, messages:msgs }) : null;
const pushMsg  = (to, msgs) => TOKEN&&to  ? linePost('/v2/bot/message/push',  { to, messages:msgs }) : null;
const txtMsg   = t => ({ type:'text', text:t });

async function getProfile(uid, groupId) {
  if (!TOKEN) return null;
  const urlPath = groupId ? `/v2/bot/group/${groupId}/member/${uid}` : `/v2/bot/profile/${uid}`;
  return new Promise(res => {
    const req = https.request({ hostname:'api.line.me', path:urlPath, method:'GET', headers:{'Authorization':`Bearer ${TOKEN}`} },
      r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ try{res(JSON.parse(b));}catch{res(null);} }); });
    req.on('error',()=>res(null)); req.end();
  });
}

// ─── ดาวน์โหลดรูปสลิปจาก LINE ────────────────────────────────
function downloadLineImage(messageId) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) return reject(new Error('No LINE token'));
    const options = {
      hostname: 'api-data.line.me',
      path: `/v2/bot/message/${messageId}/content`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TOKEN}` }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const contentType = res.headers['content-type'] || 'image/jpeg';
        resolve({ base64, contentType });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── AI วิเคราะห์สลิป ด้วย Claude Vision ─────────────────────
async function analyzeSlipWithAI(base64Image, contentType, playerNames) {
  if (!ANTHROPIC_KEY) {
    return { ok: false, error: 'ไม่ได้ตั้งค่า ANTHROPIC_API_KEY' };
  }

  const nameList = playerNames.length > 0
    ? `\nรายชื่อผู้เล่นในระบบ: ${playerNames.join(', ')}`
    : '';

  const prompt = `คุณเป็นผู้เชี่ยวชาญอ่านสลิปโอนเงินธนาคารไทย วิเคราะห์สลิปในภาพนี้และตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น

${nameList}

ให้ตอบ JSON รูปแบบนี้เท่านั้น:
{
  "isSlip": true/false,
  "amount": ตัวเลขยอดโอน (ไม่มีหน่วย),
  "senderName": "ชื่อผู้โอน",
  "receiverName": "ชื่อผู้รับ",
  "bankFrom": "ธนาคารต้นทาง",
  "bankTo": "ธนาคารปลายทาง",
  "datetime": "วันเวลาในสลิป",
  "refNo": "เลขอ้างอิง/รหัสธุรกรรม",
  "matchedPlayer": "ชื่อผู้เล่นในระบบที่ตรงกัน หรือ null",
  "confidence": "high/medium/low",
  "note": "หมายเหตุ ถ้ามี"
}

ถ้าไม่ใช่สลิปให้ isSlip: false และ amount: 0`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: contentType, data: base64Image }
          },
          { type: 'text', text: prompt }
        ]
      }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          // ลบ markdown code block ถ้ามี
          const clean = text.replace(/```json\n?|\n?```/g, '').trim();
          const result = JSON.parse(clean);
          resolve({ ok: true, ...result });
        } catch (e) {
          resolve({ ok: false, error: 'AI parse error: ' + e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

// ─── จับคู่ชื่อผู้เล่น (fuzzy match) ─────────────────────────
function findPlayerByName(db, searchName) {
  if (!searchName) return null;
  const q = searchName.toLowerCase().trim();
  const players = Object.values(db.players);

  // ตรงเป๊ะ
  let found = players.find(p => p.name.toLowerCase() === q);
  if (found) return found;

  // ชื่อมีใน searchName หรือ searchName มีในชื่อ
  found = players.find(p =>
    p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase())
  );
  if (found) return found;

  // ตัดนามสกุล / ชื่อเล่น (คำแรก)
  const firstWord = q.split(/\s+/)[0];
  found = players.find(p => p.name.toLowerCase().startsWith(firstWord));
  return found || null;
}

// ─── ข้อความรูปแบบตามภาพ ─────────────────────────────────────
const betReply   = (name,bets,bal)  => `${name} แทง ✅ ${bets.map(b=>`${b.type} = ${b.amt}`).join(' ')}\nเงินคงเหลือ = ${bal.toLocaleString()} 💰💰`;
const extraReply = (name,bets,bal)  => `${name} เพิ่ม ✅ ${bets.map(b=>`${b.type} = ${b.amt}`).join(' ')}\nเงินคงเหลือ = ${bal.toLocaleString()} 💰💰`;
const winReply   = (name,id,bets,bal) => `${name} แทง ✅ ${bets.map(b=>`${b.type} = ${b.amt}`).join(' ')}\nเงินคงเหลือ = ${bal.toLocaleString()} 💰💰`;
const loseReply  = (name,id,bal)    => `${name} ID : ${id}\nเงินคงเหลือ = ${bal.toLocaleString()} 💸`;

// ─── ออกผลพร้อมส่งกลับกลุ่ม ──────────────────────────────────
async function doResult(db, d1, d2, d3, groupId, replyTk) {
  const sum    = d1+d2+d3;
  const triple = d1===d2&&d2===d3;
  const hi     = sum>=11;
  const DE     = ['','⚀','⚁','⚂','⚃','⚄','⚅'];
  const label  = triple ? 'ต๊อก!' : hi ? 'สูง' : 'ต่ำ';
  const results = settleRound(db, db.currentRound, d1, d2, d3);

  db.rounds.unshift({ round:db.currentRound, d1,d2,d3,sum,label, ts:new Date().toISOString(), settled:results.length });
  if (db.rounds.length > 500) db.rounds.length = 500;
  addLog(db, 'result', `รอบ ${db.currentRound}: ${d1}-${d2}-${d3}=${sum} ${label} ออกผล ${results.length} รายการ`);

  const prevRound = db.currentRound;
  db.currentRound++;
  db.isOpen = true;

  const header = `🎲 เปิดที่ ${prevRound} ผลออก ${label}\n${DE[d1]} ${DE[d2]} ${DE[d3]}\n${d1} + ${d2} + ${d3} = ${sum}`;
  const target  = groupId || db.defaultGroupId;

  if (replyTk) await replyMsg(replyTk, [txtMsg(header)]);
  else if (target) await pushMsg(target, [txtMsg(header)]);

  if (target && results.length > 0) {
    const pending = db.bets.filter(b => b.round===prevRound && b.status==='settled');
    const lines   = pending.map(bet => {
      const p = db.players[bet.uid];
      if (!p) return '';
      return bet.net > 0
        ? winReply(bet.name, bet.memberId, bet.items, p.balance)
        : loseReply(bet.name, bet.memberId, p.balance);
    }).filter(Boolean);

    for (let i=0; i<lines.length; i+=4) {
      const chunk = lines.slice(i, i+4).join('\n' + '─'.repeat(20) + '\n');
      await pushMsg(target, [txtMsg(chunk)]);
      if (i+4 < lines.length) await delay(300);
    }
  } else if (results.length === 0 && target) {
    await pushMsg(target, [txtMsg('ไม่มีรายการเดิมพันรอบนี้')]);
  }
  return results;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── Import สมาชิกกลุ่ม (reusable helper) ────────────────────
async function importGroupMembers(db, groupId) {
  if (!TOKEN || !groupId) return { added:0, existed:0, total:0 };
  let allUids=[], next=null;
  do {
    const page = await new Promise((resolve, reject) => {
      const p2 = `/v2/bot/group/${groupId}/members/ids`+(next?`?start=${next}`:'');
      const r = https.request({ hostname:'api.line.me', path:p2, method:'GET',
        headers:{ Authorization:`Bearer ${TOKEN}` }
      }, resp => { let b=''; resp.on('data',d=>b+=d); resp.on('end',()=>{ try{resolve(JSON.parse(b));}catch{resolve({});} }); });
      r.on('error', reject); r.end();
    });
    if (page.memberIds) allUids.push(...page.memberIds);
    next = page.next||null;
  } while(next);
  let added=0, existed=0;
  for (const mUid of allUids) {
    if (db.players[mUid]) { db.players[mUid].groupId=groupId; existed++; continue; }
    const prof = await getProfile(mUid, groupId);
    const cnt  = Object.keys(db.players).length+1;
    db.players[mUid] = { name:prof?.displayName||`สมาชิก${cnt}`, uid:mUid, memberId:cnt,
      balance:0, totalBet:0, totalWin:0, totalLoss:0, joinedAt:new Date().toISOString(), groupId };
    addLog(db, 'follow', `Auto-import: ${db.players[mUid].name}`, mUid);
    added++; await delay(80);
  }
  if (!db.defaultGroupId) db.defaultGroupId=groupId;
  console.log(`✅ importGroupMembers: total=${allUids.length} added=${added} existed=${existed}`);
  return { total:allUids.length, added, existed };
}

// ─── WEBHOOK ──────────────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));

app.post('/webhook', async (req, res) => {
  if (SECRET) {
    const sig  = req.headers['x-line-signature'];
    const hash = crypto.createHmac('SHA256', SECRET).update(req.body).digest('base64');
    if (hash !== sig) return res.sendStatus(403);
  }
  res.sendStatus(200);

  let body; try { body = JSON.parse(req.body.toString()); } catch { return; }
  const db = await readDB();

  for (const ev of (body.events || [])) {
    const uid     = ev.source?.userId;
    const groupId = ev.source?.groupId || ev.source?.roomId || null;
    const replyTk = ev.replyToken;
    const srcId   = groupId || uid;
    if (!uid) continue;

    if (groupId && !db.defaultGroupId) { db.defaultGroupId = groupId; }

    if (!db.players[uid]) {
      const prof = await getProfile(uid, groupId);
      const cnt  = Object.keys(db.players).length + 1;
      db.players[uid] = {
        name: prof?.displayName || `สมาชิก${cnt}`,
        uid, memberId: cnt,
        balance: 0,
        totalBet: 0, totalWin: 0, totalLoss: 0,
        joinedAt: new Date().toISOString(),
        groupId,
      };
    }
    const player = db.players[uid];
    const name   = player.name;

    // ── IMAGE MESSAGE — AI สลิปวิเคราะห์ ─────────────────────
    if (ev.type === 'message' && ev.message?.type === 'image') {
      addLog(db, 'slip', `${name} ส่งรูป — กำลังวิเคราะห์...`, uid);
      await saveDB(db);

      // แจ้งว่ากำลังวิเคราะห์
      if (db.settings.autoReply) {
        await replyMsg(replyTk, [txtMsg(`🤖 กำลังวิเคราะห์สลิป รอสักครู่...`)]);
      }

      try {
        const { base64, contentType } = await downloadLineImage(ev.message.id);
        const playerNames = Object.values(db.players).map(p => p.name);
        const ai = await analyzeSlipWithAI(base64, contentType, playerNames);

        const slipRecord = {
          id: Date.now().toString(),
          uid, name,
          ts: new Date().toISOString(),
          groupId,
          imageId: ev.message.id,
          ai,
          status: 'pending',  // pending | approved | rejected | duplicate
          topupDone: false,
        };

        if (!ai.ok || !ai.isSlip) {
          slipRecord.status = 'rejected';
          addLog(db, 'slip', `${name} สลิปไม่ถูกต้อง: ${ai.error || 'ไม่ใช่สลิป'}`, uid);
          db.slips.unshift(slipRecord);
          if (db.settings.autoReply) {
            await pushMsg(srcId, [txtMsg(`❌ ไม่พบข้อมูลสลิปในรูปภาพ\nกรุณาส่งรูปสลิปชัดๆ`)]);
          }
          await saveDB(db); continue;
        }

        // ตรวจสลิปซ้ำ (refNo ซ้ำ)
        if (ai.refNo) {
          const dup = db.slips.find(s => s.ai?.refNo === ai.refNo && s.status !== 'rejected');
          if (dup) {
            slipRecord.status = 'duplicate';
            addLog(db, 'slip', `${name} สลิปซ้ำ refNo: ${ai.refNo}`, uid);
            db.slips.unshift(slipRecord);
            if (db.settings.autoReply) {
              await pushMsg(srcId, [txtMsg(`⚠️ สลิปนี้ถูกใช้แล้ว (Ref: ${ai.refNo})\nกรุณาตรวจสอบ`)]);
            }
            await saveDB(db); continue;
          }
        }

        // ยอดต่ำกว่าขั้นต่ำ
        const minAmt = db.settings.slipMinAmount || 1;
        if (ai.amount < minAmt) {
          slipRecord.status = 'rejected';
          addLog(db, 'slip', `${name} ยอดต่ำกว่าขั้นต่ำ: ${ai.amount} < ${minAmt}`, uid);
          db.slips.unshift(slipRecord);
          if (db.settings.autoReply) {
            await pushMsg(srcId, [txtMsg(`❌ ยอดโอน ${ai.amount.toLocaleString()} ต่ำกว่าขั้นต่ำ (${minAmt.toLocaleString()} บาท)`)]);
          }
          await saveDB(db); continue;
        }

        // จับคู่ผู้เล่น
        let matchedPlayer = null;
        if (ai.matchedPlayer) {
          matchedPlayer = findPlayerByName(db, ai.matchedPlayer);
        }
        if (!matchedPlayer) {
          matchedPlayer = findPlayerByName(db, ai.senderName);
        }
        // ถ้ายังไม่เจอ ใช้ผู้ส่งสลิปเลย
        if (!matchedPlayer) {
          matchedPlayer = player;
        }

        slipRecord.matchedPlayer = matchedPlayer ? { uid: matchedPlayer.uid, name: matchedPlayer.name } : null;

        // เติมเงินอัตโนมัติถ้าเปิดใช้
        if (db.settings.autoTopupSlip && matchedPlayer) {
          matchedPlayer.balance += ai.amount;
          db.deposits.unshift({
            uid: matchedPlayer.uid, name: matchedPlayer.name,
            amt: ai.amount, type: 'slip',
            refNo: ai.refNo || '',
            ts: new Date().toISOString()
          });
          slipRecord.status = 'approved';
          slipRecord.topupDone = true;
          addLog(db, 'slip', `✅ สลิป ${ai.amount} บาท → ${matchedPlayer.name} (รวม ${matchedPlayer.balance})`, uid);

          const replyText =
            `✅ รับสลิปสำเร็จ!\n` +
            `👤 ${matchedPlayer.name}\n` +
            `💰 ยอดโอน: ${ai.amount.toLocaleString()} บาท\n` +
            `🏦 จาก: ${ai.bankFrom || '—'}\n` +
            (ai.refNo ? `📋 Ref: ${ai.refNo}\n` : '') +
            `\n💳 เงินคงเหลือ = ${matchedPlayer.balance.toLocaleString()} 💰💰`;

          await pushMsg(srcId, [txtMsg(replyText)]);
        } else {
          // รอแอดมินอนุมัติ
          slipRecord.status = 'pending';
          addLog(db, 'slip', `⏳ รอตรวจสลิป ${ai.amount} บาท จาก ${ai.senderName || name}`, uid);
          const replyText =
            `📋 ได้รับสลิปแล้ว รอแอดมินตรวจสอบ\n` +
            `💰 ยอด: ${ai.amount.toLocaleString()} บาท\n` +
            `🏦 จาก: ${ai.bankFrom || '—'}\n` +
            (ai.refNo ? `📋 Ref: ${ai.refNo}` : '');
          await pushMsg(srcId, [txtMsg(replyText)]);
        }

        db.slips.unshift(slipRecord);
        if (db.slips.length > 500) db.slips.length = 500;

      } catch (err) {
        addLog(db, 'slip', `❌ วิเคราะห์สลิปผิดพลาด: ${err.message}`, uid);
        if (db.settings.autoReply) {
          await pushMsg(srcId, [txtMsg(`❌ วิเคราะห์สลิปไม่สำเร็จ กรุณาแจ้งแอดมิน`)]);
        }
      }
      await saveDB(db); continue;
    }

    // ── TEXT MESSAGE ──────────────────────────────────────────
    if (ev.type === 'message' && ev.message?.type === 'text') {
      const text  = ev.message.text.trim();
      const lower = text.toLowerCase();
      addLog(db, 'msg', `${name}: ${text.slice(0,80)}`, uid);

      // เช็คยอด
      if (/^(ยอด|เงิน|balance|คงเหลือ)$/i.test(lower)) {
        await replyMsg(replyTk, [txtMsg(
          `💰 ${name}\nID : ${player.memberId}\nเงินคงเหลือ = ${player.balance.toLocaleString()} 💰💰`
        )]);
        await saveDB(db); continue;
      }

      // อันดับ
      if (/^(อันดับ|rank|top)$/i.test(lower)) {
        const sorted = Object.values(db.players).sort((a,b)=>b.balance-a.balance).slice(0,10);
        const medals = ['🥇','🥈','🥉'];
        const lines  = sorted.map((p,i) => `${medals[i]||`${i+1}.`} ${p.name} — ${p.balance.toLocaleString()}`);
        await replyMsg(replyTk, [txtMsg('🏆 อันดับเงิน\n' + lines.join('\n'))]);
        await saveDB(db); continue;
      }

      // วิธีแทง
      if (/^(วิธีแทง|วิธีเล่น|คำสั่ง|help|\?)$/i.test(lower)) {
        await replyMsg(replyTk, [txtMsg(
          `📋 วิธีแทง Better Day\n\n` +
          `สูง=100  ต่ำ=200\n` +
          `คู่=100  คี่=100\n` +
          `45=100  (คู่ตาย)\n` +
          `456=50  (สามตัว)\n` +
          `444=100 (ต๊อก)\n` +
          `9=200   (ผลรวม)\n` +
          `6ส=100  (ตัวสูง)\n\n` +
          `เพิ่ม 5=40 (เพิ่มแทง)\n` +
          `ยอด  (ดูเงินคงเหลือ)\n` +
          `อันดับ (ดู Top 10)\n\n` +
          `💳 ส่งสลิปโอนเงินเพื่อเติมเงินอัตโนมัติ`
        )]);
        await saveDB(db); continue;
      }

      // เปิดรอบ
      const openM = text.match(/^เปิด(ที่|รอบ)?\s*(\d+)?$/);
      if (openM) {
        db.isOpen = true;
        if (openM[2]) db.currentRound = parseInt(openM[2]);
        if (groupId) db.defaultGroupId = groupId;
        const msg = `🟢 เปิดที่ ${db.currentRound} รับแทงได้แล้ว!\n\nแทงได้เลย:\nสูง=100  ต่ำ=100\nหรือพิมพ์ "วิธีแทง"`;
        await replyMsg(replyTk, [txtMsg(msg)]);
        if (srcId !== uid) await pushMsg(srcId, [txtMsg(msg)]);
        addLog(db, 'open', `เปิดที่ ${db.currentRound}`);
        await saveDB(db); continue;
      }

      // ปิดรับแทง
      if (/^ปิด(รับแทง)?$/.test(lower)) {
        db.isOpen = false;
        const bc = db.bets.filter(b=>b.round===db.currentRound&&b.status==='pending').length;
        const msg = `🔴 ปิดรับแทงแล้ว\nมีรายการแทง ${bc} รายการ รอผล...`;
        await replyMsg(replyTk, [txtMsg(msg)]);
        addLog(db, 'close', `ปิดรับแทงรอบ ${db.currentRound} มี ${bc} รายการ`);
        await saveDB(db); continue;
      }

      // สุ่มลูกเต๋า
      if (/^(สุ่ม|roll|ออกผล)$/.test(lower)) {
        db.isOpen = false;
        const d1=Math.ceil(Math.random()*6), d2=Math.ceil(Math.random()*6), d3=Math.ceil(Math.random()*6);
        await doResult(db, d1,d2,d3, groupId, replyTk);
        await saveDB(db); continue;
      }

      // ตั้งผลเอง
      const manM = text.match(/^ผล\s+(\d)\s+(\d)\s+(\d)$/);
      if (manM) {
        db.isOpen = false;
        const [,d1,d2,d3] = manM.map(Number);
        await doResult(db, d1,d2,d3, groupId, replyTk);
        await saveDB(db); continue;
      }

      // เติมเงิน
      const topupM = text.match(/^เติม\s+(.+?)\s+(\d+)$/);
      if (topupM) {
        const q=topupM[1].trim(), amt=parseInt(topupM[2]);
        const found = Object.values(db.players).find(p=>p.name===q||p.name.includes(q)||String(p.memberId)===q);
        if (found) {
          found.balance += amt;
          db.deposits.unshift({ uid:found.uid, name:found.name, amt, type:'topup', ts:new Date().toISOString() });
          addLog(db, 'topup', `เติม ${amt} ให้ ${found.name} (รวม ${found.balance})`);
          await replyMsg(replyTk, [txtMsg(`✅ เติม ${amt.toLocaleString()} ให้ ${found.name}\nเงินคงเหลือ = ${found.balance.toLocaleString()} 💰💰`)]);
        } else {
          await replyMsg(replyTk, [txtMsg(`❌ ไม่พบ: ${q}`)]);
        }
        await saveDB(db); continue;
      }

      // ถอนเงิน
      const withdrawM = text.match(/^ถอน\s+(.+?)\s+(\d+)$/);
      if (withdrawM) {
        const q=withdrawM[1].trim(), amt=parseInt(withdrawM[2]);
        const found = Object.values(db.players).find(p=>p.name===q||p.name.includes(q)||String(p.memberId)===q);
        if (found) {
          found.balance -= amt;
          db.deposits.unshift({ uid:found.uid, name:found.name, amt:-amt, type:'withdraw', ts:new Date().toISOString() });
          addLog(db, 'withdraw', `ถอน ${amt} จาก ${found.name} (เหลือ ${found.balance})`);
          await replyMsg(replyTk, [txtMsg(`✅ ถอน ${amt.toLocaleString()} จาก ${found.name}\nเงินคงเหลือ = ${found.balance.toLocaleString()} 💰💰`)]);
        } else {
          await replyMsg(replyTk, [txtMsg(`❌ ไม่พบ: ${q}`)]);
        }
        await saveDB(db); continue;
      }

      // คำสั่งเดิมพัน
      const { regular, extra } = parseBets(text);
      if (regular.length > 0 || extra.length > 0) {
        if (!db.isOpen) {
          await replyMsg(replyTk, [txtMsg(`🔴 ปิดรับแทงแล้ว รอรอบถัดไป`)]);
          await saveDB(db); continue;
        }
        const allItems = [...regular, ...extra];
        const total    = allItems.reduce((s,b)=>s+b.amt, 0);

        db.bets.unshift({
          id:`${Date.now()}`, uid, name, memberId:player.memberId,
          round:db.currentRound, items:allItems, total,
          status:'pending', ts:new Date().toISOString(), groupId,
        });
        if (db.bets.length > 50000) db.bets.length = 50000;
        player.totalBet += total;
        addLog(db, 'bet', `${name} แทง ${allItems.length} รายการ รวม ${total} รอบ ${db.currentRound}`, uid);

        const replies = [];
        if (regular.length > 0) replies.push(txtMsg(betReply(name, regular, player.balance)));
        if (extra.length   > 0) replies.push(txtMsg(extraReply(name, extra, player.balance)));
        if (replies.length > 0) await replyMsg(replyTk, replies);
        await saveDB(db); continue;
      }
    }

    // ── JOIN: บอทเข้ากลุ่ม → ดึงสมาชิกอัตโนมัติ ─────────────────
    if (ev.type === 'join') {
      if (groupId) db.defaultGroupId = groupId;
      addLog(db, 'join', `บอทเข้ากลุ่ม ${groupId||''} — กำลังดึงสมาชิก...`);
      await saveDB(db);
      await replyMsg(replyTk, [txtMsg(`🐉 สวัสดีครับ! Better Day Bot พร้อมแล้ว\n🔄 กำลังดึงข้อมูลสมาชิก...\n\nพิมพ์ "วิธีแทง" เพื่อดูคำสั่ง`)]);
      if (TOKEN && groupId) {
        setImmediate(async () => {
          try {
            const db2 = await readDB();
            const { added } = await importGroupMembers(db2, groupId);
            await saveDB(db2);
            if (added > 0) await pushMsg(groupId, [txtMsg(`✅ เพิ่มสมาชิก ${added} คนเข้าระบบแล้ว\n💳 ส่งสลิปเติมเงิน แล้วแทงได้เลย!`)]);
          } catch(e) { console.error('auto import error:', e.message); }
        });
      }
    }

    // ── MEMBER JOINED: มีคนเข้ากลุ่ม ────────────────────────────
    if (ev.type === 'memberJoined') {
      const members = ev.joined?.members || [];
      for (const m of members) {
        if (m.type!=='user') continue;
        const mUid=m.userId; if(!mUid) continue;
        const prof = await getProfile(mUid, groupId);
        const dname = prof?.displayName||`สมาชิก${Object.keys(db.players).length+1}`;
        if (!db.players[mUid]) {
          const cnt = Object.keys(db.players).length+1;
          db.players[mUid] = { name:dname, uid:mUid, memberId:cnt, balance:0,
            totalBet:0, totalWin:0, totalLoss:0, joinedAt:new Date().toISOString(), groupId };
          addLog(db, 'follow', `${dname} เข้ากลุ่ม (ใหม่)`, mUid);
          if (db.settings?.autoReply!==false)
            await pushMsg(groupId, [txtMsg(`🐉 ยินดีต้อนรับ ${dname}!\nID: ${cnt} | เงิน: 0 บาท\n💳 ส่งสลิปเติมเงิน แล้วแทงได้เลย`)]);
        } else {
          db.players[mUid].groupId=groupId;
          addLog(db, 'follow', `${db.players[mUid].name} กลับเข้ากลุ่ม`, mUid);
        }
      }
      await saveDB(db);
    }

    // ── MEMBER LEFT ───────────────────────────────────────────────
    if (ev.type === 'memberLeft') {
      const members = ev.left?.members || [];
      for (const m of members) {
        if (m.type!=='user'||!m.userId) continue;
        const p=db.players[m.userId];
        if (p) { p.groupId=null; addLog(db,'msg',`${p.name} ออกจากกลุ่ม`,m.userId); }
      }
      await saveDB(db);
    }

    // ── FOLLOW: add บอท 1:1 ──────────────────────────────────────
    if (ev.type === 'follow') {
      const prof = await getProfile(uid, null);
      const dname = prof?.displayName||`สมาชิก${Object.keys(db.players).length+1}`;
      if (!db.players[uid]) {
        const cnt = Object.keys(db.players).length+1;
        db.players[uid] = { name:dname, uid, memberId:cnt, balance:0,
          totalBet:0, totalWin:0, totalLoss:0, joinedAt:new Date().toISOString(), groupId:null };
      }
      const p=db.players[uid];
      await replyMsg(replyTk, [txtMsg(`🐉 ยินดีต้อนรับ ${p.name}!\nID: ${p.memberId} | เงิน: ${p.balance.toLocaleString()} บาท\n\n💳 ส่งสลิปเติมเงิน\nพิมพ์ "วิธีแทง" เพื่อดูคำสั่ง`)]);
      addLog(db, 'follow', `${p.name} add บอท`, uid);
      await saveDB(db);
    }
  }
});

// ─── REST API ─────────────────────────────────────────────────
app.use(express.json());

function auth(req, res, next) {
  const t = req.headers['x-admin-token'] || req.query.token;
  if (t !== ADMIN_PW) return res.status(401).json({ error:'unauthorized' });
  next();
}

app.get('/api/data', auth, async (req, res) => {
  const db = await readDB();
  const players = Object.values(db.players);
  res.json({
    players,
    bets:      db.bets.slice(0, 300),
    rounds:    db.rounds.slice(0, 100),
    deposits:  db.deposits.slice(0, 100),
    slips:     (db.slips||[]).slice(0, 100),
    logs:      db.logs.slice(0, 200),
    settings:  db.settings,
    defaultGroupId: db.defaultGroupId,
    stats: {
      currentRound:  db.currentRound,
      isOpen:        db.isOpen,
      totalPlayers:  players.length,
      pendingBets:   db.bets.filter(b=>b.status==='pending').length,
      settledBets:   db.bets.filter(b=>b.status==='settled').length,
      totalDeposit:  db.deposits.filter(d=>d.amt>0).reduce((s,d)=>s+d.amt,0),
      totalWithdraw: db.deposits.filter(d=>d.amt<0).reduce((s,d)=>s+Math.abs(d.amt),0),
      houseProfit:   db.bets.filter(b=>b.status==='settled').reduce((s,b)=>s-b.net,0),
      pendingSlips:  (db.slips||[]).filter(s=>s.status==='pending').length,
      approvedSlips: (db.slips||[]).filter(s=>s.status==='approved').length,
      totalSlipAmt:  (db.slips||[]).filter(s=>s.status==='approved').reduce((s,sl)=>s+(sl.ai?.amount||0),0),
    }
  });
});

app.post('/api/roll', auth, async (req, res) => {
  const { d1, d2, d3, random, groupId } = req.body;
  const db = await readDB();
  const rd1 = random ? Math.ceil(Math.random()*6) : +d1;
  const rd2 = random ? Math.ceil(Math.random()*6) : +d2;
  const rd3 = random ? Math.ceil(Math.random()*6) : +d3;
  if (!rd1||!rd2||!rd3) return res.json({ ok:false, error:'invalid dice' });
  db.isOpen = false;
  const results = await doResult(db, rd1,rd2,rd3, groupId||db.defaultGroupId, null);
  await saveDB(db);
  res.json({ ok:true, d1:rd1, d2:rd2, d3:rd3, results, settled:results.length });
});

app.post('/api/open', auth, async (req, res) => {
  const db = await readDB();
  db.isOpen = true;
  if (req.body.round)   db.currentRound  = +req.body.round;
  if (req.body.groupId) db.defaultGroupId = req.body.groupId;
  addLog(db, 'open', `Dashboard เปิดที่ ${db.currentRound}`);
  const msg = `🟢 เปิดที่ ${db.currentRound} รับแทงได้แล้ว!`;
  await saveDB(db);
  const gid = req.body.groupId || db.defaultGroupId;
  if (gid) await pushMsg(gid, [txtMsg(msg)]);
  res.json({ ok:true, round:db.currentRound });
});

app.post('/api/close', auth, async (req, res) => {
  const db = await readDB();
  db.isOpen = false;
  const bc = db.bets.filter(b=>b.round===db.currentRound&&b.status==='pending').length;
  addLog(db, 'close', `Dashboard ปิดรับแทง มี ${bc} รายการ`);
  await saveDB(db);
  const gid = req.body.groupId || db.defaultGroupId;
  if (gid) await pushMsg(gid, [txtMsg(`🔴 ปิดรับแทงแล้ว มี ${bc} รายการ`)]);
  res.json({ ok:true, pendingBets:bc });
});

app.post('/api/topup', auth, async (req, res) => {
  const { uid, amt, notify } = req.body;
  const db = await readDB();
  const p  = db.players[uid];
  if (!p) return res.json({ ok:false, error:'not found' });
  p.balance += +amt;
  db.deposits.unshift({ uid, name:p.name, amt:+amt, type:'topup', ts:new Date().toISOString() });
  addLog(db, 'topup', `เติม ${amt} ให้ ${p.name} (รวม ${p.balance})`);
  await saveDB(db);
  if (notify) await pushMsg(uid, [txtMsg(`💰 แอดมินเติม ${(+amt).toLocaleString()} ให้คุณ\nเงินคงเหลือ = ${p.balance.toLocaleString()} 💰💰`)]);
  res.json({ ok:true, balance:p.balance });
});

app.post('/api/withdraw', auth, async (req, res) => {
  const { uid, amt, notify } = req.body;
  const db = await readDB();
  const p  = db.players[uid];
  if (!p) return res.json({ ok:false, error:'not found' });
  p.balance -= +amt;
  db.deposits.unshift({ uid, name:p.name, amt:-(+amt), type:'withdraw', ts:new Date().toISOString() });
  addLog(db, 'withdraw', `ถอน ${amt} จาก ${p.name} (เหลือ ${p.balance})`);
  await saveDB(db);
  if (notify) await pushMsg(uid, [txtMsg(`💸 แอดมินถอน ${(+amt).toLocaleString()} จากบัญชีคุณ\nเงินคงเหลือ = ${p.balance.toLocaleString()} 💰💰`)]);
  res.json({ ok:true, balance:p.balance });
});

// ─── API สลิป: อนุมัติ/ปฏิเสธ ────────────────────────────────
app.post('/api/slip/approve', auth, async (req, res) => {
  const { slipId, uid: overrideUid, notify } = req.body;
  const db = await readDB();
  const slip = (db.slips||[]).find(s => s.id === slipId);
  if (!slip) return res.json({ ok:false, error:'slip not found' });
  if (slip.topupDone) return res.json({ ok:false, error:'already topped up' });

  const targetUid = overrideUid || slip.matchedPlayer?.uid || slip.uid;
  const p = db.players[targetUid];
  if (!p) return res.json({ ok:false, error:'player not found' });

  const amt = slip.ai?.amount || 0;
  p.balance += amt;
  slip.status = 'approved';
  slip.topupDone = true;
  slip.approvedBy = 'admin';
  slip.approvedAt = new Date().toISOString();

  db.deposits.unshift({ uid: p.uid, name: p.name, amt, type: 'slip', refNo: slip.ai?.refNo || '', ts: new Date().toISOString() });
  addLog(db, 'slip', `แอดมินอนุมัติสลิป ${amt} → ${p.name} (รวม ${p.balance})`);
  await saveDB(db);

  if (notify) {
    await pushMsg(p.uid, [txtMsg(`✅ สลิปได้รับการอนุมัติ!\n💰 เติม ${amt.toLocaleString()} บาท\nเงินคงเหลือ = ${p.balance.toLocaleString()} 💰💰`)]);
  }
  res.json({ ok:true, balance: p.balance });
});

app.post('/api/slip/reject', auth, async (req, res) => {
  const { slipId, reason, notify } = req.body;
  const db = await readDB();
  const slip = (db.slips||[]).find(s => s.id === slipId);
  if (!slip) return res.json({ ok:false, error:'slip not found' });

  slip.status = 'rejected';
  slip.rejectReason = reason || 'แอดมินปฏิเสธ';
  slip.rejectedAt = new Date().toISOString();
  addLog(db, 'slip', `แอดมินปฏิเสธสลิป ${slip.ai?.amount || 0} จาก ${slip.name}: ${reason || ''}`);
  await saveDB(db);

  if (notify && slip.uid) {
    await pushMsg(slip.uid, [txtMsg(`❌ สลิปถูกปฏิเสธ\nเหตุผล: ${reason || 'ไม่ระบุ'}\nกรุณาติดต่อแอดมิน`)]);
  }
  res.json({ ok:true });
});

app.post('/api/push', auth, async (req, res) => {
  const { to, message } = req.body;
  if (!to||!message) return res.json({ ok:false });
  await pushMsg(to, [txtMsg(message)]);
  const db = await readDB();
  addLog(db, 'push', `ส่ง: "${message.slice(0,40)}" → ${to}`);
  await saveDB(db);
  res.json({ ok:true });
});

app.post('/api/settings', auth, async (req, res) => {
  const db = await readDB();
  db.settings = { ...db.settings, ...req.body };
  if (req.body.defaultGroupId) db.defaultGroupId = req.body.defaultGroupId;
  await saveDB(db);
  res.json({ ok:true });
});

// ─── Credentials API ─────────────────────────────────────────
app.post('/api/credentials', auth, async (req, res) => {
  const { lineSecret, lineToken, anthropicKey, testConnection } = req.body;
  const db = await readDB();
  if (!db.settings.credentials) db.settings.credentials = {};
  if (lineSecret)   { db.settings.credentials.lineSecret   = lineSecret;   SECRET        = lineSecret;   }
  if (lineToken)    { db.settings.credentials.lineToken     = lineToken;     TOKEN         = lineToken;     }
  if (anthropicKey) { db.settings.credentials.anthropicKey = anthropicKey; ANTHROPIC_KEY = anthropicKey; }
  await saveDB(db);
  if (testConnection && TOKEN) {
    try {
      const info = await new Promise((resolve, reject) => {
        const r = https.request({ hostname:'api.line.me', path:'/v2/bot/info', method:'GET',
          headers:{ Authorization:`Bearer ${TOKEN}` }
        }, resp => { let b=''; resp.on('data',d=>b+=d); resp.on('end',()=>{ try{resolve(JSON.parse(b));}catch{resolve({});} }); });
        r.on('error', reject); r.end();
      });
      return res.json({ ok:true, saved:true, botInfo:info });
    } catch(e) { return res.json({ ok:true, saved:true, testError:e.message }); }
  }
  res.json({ ok:true, saved:true });
});
app.get('/api/credentials', auth, async (req, res) => {
  const db = await readDB();
  const cr = db.settings?.credentials||{};
  const mask = v => v ? v.slice(0,4)+'••••'+v.slice(-4) : '';
  res.json({ ok:true,
    lineSecret:  { set:!!cr.lineSecret,   preview:mask(cr.lineSecret)   },
    lineToken:   { set:!!cr.lineToken,    preview:mask(cr.lineToken)    },
    anthropicKey:{ set:!!cr.anthropicKey, preview:mask(cr.anthropicKey) },
    runtimeActive:{ secret:!!SECRET, token:!!TOKEN, ai:!!ANTHROPIC_KEY, mongo:_mongoOk },
  });
});
// ─── MongoDB URI API ──────────────────────────────────────────
app.post('/api/mongo-uri', auth, async (req, res) => {
  const { mongoUri } = req.body;
  if (!mongoUri) return res.json({ ok:false, error:'กรุณาใส่ URI' });
  if (mongoUri.includes('<password>')) return res.json({ ok:false, error:'แทนที่ <password> ก่อน' });
  let tc;
  try {
    tc = new MongoClient(mongoUri, { serverSelectionTimeoutMS:8000 });
    await tc.connect(); await tc.db('admin').command({ ping:1 }); await tc.close(); tc=null;
  } catch(e) { if(tc){try{await tc.close();}catch{}} return res.json({ ok:false, error:'เชื่อมต่อไม่ได้: '+e.message }); }
  if (_mongoClient){try{await _mongoClient.close();}catch{}} _mongoClient=null; _db=null; _mongoOk=false; MONGO_URI=mongoUri;
  try {
    await getMongoCol();
    const db = await readDB();
    if (!db.settings.credentials) db.settings.credentials={};
    db.settings.credentials.mongoUri=mongoUri;
    db.settings.botName = db.settings.botName||'Better Day';
    db.settings.startBalance = db.settings.startBalance??0;
    await saveDB(db);
    res.json({ ok:true, connected:true, dbName:_db?.databaseName||'himangkorn' });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});
// ─── Bot Info API ─────────────────────────────────────────────
app.get('/api/bot-info', auth, async (req, res) => {
  if (!TOKEN) return res.json({ ok:false, error:'ยังไม่ได้ตั้ง Token' });
  try {
    const info = await new Promise((resolve, reject) => {
      const r = https.request({ hostname:'api.line.me', path:'/v2/bot/info', method:'GET',
        headers:{ Authorization:`Bearer ${TOKEN}` }
      }, resp => { let b=''; resp.on('data',d=>b+=d); resp.on('end',()=>{ try{resolve(JSON.parse(b));}catch{resolve({});} }); });
      r.on('error', reject); r.end();
    });
    res.json({ ok:true, info });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});
// ─── Import Group Members API ─────────────────────────────────
app.post('/api/import-group', auth, async (req, res) => {
  if (!TOKEN) return res.json({ ok:false, error:'ยังไม่ได้ตั้ง LINE Token — ตั้งค่าใน Settings ก่อน' });
  const db = await readDB();
  const gid = req.body.groupId || db.defaultGroupId;
  if (!gid) return res.json({ ok:false, error:'ไม่มี groupId' });
  try {
    const result = await importGroupMembers(db, gid);
    await saveDB(db);
    res.json({ ok:true, ...result });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});
app.post('/api/reset', auth, async (req, res) => {
  const { what } = req.body;
  const db = await readDB();
  if (!what || what==='all')     { Object.assign(db, { players:{}, bets:[], rounds:[], deposits:[], logs:[], slips:[], currentRound:155, isOpen:false }); }
  else if (what==='bets')        { db.bets=[]; }
  else if (what==='logs')        { db.logs=[]; }
  else if (what==='rounds')      { db.rounds=[]; }
  else if (what==='slips')       { db.slips=[]; }
  await saveDB(db);
  res.json({ ok:true });
});

app.get('/health', (_, res) => res.json({ ok:true, ts:new Date().toISOString(), port:PORT, aiEnabled:!!ANTHROPIC_KEY, lineOk:!!TOKEN&&!!SECRET, mongoConnected:_mongoOk }));
app.get('/', (req, res) => res.send(DASHBOARD_HTML.replace(/__TOKEN__/g, req.query.token||'').replace(/__PORT__/g, PORT).replace(/__ADMIN_PW__/g, ADMIN_PW)));

// ─── START ────────────────────────────────────────────────────
async function start() {
  if (MONGO_URI) {
    try {
      await getMongoCol();
      console.log('✅ MongoDB เชื่อมต่อสำเร็จ');
      await loadCredentialsFromDB();
    } catch (e) {
      console.error('❌ MongoDB เชื่อมต่อล้มเหลว:', e.message);
      console.log('⚠️  ใช้ไฟล์ db.json แทน');
    }
  } else {
    console.log('⚠️  MONGODB_URI ไม่ได้ตั้งค่า — ใช้ไฟล์ db.json แทน');
  }

  app.listen(PORT, () => {
    console.log(`\Better Day v4.0 — AI Slip Analyzer Edition`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/?token=${ADMIN_PW}`);
    console.log(`🔗 Webhook:   http://localhost:${PORT}/webhook`);
    console.log(SECRET ? '✅ LINE Secret OK' : '⚠️  LINE_CHANNEL_SECRET ยังไม่ได้ตั้งค่า');
    console.log(TOKEN  ? '✅ LINE Token OK'  : '⚠️  LINE_CHANNEL_ACCESS_TOKEN ยังไม่ได้ตั้งค่า');
    console.log(ANTHROPIC_KEY ? '✅ Anthropic AI OK (AI สลิปพร้อมใช้)' : '⚠️  ANTHROPIC_API_KEY ยังไม่ได้ตั้งค่า — AI สลิปจะไม่ทำงาน');
    console.log('');
  });
}
start();


// ══════════════════════════════════════════════════════════════
//  DASHBOARD HTML
// ══════════════════════════════════════════════════════════════
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Better Day v4 — AI Slip Dashboard</title>
<style>
:root{--bg:#0c0d0b;--bg2:#161714;--bg3:#1e1f1c;--bg4:#272825;--bdr:#2a2b27;--bdr2:#393a36;--txt:#e5e2d8;--muted:#6d6b64;--gold:#c9a84c;--gold2:#e8c96a;--grn:#4a9e6a;--red:#c45252;--blu:#4a7fc0;--pur:#8b6fcc;--cyan:#3aa8a8}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--txt);font-size:13px;overflow:hidden;height:100vh}
.shell{display:grid;grid-template-rows:46px 1fr;height:100vh}
.top{background:var(--bg2);border-bottom:1px solid var(--bdr);padding:0 18px;display:flex;align-items:center;gap:10px;flex-wrap:nowrap;overflow-x:auto}
.logo{font-size:15px;font-weight:700;color:var(--gold);white-space:nowrap;display:flex;align-items:center;gap:6px}
.tag{font-size:10px;padding:2px 8px;border-radius:100px;font-weight:600;white-space:nowrap;flex-shrink:0}
.tg{background:rgba(74,158,106,.15);color:var(--grn);border:1px solid rgba(74,158,106,.25)}
.tr{background:rgba(196,82,82,.15);color:var(--red);border:1px solid rgba(196,82,82,.25)}
.round-lbl{font-size:11px;color:var(--muted);white-space:nowrap}
.round-num{color:var(--gold);font-weight:700}
.spacer{flex:1;min-width:8px}
.tbtn{padding:5px 11px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--bdr2);background:var(--bg3);color:var(--txt);white-space:nowrap;flex-shrink:0;transition:opacity .15s}
.tbtn:hover{opacity:.75}.tbtn.gold{background:var(--gold);color:#111;border-color:var(--gold)}
.tbtn.g{background:rgba(74,158,106,.15);color:var(--grn);border-color:rgba(74,158,106,.3)}
.tbtn.r{background:rgba(196,82,82,.15);color:var(--red);border-color:rgba(196,82,82,.3)}
.tbtn.c{background:rgba(58,168,168,.15);color:var(--cyan);border-color:rgba(58,168,168,.3)}
.body{display:grid;grid-template-columns:190px 1fr;height:calc(100vh - 46px);overflow:hidden}
.sidebar{background:var(--bg2);border-right:1px solid var(--bdr);padding:10px 5px;overflow-y:auto;display:flex;flex-direction:column}
.nav-section{font-size:9px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;padding:10px 10px 4px;margin-top:6px}
.nav-section:first-child{margin-top:0}
.ni{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;cursor:pointer;color:var(--muted);font-size:12px;margin-bottom:1px;transition:all .1s;border:1px solid transparent;user-select:none}
.ni:hover{background:var(--bg3);color:var(--txt)}.ni.on{background:rgba(201,168,76,.09);color:var(--gold);border-color:rgba(201,168,76,.12)}
.ni .icon{font-size:14px;width:16px;text-align:center;flex-shrink:0}
.ni .nb{margin-left:auto;background:var(--red);color:#fff;font-size:9px;font-weight:700;padding:1px 5px;border-radius:100px}
.ni .nbc{margin-left:auto;background:var(--cyan);color:#111;font-size:9px;font-weight:700;padding:1px 5px;border-radius:100px}
.content{overflow-y:auto;padding:16px;height:100%}
.page{display:none}.page.on{display:block}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px}
.kpi{background:var(--bg2);border:1px solid var(--bdr);border-radius:9px;padding:11px 13px;cursor:default}
.kl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.kv{font-size:20px;font-weight:700}.kg{color:var(--gold)}.kgrn{color:var(--grn)}.kblu{color:var(--blu)}.kred{color:var(--red)}.kpur{color:var(--pur)}.kcyan{color:var(--cyan)}
.panel{background:var(--bg2);border:1px solid var(--bdr);border-radius:9px;overflow:hidden;margin-bottom:12px}
.ph{padding:9px 13px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0}
.ph-t{font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:6px}
.badge{display:inline-block;padding:2px 7px;border-radius:100px;font-size:10px;font-weight:600}
.bb{background:rgba(74,127,192,.12);color:#4a7fc0}.bg{background:rgba(74,158,106,.12);color:#4a9e6a}
.br{background:rgba(196,82,82,.12);color:#c45252}.bgo{background:rgba(201,168,76,.12);color:#c9a84c}
.bm{background:var(--bg3);color:var(--muted)}.bpu{background:rgba(139,111,204,.12);color:#8b6fcc}
.bcyan{background:rgba(58,168,168,.12);color:var(--cyan)}
table{width:100%;border-collapse:collapse;table-layout:fixed}
th{font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;padding:8px 11px;border-bottom:1px solid var(--bdr);text-align:left;background:var(--bg3)}
td{padding:8px 11px;border-bottom:1px solid var(--bdr);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:last-child td{border-bottom:none}tr:hover td{background:rgba(255,255,255,.012)}
.ri{display:flex;align-items:center;gap:9px;padding:9px 13px;border-bottom:1px solid var(--bdr)}.ri:last-child{border-bottom:none}
.av{width:28px;height:28px;border-radius:50%;background:rgba(201,168,76,.1);color:var(--gold);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0}
.inp{background:var(--bg3);border:1px solid var(--bdr2);color:var(--txt);padding:7px 10px;border-radius:6px;font-size:12px}
.inp:focus{outline:1px solid var(--gold)}
.fr{display:flex;flex-direction:column;gap:3px;margin-bottom:10px}
.fr label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px}
.die{width:50px;height:50px;background:var(--bg3);border:1px solid var(--bdr2);border-radius:9px;font-size:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .1s;user-select:none}
.die:hover{transform:scale(1.1)}.die:active{transform:scale(.95)}
.spin{animation:sp .35s}@keyframes sp{0%,100%{transform:scale(1)}50%{transform:scale(.85) rotate(10deg)}}
.res-box{background:var(--bg3);border:1px solid var(--bdr2);border-radius:8px;padding:12px;margin-top:12px}
.res-r{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bdr);font-size:12px}.res-r:last-child{border-bottom:none}
.setup-box{background:var(--bg2);border:1px solid var(--bdr);border-radius:9px;padding:16px 18px;margin-bottom:12px}
.setup-box h3{font-size:12px;font-weight:600;color:var(--gold);margin-bottom:13px;padding-bottom:8px;border-bottom:1px solid var(--bdr)}
.code-block{background:var(--bg3);border:1px solid var(--bdr);border-radius:6px;padding:10px 12px;font-family:monospace;font-size:11px;line-height:1.8;color:var(--txt);margin:6px 0;position:relative}
.cbtn{position:absolute;top:6px;right:6px;padding:2px 7px;font-size:10px;border-radius:4px;border:1px solid var(--bdr2);background:var(--bg2);color:var(--muted);cursor:pointer}
.tab-bar{display:flex;border-bottom:1px solid var(--bdr);background:var(--bg3)}
.tab{padding:8px 14px;font-size:11px;font-weight:600;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;transition:all .1s}
.tab:hover{color:var(--txt)}.tab.on{color:var(--gold);border-bottom-color:var(--gold);background:var(--bg2)}
.chat-bubble{padding:9px 12px;background:var(--bg3);border-radius:8px;margin-bottom:6px;font-size:12px;font-family:monospace;line-height:1.5;border:1px solid var(--bdr)}
.toast{position:fixed;bottom:16px;right:16px;background:var(--bg2);border:1px solid var(--bdr2);border-radius:9px;padding:10px 14px;font-size:12px;display:none;align-items:center;gap:8px;z-index:999;max-width:300px}
.toast.on{display:flex;animation:fi .2s}@keyframes fi{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.log-r{padding:7px 13px;border-bottom:1px solid var(--bdr);font-size:11px;display:flex;gap:8px;align-items:flex-start}.log-r:last-child{border-bottom:none}
.lt{color:var(--muted);flex-shrink:0;min-width:72px}.lm{color:var(--muted);word-break:break-all;flex:1}
.lt-bet{color:var(--blu)}.lt-result{color:var(--gold)}.lt-open{color:var(--grn)}.lt-close{color:var(--red)}.lt-topup{color:var(--pur)}.lt-slip{color:var(--cyan)}
/* SLIP CARD */
.slip-card{background:var(--bg3);border:1px solid var(--bdr2);border-radius:8px;padding:12px;margin-bottom:8px}
.slip-card.pending{border-left:3px solid var(--gold)}
.slip-card.approved{border-left:3px solid var(--grn)}
.slip-card.rejected{border-left:3px solid var(--red);opacity:.6}
.slip-card.duplicate{border-left:3px solid var(--pur);opacity:.7}
.slip-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.slip-name{font-size:12px;font-weight:600;color:var(--txt)}
.slip-amt{font-size:16px;font-weight:700;color:var(--cyan)}
.slip-meta{font-size:10px;color:var(--muted);line-height:1.7}
.slip-actions{display:flex;gap:6px;margin-top:8px}
.ai-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:100px;font-size:9px;font-weight:700;background:rgba(58,168,168,.15);color:var(--cyan);border:1px solid rgba(58,168,168,.25)}
@media(max-width:600px){.body{grid-template-columns:1fr}.sidebar{display:none}.g2,.g3{grid-template-columns:1fr}}
</style></head><body>
<div class="shell">

<div class="top">
  <div class="logo">Better Day <span style="font-size:9px;color:var(--cyan);font-weight:400">v4 AI</span></div>
  <span class="tag tg" id="open-tag">● เปิด</span>
  <span class="round-lbl">รอบ <span class="round-num" id="hdr-round">—</span></span>
  <div class="spacer"></div>
  <button class="tbtn g" onclick="quickOpen()">🟢 เปิดรอบ</button>
  <button class="tbtn r" onclick="quickClose()">🔴 ปิดแทง</button>
  <button class="tbtn gold" onclick="go('roll')">🎲 ออกผล</button>
  <button class="tbtn c" onclick="go('slips')">📋 สลิป <span id="hdr-slip-badge" style="background:rgba(58,168,168,.3);padding:0 5px;border-radius:8px;font-size:10px">0</span></button>
  <button class="tbtn" onclick="load()" title="รีเฟรช">↻</button>
</div>

<div class="body">

<div class="sidebar">
  <div class="nav-section">ภาพรวม</div>
  <div class="ni on" onclick="go('dash',this)"><span class="icon">📊</span> Dashboard</div>
  <div class="nav-section">เกม</div>
  <div class="ni" onclick="go('roll',this)"><span class="icon">🎲</span> ออกผลลูกเต๋า</div>
  <div class="ni" onclick="go('bets',this)"><span class="icon">💰</span> รายการแทง <span class="nb" id="nb-bets">0</span></div>
  <div class="ni" onclick="go('rounds',this)"><span class="icon">📜</span> ประวัติรอบ</div>
  <div class="nav-section">การเงิน</div>
  <div class="ni" onclick="go('slips',this)"><span class="icon">🤖</span> AI สลิป <span class="nbc" id="nb-slips">0</span></div>
  <div class="ni" onclick="go('players',this)"><span class="icon">👥</span> ผู้เล่นทั้งหมด</div>
  <div class="ni" onclick="go('finance',this)"><span class="icon">💳</span> ฝาก-ถอน</div>
  <div class="nav-section">ระบบ</div>
  <div class="ni" onclick="go('push',this)"><span class="icon">📢</span> ส่งข้อความ LINE</div>
  <div class="ni" onclick="go('setup',this)"><span class="icon">⚙️</span> ตั้งค่า</div>
  <div class="ni" onclick="go('logs',this)"><span class="icon">📋</span> Event Log</div>
</div>

<div class="content">

<!-- DASHBOARD -->
<div id="p-dash" class="page on">
  <div class="kpis">
    <div class="kpi"><div class="kl">รอบปัจจุบัน</div><div class="kv kg" id="k-round">—</div></div>
    <div class="kpi"><div class="kl">รอรับผล</div><div class="kv kblu" id="k-pending">0</div></div>
    <div class="kpi"><div class="kl">ผู้เล่น</div><div class="kv" id="k-players">0</div></div>
    <div class="kpi"><div class="kl">กำไรห้อง</div><div class="kv kgrn" id="k-profit">0</div></div>
    <div class="kpi"><div class="kl">ฝากรวม</div><div class="kv kpur" id="k-deposit">0</div></div>
    <div class="kpi"><div class="kl">สลิปรออนุมัติ</div><div class="kv kcyan" id="k-slip-pending">0</div></div>
    <div class="kpi"><div class="kl">สลิปรวม</div><div class="kv kcyan" id="k-slip-total">0</div></div>
  </div>
  <div class="g2">
    <div>
      <div class="panel">
        <div class="ph"><span class="ph-t">🎲 เดิมพันล่าสุด</span><span class="badge bb" id="d-betct">0 รอผล</span></div>
        <table><thead><tr><th style="width:20%">ชื่อ</th><th style="width:8%">ID</th><th style="width:10%">รอบ</th><th>คำสั่ง</th><th style="width:14%">รวม</th><th style="width:14%">สถานะ</th></tr></thead>
        <tbody id="d-bets"></tbody></table>
      </div>
      <div class="panel">
        <div class="ph"><span class="ph-t">🤖 สลิปล่าสุด</span><button class="tbtn c" style="font-size:10px;padding:3px 8px" onclick="go('slips')">ดูทั้งหมด</button></div>
        <div id="d-slips"></div>
      </div>
    </div>
    <div>
      <div class="panel">
        <div class="ph"><span class="ph-t">👥 ยอดเงินผู้เล่น</span></div>
        <div id="d-players"></div>
      </div>
      <div class="panel">
        <div class="ph"><span class="ph-t">📜 รอบล่าสุด</span></div>
        <div id="d-rounds"></div>
      </div>
    </div>
  </div>
</div>

<!-- ROLL -->
<div id="p-roll" class="page">
  <div class="g2">
    <div>
      <div class="panel"><div class="ph"><span class="ph-t">🎲 ออกผลลูกเต๋า</span></div>
      <div style="padding:16px">
        <div class="fr"><label>Group ID</label>
          <input class="inp" id="r-gid" style="width:100%" placeholder="กรอก Group ID หรือดูจาก Event Log">
        </div>
        <div style="margin-bottom:14px">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">คลิกลูกเต๋าเพื่อสุ่ม</div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
            <div class="die" id="die1" onclick="rollOne(1)">🎲</div>
            <div class="die" id="die2" onclick="rollOne(2)">🎲</div>
            <div class="die" id="die3" onclick="rollOne(3)">🎲</div>
            <div style="margin-left:6px">
              <div style="font-size:24px;font-weight:700;color:var(--txt)" id="dsum">—</div>
              <div style="font-size:12px;color:var(--muted)" id="dlbl">—</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span style="font-size:11px;color:var(--muted)">ตั้งเอง:</span>
            <input class="inp" id="md1" type="number" min="1" max="6" placeholder="1" style="width:52px" oninput="updDice()">
            <input class="inp" id="md2" type="number" min="1" max="6" placeholder="2" style="width:52px" oninput="updDice()">
            <input class="inp" id="md3" type="number" min="1" max="6" placeholder="3" style="width:52px" oninput="updDice()">
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="tbtn gold" onclick="doRandom()" style="flex:1;padding:9px;font-size:12px">🎲 สุ่มทั้งหมด</button>
          <button class="tbtn g" onclick="doManual()" style="flex:1;padding:9px;font-size:12px">✅ ยืนยันผล</button>
        </div>
        <div id="r-result"></div>
      </div></div>
    </div>
    <div>
      <div class="panel"><div class="ph"><span class="ph-t">⚡ คำสั่งด่วน</span></div>
      <div style="padding:14px;display:flex;flex-direction:column;gap:8px">
        <div class="fr" style="margin:0">
          <label>Group ID</label>
          <input class="inp" id="q-gid" style="width:100%" placeholder="C1234abc...">
        </div>
        <button class="tbtn g" onclick="quickOpen()" style="width:100%;padding:9px;font-size:12px">🟢 เปิดรับแทง + แจ้งกลุ่ม</button>
        <button class="tbtn r" onclick="quickClose()" style="width:100%;padding:9px;font-size:12px">🔴 ปิดรับแทง + แจ้งกลุ่ม</button>
        <div style="border-top:1px solid var(--bdr);padding-top:10px;margin-top:2px">
          <textarea class="inp" id="quick-msg" style="width:100%;height:60px;resize:none" placeholder="ข้อความที่จะส่ง..."></textarea>
          <button class="tbtn" onclick="quickPush()" style="width:100%;margin-top:6px">📢 ส่งข้อความ</button>
        </div>
      </div></div>
      <div class="panel">
        <div class="ph"><span class="ph-t">📊 รายการแทงรอบนี้</span><span class="badge bb" id="r-betct">0</span></div>
        <table><thead><tr><th style="width:30%">ชื่อ</th><th>คำสั่ง</th><th style="width:20%">รวม</th></tr></thead>
        <tbody id="r-bets"></tbody></table>
      </div>
    </div>
  </div>
</div>

<!-- BETS -->
<div id="p-bets" class="page">
  <div class="tab-bar">
    <div class="tab on" onclick="betTab(this,'all')">ทั้งหมด</div>
    <div class="tab" onclick="betTab(this,'pending')">รอผล</div>
    <div class="tab" onclick="betTab(this,'settled')">ออกผลแล้ว</div>
  </div>
  <div class="panel" style="border-top:none;border-radius:0 0 9px 9px">
    <table><thead><tr>
      <th style="width:16%">ชื่อ</th><th style="width:8%">ID</th><th style="width:9%">รอบ</th>
      <th>คำสั่ง</th><th style="width:12%">รวม</th><th style="width:11%">สถานะ</th><th style="width:12%">ผล</th>
    </tr></thead><tbody id="bets-tb"></tbody></table>
  </div>
</div>

<!-- ROUNDS -->
<div id="p-rounds" class="page">
  <div class="panel">
    <div class="ph"><span class="ph-t">📜 ประวัติรอบทั้งหมด</span></div>
    <table><thead><tr>
      <th style="width:12%">รอบ</th><th style="width:22%">ลูกเต๋า</th>
      <th style="width:12%">รวม</th><th style="width:14%">ผล</th><th style="width:12%">รายการ</th><th>เวลา</th>
    </tr></thead><tbody id="rounds-tb"></tbody></table>
  </div>
</div>

<!-- AI SLIPS PAGE -->
<div id="p-slips" class="page">
  <div class="kpis" style="margin-bottom:14px">
    <div class="kpi"><div class="kl">รออนุมัติ</div><div class="kv kg" id="sk-pending">0</div></div>
    <div class="kpi"><div class="kl">อนุมัติแล้ว</div><div class="kv kgrn" id="sk-approved">0</div></div>
    <div class="kpi"><div class="kl">ปฏิเสธ</div><div class="kv kred" id="sk-rejected">0</div></div>
    <div class="kpi"><div class="kl">ยอดรวมสลิป</div><div class="kv kcyan" id="sk-total">0</div></div>
  </div>
  <div class="g2">
    <div>
      <div class="panel">
        <div class="ph">
          <span class="ph-t">🤖 AI วิเคราะห์สลิป <span class="ai-badge">Claude Vision</span></span>
          <div style="display:flex;gap:6px">
            <select class="inp" id="slip-filter" onchange="renderSlips()" style="width:100px;font-size:10px;padding:3px 6px">
              <option value="">ทั้งหมด</option>
              <option value="pending">รออนุมัติ</option>
              <option value="approved">อนุมัติแล้ว</option>
              <option value="rejected">ปฏิเสธ</option>
              <option value="duplicate">ซ้ำ</option>
            </select>
            <button class="tbtn" onclick="load()" style="font-size:10px;padding:3px 8px">↻</button>
          </div>
        </div>
        <div id="slip-list" style="padding:12px;max-height:65vh;overflow-y:auto"></div>
      </div>
    </div>
    <div>
      <div class="setup-box">
        <h3>⚙️ ตั้งค่าระบบสลิป AI</h3>
        <div class="fr">
          <label>เติมเงินอัตโนมัติ (ไม่ต้องรอแอดมิน)</label>
          <select class="inp" id="sl-auto" style="width:100%">
            <option value="1">✅ เปิด — เติมทันทีอัตโนมัติ</option>
            <option value="0">⏳ ปิด — รอแอดมินอนุมัติทุกสลิป</option>
          </select>
        </div>
        <div class="fr">
          <label>ยอดขั้นต่ำที่รับสลิป (บาท)</label>
          <input class="inp" id="sl-min" type="number" style="width:100%" placeholder="1" min="1">
        </div>
        <button class="tbtn gold" onclick="saveSlipSettings()" style="width:100%;padding:8px">💾 บันทึก</button>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--bdr)">
          <div style="font-size:10px;color:var(--muted);line-height:1.9">
            🤖 ระบบใช้ Claude Vision วิเคราะห์:<br>
            • ยอดโอนเงิน<br>
            • ชื่อผู้โอน / ผู้รับ<br>
            • ธนาคาร + เลข Ref<br>
            • จับคู่ชื่อผู้เล่นอัตโนมัติ<br>
            • ตรวจสลิปซ้ำ (Ref No.)
          </div>
        </div>
      </div>
      <div class="setup-box">
        <h3>🔑 ANTHROPIC_API_KEY</h3>
        <p style="font-size:11px;color:var(--muted);margin-bottom:8px">ต้องตั้งใน .env เพื่อให้ AI วิเคราะห์สลิปได้</p>
        <div class="code-block">ANTHROPIC_API_KEY=<span style="color:var(--cyan)">sk-ant-...</span>
<button class="cbtn" onclick="cpCode(this)">copy</button></div>
        <div id="ai-status" style="margin-top:8px;font-size:11px;color:var(--muted)">กำลังตรวจสอบ...</div>
      </div>
      <div class="setup-box">
        <h3>🗑 จัดการข้อมูลสลิป</h3>
        <button class="tbtn r" onclick="resetData('slips')" style="width:100%;text-align:left">🗑 ล้างประวัติสลิปทั้งหมด</button>
      </div>
    </div>
  </div>
</div>

<!-- PLAYERS -->
<div id="p-players" class="page">
  <div class="panel">
    <div class="ph"><span class="ph-t">👥 ผู้เล่นทั้งหมด</span><span class="badge bm" id="pl-count">0 คน</span></div>
    <table><thead><tr>
      <th style="width:7%">ID</th><th style="width:22%">ชื่อ</th><th style="width:17%">เงินคงเหลือ</th>
      <th style="width:13%">แทงรวม</th><th style="width:12%">ชนะ</th><th style="width:12%">แพ้</th><th style="width:15%">จัดการ</th>
    </tr></thead><tbody id="players-tb"></tbody></table>
  </div>
</div>

<!-- FINANCE -->
<div id="p-finance" class="page">
  <div class="g2">
    <div>
      <div class="panel"><div class="ph"><span class="ph-t">💰 เติม/ถอนเงิน</span></div>
      <div style="padding:14px">
        <div class="fr"><label>ค้นหาผู้เล่น (ชื่อ / ID)</label>
          <input class="inp" id="fin-search" style="width:100%" oninput="searchPlayer()" placeholder="พิมพ์ชื่อหรือ ID...">
        </div>
        <div id="fin-player-result"></div>
        <div style="border-top:1px solid var(--bdr);padding-top:12px;margin-top:4px">
          <div class="fr"><label>จำนวนเงิน</label><input class="inp" id="fin-amt" type="number" style="width:100%" placeholder="จำนวนเงิน"></div>
          <div style="display:flex;gap:6px">
            <button class="tbtn g" onclick="doTopup()" style="flex:1;padding:8px">💰 เติมเงิน</button>
            <button class="tbtn r" onclick="doWithdraw()" style="flex:1;padding:8px">💸 ถอนเงิน</button>
          </div>
          <div style="margin-top:8px">
            <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);cursor:pointer">
              <input type="checkbox" id="fin-notify"> แจ้ง LINE ผู้เล่น
            </label>
          </div>
        </div>
      </div></div>
    </div>
    <div>
      <div class="panel"><div class="ph"><span class="ph-t">📋 ประวัติฝาก-ถอน</span></div>
        <table><thead><tr><th style="width:24%">ชื่อ</th><th style="width:18%">จำนวน</th><th style="width:18%">ประเภท</th><th>เวลา</th></tr></thead>
        <tbody id="fin-tb"></tbody></table>
      </div>
    </div>
  </div>
</div>

<!-- PUSH -->
<div id="p-push" class="page">
  <div class="g2">
    <div>
      <div class="panel"><div class="ph"><span class="ph-t">📢 ส่งข้อความ LINE</span></div>
      <div style="padding:14px">
        <div class="fr"><label>ปลายทาง</label>
          <input class="inp" id="push-to" style="width:100%" placeholder="C1234... หรือ U1234...">
        </div>
        <div class="fr"><label>ข้อความ</label>
          <textarea class="inp" id="push-msg" style="height:100px;resize:vertical;width:100%" placeholder="ข้อความที่จะส่ง..."></textarea>
        </div>
        <button class="tbtn gold" onclick="doPush()" style="width:100%;padding:9px">📢 ส่งข้อความ</button>
      </div></div>
    </div>
    <div>
      <div class="panel"><div class="ph"><span class="ph-t">📋 Group ID ที่รู้จัก</span></div>
        <div id="known-groups" style="padding:12px;font-size:12px;color:var(--muted)">โหลด...</div>
      </div>
    </div>
  </div>
</div>

<!-- SETUP -->
<div id="p-setup" class="page">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:14px">
    <div style="background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:4px">MongoDB</div><div id="st-mongo" style="font-size:11px;font-weight:600">⬜ —</div></div>
    <div style="background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:4px">LINE Secret</div><div id="st-secret" style="font-size:11px;font-weight:600">⬜ —</div></div>
    <div style="background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:4px">LINE Token</div><div id="st-token" style="font-size:11px;font-weight:600">⬜ —</div></div>
    <div style="background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:4px">Anthropic AI</div><div id="st-ai" style="font-size:11px;font-weight:600">⬜ —</div></div>
    <div style="background:var(--bg2);border:1px solid var(--bdr);border-radius:8px;padding:10px 12px;overflow:hidden"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:4px">Bot</div><div id="st-bot" style="font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">⬜ —</div></div>
  </div>
  <div class="g2"><div>
    <div class="setup-box"><h3>🍃 MongoDB URI</h3>
      <p style="font-size:11px;color:var(--muted);margin-bottom:10px">บันทึกทุกอย่างลง MongoDB ถาวร — <a href="https://cloud.mongodb.com" target="_blank" style="color:var(--cyan)">cloud.mongodb.com</a> → Connect → Drivers</p>
      <div id="mongo-status-box" style="padding:7px 10px;background:var(--bg3);border-radius:6px;font-size:11px;margin-bottom:10px;color:var(--muted)">กำลังตรวจสอบ...</div>
      <div class="fr"><label>🔗 MongoDB URI</label>
        <div style="position:relative"><input class="inp" id="c-mongo" type="password" style="width:100%;padding-right:50px" placeholder="mongodb+srv://user:pass@cluster.mongodb.net/"><button onclick="togglePw('c-mongo')" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer">👁</button></div>
        <span style="font-size:10px;color:var(--red)">⚠️ แทนที่ &lt;password&gt; ด้วยรหัสผ่านจริงก่อนวาง</span></div>
      <button class="tbtn gold" onclick="saveMongo()" style="width:100%;padding:9px">🍃 บันทึก + ทดสอบ</button>
      <div id="mongo-result" style="display:none;margin-top:8px;padding:8px;border-radius:6px;font-size:11px;background:var(--bg3)"></div>
    </div>
    <div class="setup-box"><h3>🟢 LINE Official Account</h3>
      <p style="font-size:11px;color:var(--muted);margin-bottom:10px"><a href="https://developers.line.biz" target="_blank" style="color:var(--cyan)">developers.line.biz</a> → Channel → Basic settings + Messaging API</p>
      <div class="fr"><label>🔐 Channel Secret</label>
        <div style="position:relative"><input class="inp" id="c-secret" type="password" style="width:100%;padding-right:50px" placeholder="32 ตัวอักษร..."><button onclick="togglePw('c-secret')" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer">👁</button></div></div>
      <div class="fr"><label>🎫 Channel Access Token</label>
        <div style="position:relative"><input class="inp" id="c-token" type="password" style="width:100%;padding-right:50px" placeholder="eyJhbGci..."><button onclick="togglePw('c-token')" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer">👁</button></div></div>
      <div style="display:flex;gap:7px">
        <button class="tbtn gold" onclick="saveCreds(true)" style="flex:2;padding:9px">💾 บันทึก + ทดสอบ</button>
        <button class="tbtn" onclick="saveCreds(false)" style="flex:1;padding:9px">บันทึก</button></div>
      <div id="cred-result" style="display:none;margin-top:8px;padding:8px;border-radius:6px;font-size:11px;background:var(--bg3)"></div>
    </div>
    <div class="setup-box"><h3>🤖 Anthropic AI Key</h3>
      <p style="font-size:11px;color:var(--muted);margin-bottom:10px"><a href="https://console.anthropic.com" target="_blank" style="color:var(--cyan)">console.anthropic.com</a> → API Keys</p>
      <div class="fr"><label>🔑 API Key</label>
        <div style="position:relative"><input class="inp" id="c-ai" type="password" style="width:100%;padding-right:50px" placeholder="sk-ant-api03-..."><button onclick="togglePw('c-ai')" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;color:var(--muted);cursor:pointer">👁</button></div></div>
      <button class="tbtn gold" onclick="saveAIKey()" style="width:100%;padding:9px">💾 บันทึก AI Key</button>
      <div id="ai-result" style="display:none;margin-top:8px;padding:8px;border-radius:6px;font-size:11px;background:var(--bg3)"></div>
    </div>
    <div class="setup-box"><h3>🌐 Webhook URL</h3>
      <div class="code-block"><span id="wh-url-text">กำลังโหลด...</span><button class="cbtn" onclick="cpWh()">copy</button></div>
      <p style="font-size:10px;color:var(--muted);margin-top:6px">LINE → Messaging API → Webhook URL → Verify ✅ → Use webhook ON</p>
    </div>
  </div><div>
    <div class="setup-box"><h3>⚙️ ตั้งค่าทั่วไป</h3>
      <div class="fr"><label>ชื่อบอท</label><input class="inp" id="s-name" style="width:100%" placeholder="Better Day"></div>
      <div class="fr"><label>เงินเริ่มต้น (บาท)</label><input class="inp" id="s-balance" type="number" style="width:100%" placeholder="0" min="0"></div>
      <div class="fr"><label>ยอดขั้นต่ำสลิป (บาท)</label><input class="inp" id="s-slip-min" type="number" style="width:100%" placeholder="1"></div>
      <div class="fr"><label>เติมเงินจากสลิปอัตโนมัติ</label>
        <select class="inp" id="s-auto-slip" style="width:100%"><option value="1">✅ เปิด — เติมทันที</option><option value="0">⏳ ปิด — รอแอดมินอนุมัติ</option></select></div>
      <div class="fr"><label>ตอบกลับอัตโนมัติ</label>
        <select class="inp" id="s-auto-reply" style="width:100%"><option value="1">✅ เปิด</option><option value="0">🔕 ปิด</option></select></div>
      <div class="fr"><label>Group ID หลัก</label><input class="inp" id="s-gid" style="width:100%" placeholder="C1234abc..."></div>
      <button class="tbtn gold" onclick="saveSettings()" style="width:100%;padding:9px">💾 บันทึกการตั้งค่า</button>
    </div>
    <div class="setup-box"><h3>📥 Import สมาชิกกลุ่ม LINE</h3>
      <p style="font-size:11px;color:var(--muted);margin-bottom:10px">ดึงสมาชิกทุกคนเข้าระบบ (ต้องตั้ง LINE Token ก่อน)</p>
      <div class="fr"><label>Group ID</label><input class="inp" id="import-gid" style="width:100%" placeholder="C47afe023937001e60de63834046e64a5"></div>
      <button class="tbtn c" onclick="importGroup()" style="width:100%;padding:9px">📥 Import สมาชิกทั้งกลุ่ม</button>
      <div id="import-result" style="display:none;margin-top:8px;padding:8px;border-radius:6px;font-size:11px;background:var(--bg3)"></div>
    </div>
    <div class="setup-box"><h3>♻️ จัดการข้อมูล</h3>
      <div style="display:flex;flex-direction:column;gap:7px">
        <button class="tbtn" onclick="resetData('logs')" style="width:100%;text-align:left">🗑 ล้าง Event Log</button>
        <button class="tbtn" onclick="resetData('bets')" style="width:100%;text-align:left">🗑 ล้างรายการแทง</button>
        <button class="tbtn" onclick="resetData('slips')" style="width:100%;text-align:left">🗑 ล้างประวัติสลิป</button>
        <button class="tbtn r" onclick="resetData('all')" style="width:100%;text-align:left">⚠️ ล้างข้อมูลทั้งหมด</button>
      </div>
    </div>
  </div></div>
</div>

<!-- LOGS -->
<div id="p-logs" class="page">
  <div style="display:flex;gap:7px;margin-bottom:10px">
    <button class="tbtn" onclick="load()">↻ รีเฟรช</button>
    <button class="tbtn" onclick="resetData('logs')">🗑 ล้าง Log</button>
    <select class="inp" id="log-filter" onchange="renderLogs()" style="width:120px">
      <option value="">ทั้งหมด</option>
      <option value="bet">bet</option>
      <option value="result">result</option>
      <option value="slip">slip</option>
      <option value="topup">topup</option>
      <option value="open">open</option>
      <option value="close">close</option>
      <option value="msg">msg</option>
    </select>
  </div>
  <div class="panel"><div id="log-list" style="max-height:70vh;overflow-y:auto"></div></div>
</div>

</div></div></div>

<div class="toast" id="toast"><span id="tic">✅</span><span id="tmsg"></span></div>

<script>
const DICE=['','⚀','⚁','⚂','⚃','⚄','⚅'];
const TK='__TOKEN__';
let D={}, betFilter='all', dv=[0,0,0], selPlayerUid='', toastT;

async function api(p,body){
  const o={headers:{'x-admin-token':TK,'Content-Type':'application/json'}};
  if(body){o.method='POST';o.body=JSON.stringify(body);}
  try{const r=await fetch(p,o);return r.json();}catch{return {ok:false,error:'network error'};}
}

async function load(){
  D=await api('/api/data');
  if(!D||D.error){toast('❌ โหลดไม่ได้ — ตรวจสอบ token','e');return;}
  const s=D.stats||{};
  document.getElementById('hdr-round').textContent=s.currentRound||'—';
  document.getElementById('k-round').textContent=s.currentRound||'—';
  document.getElementById('k-pending').textContent=s.pendingBets||0;
  document.getElementById('k-players').textContent=s.totalPlayers||0;
  document.getElementById('k-profit').textContent=(s.houseProfit||0).toLocaleString();
  document.getElementById('k-deposit').textContent=(s.totalDeposit||0).toLocaleString();
  document.getElementById('k-slip-pending').textContent=s.pendingSlips||0;
  document.getElementById('k-slip-total').textContent=(s.totalSlipAmt||0).toLocaleString();
  document.getElementById('hdr-slip-badge').textContent=s.pendingSlips||0;
  document.getElementById('nb-bets').textContent=s.pendingBets||0;
  document.getElementById('nb-slips').textContent=s.pendingSlips||0;

  // stats slip page
  const slips=D.slips||[];
  const setEl=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  setEl('sk-pending', slips.filter(s=>s.status==='pending').length);
  setEl('sk-approved', slips.filter(s=>s.status==='approved').length);
  setEl('sk-rejected', slips.filter(s=>s.status==='rejected'||s.status==='duplicate').length);
  setEl('sk-total', slips.filter(s=>s.status==='approved').reduce((a,s)=>a+(s.ai?.amount||0),0).toLocaleString()+' ฿');

  const ot=document.getElementById('open-tag');
  ot.textContent=s.isOpen?'🟢 เปิดรับแทง':'🔴 ปิดรับแทง';
  ot.className='tag '+(s.isOpen?'tg':'tr');

  // slip settings
  if(D.settings){
    const el=document.getElementById('s-name');if(el)el.value=D.settings.botName||'Better Day';
    const eb=document.getElementById('s-balance');if(eb)eb.value=D.settings.startBalance||0;
    const eg=document.getElementById('s-gid');if(eg)eg.value=D.defaultGroupId||'';
    const sa=document.getElementById('sl-auto');if(sa)sa.value=D.settings.autoTopupSlip?'1':'0';
    const sm=document.getElementById('sl-min');if(sm)sm.value=D.settings.slipMinAmount||1;
  }

  renderDash(); renderBets(); renderRounds(); renderPlayers(); renderFinance(); renderSlips(); renderLogs(); renderKnownGroups();
  checkAIStatus();
}

async function checkAIStatus(){
  const r=await api('/health');
  const el=document.getElementById('ai-status');
  if(!el) return;
  if(r.aiEnabled){
    el.innerHTML='<span style="color:var(--grn)">✅ Anthropic API พร้อมใช้งาน</span>';
  } else {
    el.innerHTML='<span style="color:var(--red)">❌ ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY</span>';
  }
}

function fmt(ts){if(!ts)return'—';const d=new Date(ts);return d.toLocaleDateString('th-TH',{month:'short',day:'numeric'})+' '+d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});}

function renderDash(){
  const s=D.stats||{};
  // bets
  const bets=(D.bets||[]).filter(b=>b.status==='pending').slice(0,8);
  document.getElementById('d-betct').textContent=(s.pendingBets||0)+' รอผล';
  document.getElementById('d-bets').innerHTML=bets.length?bets.map(b=>\`<tr>
    <td style="color:var(--txt)">\${b.name}</td><td style="color:var(--muted)">\${b.memberId}</td>
    <td style="color:var(--gold)">\${b.round}</td>
    <td style="color:var(--muted);font-size:10px">\${(b.items||[]).map(i=>i.type+'='+i.amt).join(' ')}</td>
    <td style="color:var(--txt)">\${(b.total||0).toLocaleString()}</td>
    <td><span class="badge bb">รอผล</span></td>
  </tr>\`).join(''):'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:16px">ไม่มีรายการแทง</td></tr>';

  // slips dash
  const slips=(D.slips||[]).slice(0,4);
  document.getElementById('d-slips').innerHTML=slips.length?slips.map(sl=>slipCardHtml(sl,true)).join(''):'<div style="padding:12px;color:var(--muted);font-size:11px">ยังไม่มีสลิป</div>';

  // players
  const pls=(D.players||[]).sort((a,b)=>b.balance-a.balance).slice(0,8);
  document.getElementById('d-players').innerHTML=pls.map(p=>\`
    <div class="ri">
      <div class="av">\${p.name[0]||'?'}</div>
      <div style="flex:1;overflow:hidden">
        <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${p.name}</div>
        <div style="font-size:10px;color:var(--muted)">ID \${p.memberId}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:12px;font-weight:700;color:var(--gold)">\${p.balance.toLocaleString()}</div>
      </div>
    </div>\`).join('');

  // rounds
  document.getElementById('d-rounds').innerHTML=(D.rounds||[]).slice(0,5).map(r=>\`
    <div class="ri">
      <div style="width:36px;height:28px;background:var(--bg3);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--gold);flex-shrink:0">\${r.round}</div>
      <div style="flex:1"><div style="font-size:12px">\${DICE[r.d1]||r.d1} \${DICE[r.d2]||r.d2} \${DICE[r.d3]||r.d3} = \${r.sum}</div></div>
      <span class="badge \${r.label==='ต๊อก!'?'bpu':r.label==='สูง'?'br':'bb'}">\${r.label}</span>
    </div>\`).join('');

  // roll page bets
  const rb=(D.bets||[]).filter(b=>b.round===(D.stats?.currentRound));
  document.getElementById('r-betct').textContent=rb.length;
  document.getElementById('r-bets').innerHTML=rb.slice(0,12).map(b=>\`<tr>
    <td>\${b.name}</td>
    <td style="font-size:10px;color:var(--muted)">\${(b.items||[]).map(i=>i.type+'='+i.amt).join(' ')}</td>
    <td style="color:var(--gold)">\${(b.total||0).toLocaleString()}</td>
  </tr>\`).join('');
}

function slipCardHtml(sl, compact=false){
  const ai=sl.ai||{};
  const statusMap={pending:'⏳ รออนุมัติ',approved:'✅ อนุมัติแล้ว',rejected:'❌ ปฏิเสธ',duplicate:'⚠️ สลิปซ้ำ'};
  const statusColor={pending:'var(--gold)',approved:'var(--grn)',rejected:'var(--red)',duplicate:'var(--pur)'};
  const amt=ai.amount||0;
  const actions=(!compact && sl.status==='pending')?
    \`<div class="slip-actions">
      <select class="inp" id="slip-uid-\${sl.id}" style="flex:1;font-size:10px;padding:3px 6px">
        \${(D.players||[]).map(p=>\`<option value="\${p.uid}" \${sl.matchedPlayer?.uid===p.uid?'selected':''}>\${p.name}</option>\`).join('')}
      </select>
      <button class="tbtn g" onclick="approveSlip('\${sl.id}')" style="padding:4px 10px;font-size:11px">✅ อนุมัติ+เติมเงิน</button>
      <button class="tbtn r" onclick="rejectSlip('\${sl.id}')" style="padding:4px 8px;font-size:11px">❌</button>
    </div>\`:'';

  return \`<div class="slip-card \${sl.status}">
    <div class="slip-hd">
      <span class="slip-name">👤 \${sl.name}</span>
      <span class="slip-amt">\${amt.toLocaleString()} ฿</span>
    </div>
    <div class="slip-meta">
      🏦 \${ai.bankFrom||'—'} → \${ai.bankTo||'—'}<br>
      \${ai.senderName?'📤 '+ai.senderName+'<br>':''}\${ai.refNo?'📋 Ref: '+ai.refNo+'<br>':''}
      \${ai.datetime?'🕐 '+ai.datetime+'<br>':''}
      \${sl.matchedPlayer?'🎯 ผู้เล่น: <b style="color:var(--cyan)">'+sl.matchedPlayer.name+'</b><br>':''}
      <span style="color:\${statusColor[sl.status]||'var(--muted)'}">⚡ \${statusMap[sl.status]||sl.status}</span>
      · <span style="color:var(--muted)">\${fmt(sl.ts)}</span>
      \${ai.confidence?'· <span class="ai-badge">\${ai.confidence}</span>':''}
    </div>
    \${actions}
  </div>\`;
}

function renderSlips(){
  const f=document.getElementById('slip-filter')?.value||'';
  const slips=(D.slips||[]).filter(s=>!f||s.status===f);
  document.getElementById('slip-list').innerHTML=slips.length?slips.map(s=>slipCardHtml(s)).join(''):'<div style="color:var(--muted);text-align:center;padding:24px">ยังไม่มีสลิป</div>';
}

async function approveSlip(id){
  const uid=document.getElementById('slip-uid-'+id)?.value;
  const r=await api('/api/slip/approve',{slipId:id,uid,notify:true});
  if(r.ok){toast('✅ อนุมัติสลิปแล้ว เงินเพิ่ม '+r.balance?.toLocaleString());load();}
  else toast('❌ '+r.error,'e');
}
async function rejectSlip(id){
  const reason=prompt('เหตุผลที่ปฏิเสธ (ว่างได้):');
  const r=await api('/api/slip/reject',{slipId:id,reason,notify:true});
  if(r.ok){toast('✅ ปฏิเสธสลิปแล้ว');load();}
  else toast('❌ '+r.error,'e');
}

async function saveSlipSettings(){
  const autoTopup=document.getElementById('sl-auto')?.value==='1';
  const minAmt=parseInt(document.getElementById('sl-min')?.value)||1;
  const r=await api('/api/settings',{autoTopupSlip:autoTopup,slipMinAmount:minAmt});
  if(r.ok){toast('✅ บันทึกการตั้งค่าสลิปแล้ว');load();}else toast('❌ เกิดข้อผิดพลาด','e');
}

function renderBets(){
  const bets=(D.bets||[]).filter(b=>betFilter==='all'||b.status===betFilter);
  document.getElementById('bets-tb').innerHTML=bets.slice(0,100).map(b=>\`<tr>
    <td>\${b.name}</td><td style="color:var(--muted)">\${b.memberId}</td>
    <td style="color:var(--gold)">\${b.round}</td>
    <td style="font-size:10px;color:var(--muted)">\${(b.items||[]).map(i=>i.type+'='+i.amt).join(' ')}</td>
    <td>\${(b.total||0).toLocaleString()}</td>
    <td><span class="badge \${b.status==='pending'?'bb':'bg'}">\${b.status==='pending'?'รอผล':'เสร็จ'}</span></td>
    <td style="color:\${(b.net||0)>=0?'var(--grn)':'var(--red)'}">\${b.net!==undefined?(b.net>=0?'+':'')+b.net.toLocaleString():'—'}</td>
  </tr>\`).join('');
}

function renderRounds(){
  document.getElementById('rounds-tb').innerHTML=(D.rounds||[]).slice(0,50).map(r=>\`<tr>
    <td style="color:var(--gold)">\${r.round}</td>
    <td>\${DICE[r.d1]||r.d1} \${DICE[r.d2]||r.d2} \${DICE[r.d3]||r.d3}</td>
    <td>\${r.sum}</td>
    <td><span class="badge \${r.label==='ต๊อก!'?'bpu':r.label==='สูง'?'br':'bb'}">\${r.label}</span></td>
    <td style="color:var(--muted)">\${r.settled}</td>
    <td style="color:var(--muted);font-size:10px">\${fmt(r.ts)}</td>
  </tr>\`).join('');
}

function renderPlayers(){
  const pls=(D.players||[]).sort((a,b)=>b.balance-a.balance);
  document.getElementById('pl-count').textContent=pls.length+' คน';
  document.getElementById('players-tb').innerHTML=pls.map(p=>\`<tr>
    <td style="color:var(--muted)">\${p.memberId}</td>
    <td style="font-weight:600">\${p.name}</td>
    <td style="color:var(--gold);font-weight:700">\${p.balance.toLocaleString()}</td>
    <td style="color:var(--muted)">\${(p.totalBet||0).toLocaleString()}</td>
    <td style="color:var(--grn)">\${(p.totalWin||0).toLocaleString()}</td>
    <td style="color:var(--red)">\${(p.totalLoss||0).toLocaleString()}</td>
    <td><button class="tbtn" onclick="quickFinPlayer('\${p.uid}')" style="font-size:10px;padding:3px 8px">💳 เติม/ถอน</button></td>
  </tr>\`).join('');
}

function renderFinance(){
  const typeLabel={topup:'เติม',withdraw:'ถอน',slip:'สลิป AI'};
  const typeColor={topup:'var(--pur)',withdraw:'var(--red)',slip:'var(--cyan)'};
  document.getElementById('fin-tb').innerHTML=(D.deposits||[]).slice(0,60).map(d=>\`<tr>
    <td>\${d.name}</td>
    <td style="color:\${(d.amt||0)>=0?'var(--grn)':'var(--red)'};font-weight:700">\${(d.amt||0)>=0?'+':''}\${(d.amt||0).toLocaleString()}</td>
    <td><span class="badge" style="background:rgba(0,0,0,.2);color:\${typeColor[d.type]||'var(--muted)'}">\${typeLabel[d.type]||d.type}\${d.refNo?'<br><span style="font-size:9px;color:var(--muted)">'+d.refNo+'</span>':''}</span></td>
    <td style="color:var(--muted);font-size:10px">\${fmt(d.ts)}</td>
  </tr>\`).join('');
}

function renderLogs(){
  const f=document.getElementById('log-filter')?.value||'';
  const logs=(D.logs||[]).filter(l=>!f||l.type===f);
  const cls={bet:'lt-bet',result:'lt-result',open:'lt-open',close:'lt-close',topup:'lt-topup',slip:'lt-slip'};
  document.getElementById('log-list').innerHTML=logs.slice(0,200).map(l=>\`
    <div class="log-r">
      <span class="lt \${cls[l.type]||''}">\${l.type}</span>
      <span class="lm">\${l.msg}</span>
      <span style="color:var(--muted);font-size:10px;flex-shrink:0">\${fmt(l.ts)}</span>
    </div>\`).join('');
}

function renderKnownGroups(){
  const groups=new Set();
  (D.bets||[]).forEach(b=>b.groupId&&groups.add(b.groupId));
  if(D.defaultGroupId)groups.add(D.defaultGroupId);
  const el=document.getElementById('known-groups');if(!el)return;
  if(!groups.size){el.innerHTML='<span style="color:var(--muted)">ยังไม่มี Group ID</span>';return;}
  el.innerHTML=[...groups].map(g=>\`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <code style="flex:1;font-size:10px;color:var(--gold);background:var(--bg3);padding:4px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${g}</code>
      <button class="tbtn" onclick="usePushTarget('\${g}')" style="font-size:10px;padding:3px 8px">ใช้</button>
    </div>\`).join('');
}

function usePushTarget(gid){
  ['push-to','r-gid','q-gid'].forEach(id=>{const el=document.getElementById(id);if(el)el.value=gid;});
  toast('✅ เซ็ต Group ID แล้ว');
}

function quickFinPlayer(uid){
  selPlayerUid=uid;
  const p=(D.players||[]).find(x=>x.uid===uid);
  if(p){
    document.getElementById('fin-search').value=p.name;
    document.getElementById('fin-player-result').innerHTML=\`<div style="background:var(--bg3);border:1px solid var(--bdr2);border-radius:6px;padding:10px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--gold)">\${p.name}</div>
      <div style="font-size:11px;color:var(--muted)">ID: \${p.memberId} · เงิน: \${p.balance.toLocaleString()}</div></div>\`;
  }
  go('finance');
}

// dice
function rollOne(n){
  const v=Math.ceil(Math.random()*6);dv[n-1]=v;
  const el=document.getElementById('die'+n);
  el.classList.remove('spin');void el.offsetWidth;el.classList.add('spin');
  el.textContent=DICE[v];document.getElementById('md'+n).value=v;updSum();
}
function updDice(){[1,2,3].forEach(n=>{const v=+document.getElementById('md'+n).value;if(v>=1&&v<=6){dv[n-1]=v;document.getElementById('die'+n).textContent=DICE[v];}});updSum();}
function updSum(){
  const[d1,d2,d3]=dv;if(!d1||!d2||!d3){document.getElementById('dsum').textContent='—';document.getElementById('dlbl').textContent='—';return;}
  const sum=d1+d2+d3,triple=d1===d2&&d2===d3,hi=sum>=11;
  document.getElementById('dsum').textContent=sum;
  document.getElementById('dlbl').textContent=triple?'🎰 ต๊อก!':hi?'🔴 สูง':'🔵 ต่ำ';
}
function getGid(){return document.getElementById('r-gid')?.value.trim()||document.getElementById('q-gid')?.value.trim()||D.defaultGroupId||null;}

async function doRandom(){
  [1,2,3].forEach(n=>rollOne(n));await new Promise(r=>setTimeout(r,400));
  const r=await api('/api/roll',{random:true,groupId:getGid()});showRollResult(r);load();
}
async function doManual(){
  const[d1,d2,d3]=dv;if(!d1||!d2||!d3){toast('❌ คลิกลูกเต๋าสุ่มก่อน','e');return;}
  const r=await api('/api/roll',{d1,d2,d3,groupId:getGid()});showRollResult(r);load();
}
function showRollResult(r){
  if(!r.ok){toast('❌ เกิดข้อผิดพลาด','e');return;}
  const sum=r.d1+r.d2+r.d3,triple=r.d1===r.d2&&r.d2===r.d3,hi=sum>=11;
  let html=\`<div class="res-box"><div style="font-size:11px;color:var(--muted);margin-bottom:8px">\${DICE[r.d1]}\${DICE[r.d2]}\${DICE[r.d3]} = \${sum} (\${triple?'ต๊อก!':hi?'สูง':'ต่ำ'}) · ออกผล \${r.settled||0} รายการ</div>\`;
  (r.results||[]).forEach(x=>{const c=x.net>=0?'var(--grn)':'var(--red)';html+=\`<div class="res-r"><span>\${x.name}</span><span style="color:\${c};font-weight:700">\${x.net>=0?'+':''}\${x.net.toLocaleString()}</span></div>\`;});
  if(!r.results?.length)html+='<div style="color:var(--muted);font-size:11px">ไม่มีรายการเดิมพันรอบนี้</div>';
  html+='</div>';
  document.getElementById('r-result').innerHTML=html;
  toast('✅ ออกผลรอบเสร็จแล้ว'+(getGid()?' ส่งไป LINE แล้ว':''));
}

async function quickOpen(){const gid=getGid();const r=await api('/api/open',{groupId:gid});if(r.ok){toast('🟢 เปิดรับแทง รอบ '+r.round);load();}else toast('❌ เกิดข้อผิดพลาด','e');}
async function quickClose(){const gid=getGid();const r=await api('/api/close',{groupId:gid});if(r.ok){toast('🔴 ปิดรับแทง '+r.pendingBets+' รายการ');load();}else toast('❌ เกิดข้อผิดพลาด','e');}
async function quickPush(){
  const gid=getGid();const msg=document.getElementById('quick-msg')?.value.trim();
  if(!gid||!msg){toast('❌ ใส่ Group ID และข้อความ','e');return;}
  const r=await api('/api/push',{to:gid,message:msg});
  if(r.ok){toast('✅ ส่งข้อความแล้ว');document.getElementById('quick-msg').value='';}
  else toast('❌ ส่งไม่สำเร็จ','e');
}

function searchPlayer(){
  const q=document.getElementById('fin-search').value.toLowerCase();
  if(!q){selPlayerUid='';document.getElementById('fin-player-result').innerHTML='';return;}
  const found=(D.players||[]).find(p=>p.name.toLowerCase().includes(q)||String(p.memberId)===q);
  if(found){
    selPlayerUid=found.uid;
    document.getElementById('fin-player-result').innerHTML=\`<div style="background:var(--bg3);border:1px solid var(--bdr2);border-radius:6px;padding:10px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--gold)">\${found.name}</div>
      <div style="font-size:11px;color:var(--muted)">ID: \${found.memberId} · เงิน: \${found.balance.toLocaleString()}</div></div>\`;
  } else {
    selPlayerUid='';
    document.getElementById('fin-player-result').innerHTML='<div style="font-size:11px;color:var(--muted);margin-bottom:8px">ไม่พบผู้เล่น</div>';
  }
}

async function doTopup(){
  const amt=parseInt(document.getElementById('fin-amt').value);const notify=document.getElementById('fin-notify')?.checked;
  if(!selPlayerUid||!amt){toast('❌ เลือกผู้เล่นและใส่จำนวน','e');return;}
  const r=await api('/api/topup',{uid:selPlayerUid,amt,notify});
  if(r.ok){toast('✅ เติม '+amt.toLocaleString()+' แล้ว (รวม '+r.balance.toLocaleString()+')');load();}
  else toast('❌ เกิดข้อผิดพลาด','e');
}
async function doWithdraw(){
  const amt=parseInt(document.getElementById('fin-amt').value);const notify=document.getElementById('fin-notify')?.checked;
  if(!selPlayerUid||!amt){toast('❌ เลือกผู้เล่นและใส่จำนวน','e');return;}
  const r=await api('/api/withdraw',{uid:selPlayerUid,amt,notify});
  if(r.ok){toast('✅ ถอน '+amt.toLocaleString()+' แล้ว (เหลือ '+r.balance.toLocaleString()+')');load();}
  else toast('❌ เกิดข้อผิดพลาด','e');
}

async function doPush(){
  const to=document.getElementById('push-to').value.trim();const msg=document.getElementById('push-msg').value.trim();
  if(!to||!msg){toast('❌ ใส่ปลายทางและข้อความ','e');return;}
  const r=await api('/api/push',{to,message:msg});
  if(r.ok){toast('✅ ส่งข้อความแล้ว');document.getElementById('push-msg').value='';}
  else toast('❌ ส่งไม่สำเร็จ','e');
}

async function saveSettings(){
  const r=await api('/api/settings',{
    botName:document.getElementById('s-name')?.value?.trim()||'Better Day',
    startBalance:+document.getElementById('s-balance')?.value||0,
    slipMinAmount:+document.getElementById('s-slip-min')?.value||1,
    autoTopupSlip:document.getElementById('s-auto-slip')?.value==='1',
    autoReply:document.getElementById('s-auto-reply')?.value==='1',
    defaultGroupId:document.getElementById('s-gid')?.value?.trim()||'',
  });
  if(r.ok){toast('✅ บันทึกการตั้งค่าแล้ว');load();}else toast('❌ เกิดข้อผิดพลาด','e');
}
function togglePw(id){const el=document.getElementById(id);el.type=el.type==='password'?'text':'password';}
async function loadCredStatus(){
  const wh=document.getElementById('wh-url-text');if(wh)wh.textContent=window.location.origin+'/webhook';
  try{
    const d=await api('/api/credentials');if(!d?.ok)return;
    const ok=v=>\`<span style="color:var(--grn)">🟢 \${v}</span>\`,no=v=>\`<span style="color:var(--red)">🔴 \${v}</span>\`;
    const se=id=>document.getElementById(id);
    if(se('st-secret'))se('st-secret').innerHTML=d.lineSecret.set?ok(d.lineSecret.preview):no('ไม่ได้ตั้งค่า');
    if(se('st-token'))se('st-token').innerHTML=d.lineToken.set?ok(d.lineToken.preview):no('ไม่ได้ตั้งค่า');
    if(se('st-ai'))se('st-ai').innerHTML=d.anthropicKey.set?ok(d.anthropicKey.preview):no('ไม่ได้ตั้งค่า');
    if(d.runtimeActive?.token){
      try{const bd=await api('/api/bot-info');const bi=se('st-bot');
        if(bi)bi.innerHTML=bd.ok&&bd.info?ok(bd.info.displayName||'OK'):no('Token ผิด');}
      catch{const bi=se('st-bot');if(bi)bi.innerHTML=no('ตรวจไม่ได้');}
    }else{const bi=se('st-bot');if(bi)bi.innerHTML=no('ยังไม่ได้ตั้ง');}
  }catch(e){console.warn('loadCredStatus:',e);}
}
async function loadMongoStatus(){
  const el=document.getElementById('st-mongo'),el2=document.getElementById('mongo-status-box');
  try{
    const r=await api('/health');
    const ok=\`<span style="color:var(--grn)">🟢 เชื่อมต่อแล้ว</span>\`,no=\`<span style="color:var(--gold)">🟡 ใช้ db.json</span>\`;
    if(el)el.innerHTML=r.mongoConnected?ok:no;
    if(el2)el2.innerHTML=r.mongoConnected?'<span style="color:var(--grn)">🟢 MongoDB เชื่อมต่อแล้ว — ข้อมูลบันทึกถาวร</span>':'<span style="color:var(--gold)">🟡 ยังไม่ได้เชื่อมต่อ — ข้อมูลอาจหายเมื่อ restart</span>';
  }catch{if(document.getElementById('st-mongo'))document.getElementById('st-mongo').textContent='⬜ ตรวจไม่ได้';}
}
async function saveCreds(test=false){
  const secret=document.getElementById('c-secret').value.trim(),token=document.getElementById('c-token').value.trim();
  if(!secret&&!token){toast('❌ กรุณากรอก Secret หรือ Token','e');return;}
  const el=document.getElementById('cred-result');el.style.display='block';el.style.color='var(--muted)';
  el.textContent=test?'⏳ กำลังบันทึก + ทดสอบ...':'⏳ กำลังบันทึก...';
  const body={};if(secret)body.lineSecret=secret;if(token)body.lineToken=token;if(test)body.testConnection=true;
  const r=await api('/api/credentials',body);
  if(r?.ok){
    if(r.botInfo){const n=r.botInfo.displayName||'LINE Bot';el.style.color='var(--grn)';el.innerHTML=\`✅ เชื่อมต่อสำเร็จ! บอท: <b>\${n}</b>\`;toast('✅ LINE OA: '+n);}
    else if(r.testError){el.style.color='var(--gold)';el.textContent='⚠️ บันทึกแล้ว Token ยังไม่ถูกต้อง';}
    else{el.style.color='var(--grn)';el.textContent='✅ บันทึกแล้ว';toast('✅ บันทึกสำเร็จ');}
    document.getElementById('c-secret').value='';document.getElementById('c-token').value='';loadCredStatus();
  }else{el.style.color='var(--red)';el.textContent='❌ '+(r?.error||'ไม่สำเร็จ');toast('❌ บันทึกไม่สำเร็จ','e');}
}
async function saveAIKey(){
  const ai=document.getElementById('c-ai').value.trim();if(!ai){toast('❌ กรุณาใส่ API Key','e');return;}
  const el=document.getElementById('ai-result');el.style.display='block';el.style.color='var(--muted)';el.textContent='⏳ กำลังบันทึก...';
  const r=await api('/api/credentials',{anthropicKey:ai});
  if(r?.ok){el.style.color='var(--grn)';el.textContent='✅ AI Key บันทึกแล้ว';document.getElementById('c-ai').value='';toast('✅ Anthropic Key OK');loadCredStatus();}
  else{el.style.color='var(--red)';el.textContent='❌ '+(r?.error||'ไม่สำเร็จ');toast('❌ ไม่สำเร็จ','e');}
}
async function saveMongo(){
  const uri=document.getElementById('c-mongo').value.trim();if(!uri){toast('❌ กรุณาใส่ URI','e');return;}
  if(uri.includes('<password>')){toast('❌ แทนที่ <password> ก่อน','e');return;}
  const el=document.getElementById('mongo-result');el.style.display='block';el.style.color='var(--muted)';el.textContent='⏳ กำลังทดสอบ...';
  const r=await api('/api/mongo-uri',{mongoUri:uri});
  if(r?.ok){el.style.color='var(--grn)';el.textContent='✅ MongoDB OK: '+(r.dbName||'himangkorn');document.getElementById('c-mongo').value='';toast('✅ MongoDB OK');loadMongoStatus();}
  else{el.style.color='var(--red)';el.textContent='❌ '+(r?.error||'ไม่ได้');toast('❌ MongoDB error','e');}
}
async function importGroup(){
  const gid=document.getElementById('import-gid')?.value.trim()||'';
  const el=document.getElementById('import-result');el.style.display='block';el.style.color='var(--muted)';el.textContent='⏳ กำลังดึงสมาชิก...';
  const r=await api('/api/import-group',{groupId:gid});
  if(r?.ok){el.style.color='var(--grn)';el.textContent=\`✅ Import \${r.total} คน | ใหม่ \${r.added} | มีแล้ว \${r.existed}\`;toast('✅ Import '+r.added+' คนใหม่');load();}
  else{el.style.color='var(--red)';el.textContent='❌ '+(r?.error||'ไม่สำเร็จ');toast('❌ Import ไม่สำเร็จ','e');}
}

async function resetData(what){
  const msg={all:'ล้างข้อมูลทั้งหมด?',bets:'ล้างรายการแทงทั้งหมด?',logs:'ล้าง Event Log?',slips:'ล้างประวัติสลิป?'};
  if(!confirm(msg[what]||'ล้างข้อมูล?'))return;
  const r=await api('/api/reset',{what});if(r.ok){toast('✅ ล้างข้อมูลแล้ว');load();}
}

function cpWh(){navigator.clipboard.writeText(window.location.origin+'/webhook');toast('✅ คัดลอก Webhook URL แล้ว');}
function cpCode(btn){navigator.clipboard.writeText(btn.parentElement.innerText.replace('copy','').trim());toast('✅ คัดลอกแล้ว');}
function betTab(el,f){document.querySelectorAll('.tab-bar .tab').forEach(t=>t.classList.remove('on'));el.classList.add('on');betFilter=f;renderBets();}

let curP='dash';
function go(id,el){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.ni').forEach(n=>n.classList.remove('on'));
  document.getElementById('p-'+id).classList.add('on');
  if(el)el.classList.add('on');
  curP=id;
  if(id==='setup'){loadCredStatus();loadMongoStatus();}
}

function toast(msg,t){
  const el=document.getElementById('toast');
  document.getElementById('tic').textContent=t==='e'?'❌':'✅';
  document.getElementById('tmsg').textContent=msg;
  el.classList.add('on');clearTimeout(toastT);
  toastT=setTimeout(()=>el.classList.remove('on'),2800);
}

load();
loadCredStatus();
loadMongoStatus();
setInterval(load,8000);
</script></body></html>`;
