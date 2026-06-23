// ╔═══════════════════════════════════════════════════════════════╗
// ║  มารวย v5.0 — AI Slip Analyzer Edition                 ║
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
// ทุกค่าเปลี่ยนได้ runtime ผ่านหน้าเว็บ (ไม่ต้องตั้ง .env)
let SECRET        = process.env.LINE_CHANNEL_SECRET       || '';
let TOKEN         = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
let ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY         || '';
let MONGO_URI     = process.env.MONGODB_URI               || '';
// ADMIN_PW และ PORT เปลี่ยนได้เฉพาะผ่าน .env เท่านั้น (security)
const ADMIN_PW    = process.env.ADMIN_PASSWORD            || 'Maruay01';
const PORT        = process.env.PORT                      || 3000;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL       || '';

// ─── DB (MongoDB) ─────────────────────────────────────────────
const DEFAULT_DB = {
  players: {},
  bets: [],
  rounds: [],
  deposits: [],
  logs: [],
  slips: [],
  images: [],
  pendingResults: {},  // { groupId: { d1,d2,d3, ts, round } }
  adminUsers: [],      // [ { id, username, name, passwordHash, role, lastLogin } ]
  currentRound: 155,
  isOpen: false,
  defaultGroupId: '',
  settings: {
    startBalance: 0,
    botName: 'มารวย',
    autoReply: true,
    autoTopupSlip: true,
    slipMinAmount: 1,
    serverBaseUrl: '',
    // slip verification settings
    receiverAccountName: '',   // ชื่อบัญชีปลายทางที่ถูกต้อง (เช่น "นายสมชาย ใจดี")
    receiverBankName: '',      // ธนาคารปลายทาง (เช่น "กสิกรไทย" หรือ "")  
    slipMaxAgeMinutes: 60,     // สลิปเก่าเกินกี่นาทีให้ปฏิเสธ (0=ไม่ตรวจ)
    requireReceiverMatch: false, // บังคับตรวจชื่อบัญชีปลายทาง
  }
};

let _mongoClient = null;
let _db          = null;
let _mongoOk     = false;

// ── โหลด credentials ทั้งหมดจาก DB → อัปเดต runtime ทันที ──
async function loadCredsFromDB() {
  try {
    const col = await getMongoCol(); if (!col) return;
    const doc = await col.findOne({ _id:'main' });
    const s = doc?.settings || {};
    const cr = s.credentials || {};
    if (cr.lineSecret)   SECRET        = cr.lineSecret;
    if (cr.lineToken)    TOKEN         = cr.lineToken;
    if (cr.anthropicKey) ANTHROPIC_KEY = cr.anthropicKey;
    console.log('🔑 credentials loaded — secret:%s token:%s ai:%s', !!SECRET, !!TOKEN, !!ANTHROPIC_KEY);
  } catch(e) { console.warn('loadCreds:', e.message); }
}

async function getMongoCol() {
  if (!MONGO_URI) return null;
  if (_mongoClient && !_mongoOk) {
    try { await _mongoClient.close(); } catch {}
    _mongoClient = null; _db = null;
  }
  if (!_mongoClient) {
    _mongoClient = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS:8000, connectTimeoutMS:8000,
    });
    await _mongoClient.connect();
    _db = _mongoClient.db('himangkorn');
    _mongoOk = true;
    _mongoClient.on('close',()=>{ _mongoOk=false; console.warn('⚠️  MongoDB disconnected'); });
    _mongoClient.on('error',()=>{ _mongoOk=false; });
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
  } catch(e) { _mongoOk=false; console.error('❌ readDB:', e.message); }
  const DB_PATH = path.join(__dirname, 'db.json');
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  try {
    const raw = JSON.parse(fs.readFileSync(DB_PATH,'utf8'));
    return { ...DEFAULT_DB, ...raw, settings:{ ...DEFAULT_DB.settings, ...(raw.settings||{}) } };
  } catch { return { ...DEFAULT_DB }; }
}

async function saveDB(db) {
  try {
    const col = await getMongoCol();
    if (col) {
      await col.replaceOne({ _id:'main' }, { _id:'main', ...db }, { upsert:true });
      return;
    }
  } catch(e) { _mongoOk=false; console.error('❌ saveDB:', e.message); }
  const DB_PATH = path.join(__dirname, 'db.json');
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch {}
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
  // ทุนถูกหักตอนแทงแล้ว:
  //   ชนะ → balance += ทุน + กำไร
  //   แพ้  → บันทึก totalLoss เท่านั้น (ทุนหักไปแล้ว)
  const results = [];
  const pending = db.bets.filter(b => b.round===round && b.status==='pending');
  for (const bet of pending) {
    let profit = 0;
    for (const b of bet.items) {
      const raw = calcBet(b.type, b.amt, d1, d2, d3);
      b.win    = raw > 0;
      b.profit = raw > 0 ? raw : 0;
      b.net    = raw > 0 ? raw : -b.amt;
      b.result = raw > 0 ? 'ชนะ' : 'แพ้';
      profit  += b.profit;
    }
    bet.status = 'settled';
    bet.net    = profit > 0 ? profit : -bet.total;
    const p = db.players[bet.uid];
    if (p) {
      if (profit > 0) {
        p.balance  += bet.total + profit;  // คืนทุน + กำไร
        p.totalWin += profit;
      } else {
        p.totalLoss += bet.total;          // บันทึกการเสียเท่านั้น
      }
    }
    results.push({ uid:bet.uid, name:bet.name, memberId:bet.memberId,
      net:bet.net, balance:db.players[bet.uid]?.balance||0 });
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
async function analyzeSlipWithAI(base64Image, contentType, playerNames, settings = {}) {
  if (!ANTHROPIC_KEY) {
    return { ok: false, error: 'ไม่ได้ตั้งค่า ANTHROPIC_API_KEY' };
  }

  const nameList = playerNames.length > 0
    ? `\nรายชื่อผู้เล่นในระบบ: ${playerNames.join(', ')}`
    : '';

  const receiverHint = settings.receiverAccountName
    ? `\nบัญชีปลายทางที่ถูกต้องของห้อง: "${settings.receiverAccountName}"` +
      (settings.receiverBankName ? ` (${settings.receiverBankName})` : '')
    : '';

  const prompt = `คุณเป็นผู้เชี่ยวชาญอ่านสลิปโอนเงินธนาคารไทย วิเคราะห์สลิปในภาพนี้และตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น
${nameList}${receiverHint}

กฎการวิเคราะห์:
1. อ่านชื่อผู้รับเงิน (receiverName) ให้ถูกต้อง แม้จะถูกซ่อนบางส่วน
2. อ่านวันเวลา (datetime) ให้เป็น ISO8601 เช่น "2025-06-09T22:47:00"
3. ถ้า${settings.receiverAccountName ? `ชื่อผู้รับไม่ตรงกับ "${settings.receiverAccountName}"` : 'ชื่อผู้รับไม่ชัดเจน'} ให้ใส่ receiverMatch: false
4. ถ้าเป็นสลิปปลอม/ภาพหน้าจอซ้อน/แก้ไข ให้ isSuspicious: true
5. อ่านเลข Ref/รหัสอ้างอิงให้ครบถ้วน

ตอบ JSON รูปแบบนี้เท่านั้น:
{
  "isSlip": true/false,
  "amount": ตัวเลขยอดโอน (ไม่มีหน่วย ไม่มี comma),
  "senderName": "ชื่อผู้โอน",
  "receiverName": "ชื่อผู้รับ (อ่านให้ครบ)",
  "bankFrom": "ธนาคารต้นทาง",
  "bankTo": "ธนาคารปลายทาง",
  "datetime": "ISO8601 หรือ null ถ้าอ่านไม่ได้",
  "refNo": "เลขอ้างอิง/รหัสธุรกรรม",
  "receiverMatch": true/false,
  "isSuspicious": true/false,
  "matchedPlayer": "ชื่อผู้เล่นในระบบที่ตรงกัน หรือ null",
  "confidence": "high/medium/low",
  "note": "หมายเหตุ เช่น เหตุผลที่สงสัย"
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

// ─── Flex Messages การแทง ────────────────────────────────────
function betFlex(name, bets, bal, total, label='แทง ✅') {
  const betRows = bets.map(b => ({
    type:'box', layout:'horizontal', paddingTop:'3px', paddingBottom:'3px',
    contents: [
      { type:'text', text: b.type, size:'sm', color:'#333', flex:3 },
      { type:'text', text: b.amt.toLocaleString(), size:'sm', color:'#555', flex:2, align:'end' }
    ]
  }));
  return {
    type:'flex', altText:`${name} ${label} รวม ${(total||0).toLocaleString()} บาท`,
    contents: {
      type:'bubble', size:'kilo',
      header: {
        type:'box', layout:'horizontal', backgroundColor:'#27AE60', paddingAll:'10px',
        contents: [
          { type:'text', text: name.length>16?name.slice(0,15)+'…':name, size:'sm', color:'#fff', weight:'bold', flex:3 },
          { type:'text', text: label, size:'sm', color:'#e8f5e9', align:'end', flex:2 }
        ]
      },
      body: {
        type:'box', layout:'vertical', paddingAll:'10px', spacing:'none', backgroundColor:'#f9fffe',
        contents: [
          ...betRows,
          { type:'separator', color:'#2ECC71', margin:'sm' },
          { type:'box', layout:'horizontal', margin:'sm', contents: [
            { type:'text', text:'รวม', size:'sm', color:'#555', flex:2 },
            { type:'text', text:`${(total||0).toLocaleString()} บาท`, size:'sm', color:'#333', flex:2, align:'end', weight:'bold' }
          ]},
          { type:'box', layout:'horizontal', margin:'xs', contents: [
            { type:'text', text:'💳 คงเหลือ', size:'sm', color:'#27AE60', flex:2, weight:'bold' },
            { type:'text', text:`${bal.toLocaleString()} บาท`, size:'md', color:'#27AE60', flex:2, align:'end', weight:'bold' }
          ]}
        ]
      }
    }
  };
}
// fallback text (ใช้ใน log)
const betReply   = (name,bets,bal,total) => `${name} แทง ✅\n${bets.map(b=>`  ${b.type} = ${b.amt.toLocaleString()}`).join('\n')}\n─────────────\nรวม: ${(total||0).toLocaleString()} บาท\n💳 คงเหลือ: ${bal.toLocaleString()} บาท`;
const extraReply = (name,bets,bal,total) => `${name} เพิ่ม ✅\n${bets.map(b=>`  ${b.type} = ${b.amt.toLocaleString()}`).join('\n')}\n─────────────\nรวม: ${(total||0).toLocaleString()} บาท\n💳 คงเหลือ: ${bal.toLocaleString()} บาท`;
const winReply   = (name,id,bets,bal) => `🏆 ${name} ชนะ!\n${bets.map(b=>`  ${b.type}: +${(b.profit||b.amt).toLocaleString()}`).join('\n')}\n💰 คงเหลือ: ${bal.toLocaleString()} บาท`;
const loseReply  = (name,id,bal)    => `😔 ${name} เสีย\n💳 คงเหลือ: ${bal.toLocaleString()} บาท`;

// ─── ออกผลพร้อมส่งกลับกลุ่ม ──────────────────────────────────
// ─── SCORE - HILO (สกอร์ย้อนหลัง) ─────────────────────────────
function buildScoreText(rounds, count = 10) {
  const DE = ['','⚀','⚁','⚂','⚃','⚄','⚅'];
  const recent = rounds.slice(0, count);
  if (!recent.length) return 'SCORE - HILO\nยังไม่มีผลย้อนหลัง';
  const lines = recent.map(r => {
    const lbl = r.label === 'ต๊อก!' ? 'ต๊อก' : r.label;
    return `เปิดที่ ${r.round} ผลออก ${lbl}  ${DE[r.d1]||r.d1} ${DE[r.d2]||r.d2} ${DE[r.d3]||r.d3}`;
  });
  return `SCORE - HILO\n${'─'.repeat(28)}\n${lines.join('\n')}`;
}

// ─── Flex Message สรุปผลรอบ (ตารางสีเขียวมีกรอบ ตามภาพ) ─────────
function buildSummaryFlex(db, round, results, botName, d1, d2, d3, label) {
  const name     = botName || 'มารวย';
  const DE       = ['','⚀','⚁','⚂','⚃','⚄','⚅'];
  const diceStr  = `${DE[d1]||d1} ${DE[d2]||d2} ${DE[d3]||d3}`;
  const sum      = d1 + d2 + d3;

  // คำนวณกำไรห้อง
  let houseNet = 0;
  results.forEach(r => { houseNet -= r.net; });
  const totalBet = results.reduce((s,r) => s + Math.abs(r.net), 0);
  const hSign = houseNet >= 0 ? '+' : '';

  // แถวผู้เล่น แบ่งเป็นชุด (LINE Flex จำกัดความสูง → แบ่งออกเป็นหลายข้อความถ้าเยอะ)
  const rowComponents = results.map((r, i) => {
    const rowNum = (r._idx !== undefined ? r._idx : i) + 1;
    const sign    = r.net >= 0 ? '+' : '';
    const netColor = r.net >= 0 ? '#00C851' : '#ff4444';
    const shortName = r.name.length > 14 ? r.name.slice(0,13) + '…' : r.name;
    return {
      type: 'box', layout: 'horizontal',
      paddingTop: '4px', paddingBottom: '4px',
      borderWidth: '1px', borderColor: '#2ECC71',
      contents: [
        {
          type: 'text', text: `${i+1})${shortName}`,
          size: 'xs', color: '#1a1a1a', flex: 5,
          weight: 'bold', wrap: false, adjustMode: 'shrink-to-fit'
        },
        {
          type: 'text', text: `${sign}${r.net.toLocaleString()}`,
          size: 'xs', color: netColor, flex: 3, align: 'end', weight: 'bold'
        },
        {
          type: 'text', text: `= ${r.balance.toLocaleString()}`,
          size: 'xs', color: '#333333', flex: 3, align: 'end'
        }
      ]
    };
  });

  // แถว footer: ม้วนกำไร
  const footerRow = results.length > 0 ? {
    type: 'box', layout: 'horizontal',
    paddingTop: '6px', paddingBottom: '2px',
    backgroundColor: '#e8f5e9',
    contents: [
      {
        type: 'text',
        text: `ม้วนกำไร/${totalBet.toLocaleString()}`,
        size: 'xs', color: '#1B5E20', flex: 5, weight: 'bold'
      },
      {
        type: 'text',
        text: `${hSign}${Math.round(houseNet).toLocaleString()}`,
        size: 'xs', color: houseNet >= 0 ? '#00C851' : '#ff4444',
        flex: 6, align: 'end', weight: 'bold'
      }
    ]
  } : null;

  const bodyContents = [
    // header แถวชื่อคอลัมน์
    {
      type: 'box', layout: 'horizontal',
      backgroundColor: '#27AE60',
      paddingTop: '5px', paddingBottom: '5px',
      contents: [
        { type:'text', text:'ชื่อ', size:'xs', color:'#ffffff', flex:5, weight:'bold' },
        { type:'text', text:'ผล', size:'xs', color:'#ffffff', flex:3, align:'end', weight:'bold' },
        { type:'text', text:'คงเหลือ', size:'xs', color:'#ffffff', flex:3, align:'end', weight:'bold' },
      ]
    },
    // separator
    { type:'separator', color:'#2ECC71' },
    // rows
    ...rowComponents,
  ];

  if (footerRow) {
    bodyContents.push({ type:'separator', color:'#2ECC71' });
    bodyContents.push(footerRow);
  }

  if (results.length === 0) {
    bodyContents.push({
      type:'text', text:'ไม่มีรายการเดิมพันรอบนี้',
      size:'sm', color:'#888888', align:'center', margin:'md'
    });
  }

  const flexMsg = {
    type: 'flex',
    altText: `${name} สรุปรอบ #${round} | ${label}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#2ECC71',
        paddingAll: '10px',
        contents: [
          {
            type: 'box', layout: 'horizontal',
            contents: [
              { type:'text', text: name, size:'md', color:'#ffffff', weight:'bold', flex:3 },
              { type:'text', text:`${diceStr}  ${sum}`, size:'md', color:'#ffffff', align:'end', flex:2, weight:'bold' }
            ]
          },
          {
            type: 'box', layout: 'horizontal', marginTop: '2px',
            contents: [
              { type:'text', text:`สรุปรอบ #${round}`, size:'sm', color:'#e8f5e9', flex:3 },
              { type:'text', text: label, size:'sm', color:'#ffffff', align:'end', flex:2, weight:'bold' }
            ]
          }
        ]
      },
      body: {
        type: 'box', layout: 'vertical',
        backgroundColor: '#f9fffe',
        paddingAll: '8px',
        spacing: 'none',
        contents: bodyContents
      },
      styles: {
        header: { backgroundColor: '#2ECC71' },
        body:   { backgroundColor: '#f9fffe' },
        footer: { separator: false }
      }
    }
  };
  return flexMsg;
}

// fallback text สำหรับ altText / ระบบที่ไม่รองรับ Flex
function buildSummaryText(db, round, results, botName) {
  const name = botName || 'มารวย';
  const lines = [`${name}`, `สรุปรอบ #${round}`, ''];
  let houseNet = 0;
  results.forEach((r, i) => {
    const sign = r.net >= 0 ? '+' : '';
    lines.push(`${i+1})${r.name}  ${sign}${r.net.toLocaleString()} = ${r.balance.toLocaleString()}`);
    houseNet -= r.net;
  });
  if (results.length === 0) {
    lines.push('ไม่มีรายการเดิมพันรอบนี้');
  } else {
    const totalBet = results.reduce((s,r) => s + Math.abs(r.net), 0);
    const hSign = houseNet >= 0 ? '+' : '';
    lines.push('');
    lines.push(`ม้วนกำไร/${totalBet.toLocaleString()}  ${hSign}${Math.round(houseNet).toLocaleString()}`);
  }
  return lines.join('\n');
}

// ─── Flex Message ยืนยันผล (ตรวจสอบผลที่ออก) ────────────────
function buildConfirmFlex(round, d1, d2, d3, sum, lbl, DE) {
  const lblColor = lbl==='สูง'?'#c0392b':lbl==='ต่ำ'?'#2980b9':'#8e44ad';
  return {
    type: 'flex',
    altText: `ตรวจสอบผลที่ออก รอบ ${round} — ยืนยัน y หรือ N`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type:'box', layout:'vertical', backgroundColor:'#2c3e50', paddingAll:'12px',
        contents: [
          { type:'text', text:'ตรวจสอบผลที่ออก', size:'md', color:'#ecf0f1', weight:'bold', align:'center' },
          { type:'text', text:`เปิดที่ ${round}`, size:'sm', color:'#95a5a6', align:'center', margin:'xs' }
        ]
      },
      body: {
        type:'box', layout:'vertical', paddingAll:'16px', spacing:'md', backgroundColor:'#f8f9fa',
        contents: [
          { type:'text', text:'สรุปผลไฮโล', size:'sm', color:'#888', align:'center' },
          {
            type:'box', layout:'horizontal', margin:'sm', justifyContent:'center', spacing:'lg',
            contents: [
              { type:'text', text: DE[d1]||String(d1), size:'xxl', align:'center', flex:1 },
              { type:'text', text: DE[d2]||String(d2), size:'xxl', align:'center', flex:1 },
              { type:'text', text: DE[d3]||String(d3), size:'xxl', align:'center', flex:1 }
            ]
          },
          {
            type:'box', layout:'horizontal', margin:'sm',
            contents: [
              { type:'text', text:`${d1} + ${d2} + ${d3} = ${sum}`, size:'md', color:'#333', flex:3, align:'center', weight:'bold' },
              { type:'text', text: lbl, size:'lg', color: lblColor, flex:2, align:'center', weight:'bold' }
            ]
          },
          { type:'separator', color:'#dee2e6', margin:'md' },
          { type:'text', text:'ยืนยันแผลสรุป  y  หรือ  Y', size:'sm', color:'#27AE60', align:'center', weight:'bold', margin:'md' },
          { type:'text', text:'พิมพ์  n  หรือ  N  เพื่อยกเลิก', size:'xs', color:'#aaa', align:'center' }
        ]
      }
    }
  };
}

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

  // ── สรุปผลรอบ Flex Message (ตารางสีเขียวมีกรอบ) ──
  if (target) {
    await delay(400);
    const botName = db.settings?.botName || 'มารวย';
    // แบ่งผู้เล่นเป็นชุดๆ ละ 25 คน (LINE Flex มีจำกัด)
    const CHUNK = 25;
    const chunks = [];
    for (let i = 0; i < Math.max(results.length, 1); i += CHUNK) {
      chunks.push(results.slice(i, i + CHUNK));
    }
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkResults = chunks[ci];
      const isLast = ci === chunks.length - 1;
      // offset index สำหรับ chunk ที่ 2, 3, ...
      const offsetResults = chunkResults.map((r, i) => ({ ...r, _idx: ci * CHUNK + i }));
      const flexMsg = buildSummaryFlex(
        db, prevRound,
        offsetResults.map(r => ({ ...r })),
        botName + (chunks.length > 1 ? ` (${ci+1}/${chunks.length})` : ''),
        d1, d2, d3, label
      );
      await pushMsg(target, [flexMsg]);
      if (!isLast) await delay(300);
    }
  }
  return results;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ─── ดึงสมาชิกกลุ่ม LINE ────────────────────────────────────
async function importGroupMembers(db, groupId) {
  if (!TOKEN || !groupId) return { added:0, existed:0, total:0 };
  let start = null, added = 0, existed = 0;
  // LINE API ดึงได้ทีละ 100 คน วน loop จนหมด
  while (true) {
    const path = start
      ? `/v2/bot/group/${groupId}/members?start=${start}`
      : `/v2/bot/group/${groupId}/members`;
    const page = await new Promise(res => {
      const req = require('https').request({
        hostname:'api.line.me', path, method:'GET',
        headers:{ Authorization:`Bearer ${TOKEN}` }
      }, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{ try{res(JSON.parse(b));}catch{res({});} }); });
      req.on('error',()=>res({})); req.end();
    });
    const members = page.members || [];
    for (const m of members) {
      if (!m.userId) continue;
      if (db.players[m.userId]) {
        db.players[m.userId].groupId = groupId;
        existed++;
      } else {
        const cnt = Object.keys(db.players).length + 1;
        db.players[m.userId] = {
          name: m.displayName || `สมาชิก${cnt}`,
          uid: m.userId, memberId: cnt,
          balance: db.settings?.startBalance || 0,
          totalBet:0, totalWin:0, totalLoss:0,
          joinedAt: new Date().toISOString(), groupId,
        };
        added++;
      }
    }
    if (page.next) { start = page.next; }
    else break;
  }
  addLog(db, 'join', `Import กลุ่ม ${groupId}: เพิ่ม ${added} / มีแล้ว ${existed}`);
  return { added, existed, total: added + existed };
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
        const ai = await analyzeSlipWithAI(base64, contentType, playerNames, db.settings);

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

        // ── ตรวจ AI ผิดพลาด / ไม่ใช่สลิป ──
        if (!ai.ok || !ai.isSlip) {
          slipRecord.status = 'rejected';
          addLog(db, 'slip', `${name} สลิปไม่ถูกต้อง: ${ai.error || 'ไม่ใช่สลิป'}`, uid);
          db.slips.unshift(slipRecord);
          if (db.settings.autoReply) {
            await pushMsg(srcId, [txtMsg(`❌ ไม่พบข้อมูลสลิปในรูปภาพ\nกรุณาส่งรูปสลิปชัดๆ`)]);
          }
          await saveDB(db); continue;
        }

        // ── ตรวจสลิปน่าสงสัย (ปลอม/แก้ไข) ──
        if (ai.isSuspicious) {
          slipRecord.status = 'rejected';
          addLog(db, 'slip', `${name} ⚠️ สลิปน่าสงสัย: ${ai.note || 'AI ตรวจพบความผิดปกติ'}`, uid);
          db.slips.unshift(slipRecord);
          if (db.settings.autoReply) {
            await pushMsg(srcId, [txtMsg(`❌ สลิปไม่ถูกต้อง\n${ai.note || 'ตรวจพบความผิดปกติ'}\nกรุณาส่งสลิปที่ถูกต้อง`)]);
          }
          await saveDB(db); continue;
        }

        // ── ตรวจบัญชีปลายทาง ──
        if (db.settings.requireReceiverMatch && db.settings.receiverAccountName) {
          if (ai.receiverMatch === false) {
            slipRecord.status = 'rejected';
            const correctName = db.settings.receiverAccountName;
            addLog(db, 'slip', `${name} ❌ บัญชีปลายทางไม่ตรง: "${ai.receiverName}" ≠ "${correctName}"`, uid);
            db.slips.unshift(slipRecord);
            if (db.settings.autoReply) {
              await pushMsg(srcId, [txtMsg(
                `❌ บัญชีปลายทางไม่ตรง\n` +
                `ผู้รับในสลิป: ${ai.receiverName || '—'}\n` +
                `บัญชีที่ถูกต้อง: ${correctName}\n\n` +
                `กรุณาโอนมาที่บัญชีที่ถูกต้อง แล้วส่งสลิปใหม่`
              )]);
            }
            await saveDB(db); continue;
          }
        }

        // ── ตรวจอายุสลิป (สลิปเก่าเกินกำหนด) ──
        const maxAge = db.settings.slipMaxAgeMinutes || 0;
        if (maxAge > 0 && ai.datetime) {
          try {
            const slipTime = new Date(ai.datetime);
            const nowTime  = new Date();
            const diffMin  = (nowTime - slipTime) / 60000;
            if (!isNaN(diffMin) && diffMin > maxAge) {
              slipRecord.status = 'rejected';
              addLog(db, 'slip', `${name} ❌ สลิปเก่าเกิน ${maxAge} นาที (${Math.floor(diffMin)} นาที)`, uid);
              db.slips.unshift(slipRecord);
              if (db.settings.autoReply) {
                await pushMsg(srcId, [txtMsg(
                  `❌ สลิปหมดอายุ\n` +
                  `สลิปนี้โอนเมื่อ: ${ai.datetime}\n` +
                  `ระบบรับสลิปไม่เกิน ${maxAge} นาที\n\n` +
                  `กรุณาโอนใหม่และส่งสลิปภายใน ${maxAge} นาที`
                )]);
              }
              await saveDB(db); continue;
            }
          } catch(e) { /* parse error — ข้ามการตรวจอายุ */ }
        }

        // ── ตรวจสลิปซ้ำ (refNo ซ้ำ) ──
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

        // ── ตรวจยอดต่ำกว่าขั้นต่ำ ──
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

          // format ตรงตามที่เห็นในกลุ่ม LINE (รายการเงินเข้า)
          const replyText =
            `💚 รายการเงินเข้า\n` +
            `────────────────\n` +
            `ID : ${matchedPlayer.memberId}\n` +
            `คงเหลือ : ${matchedPlayer.balance.toLocaleString()} 💰\n` +
            (ai.refNo ? `Ref #${ai.refNo}` : '');

          // แจ้งห้อง (groupId) ถ้ามี หรือ 1:1
          const announceText =
            `Hi.มังกร 💚\n` +
            `${matchedPlayer.name}\n` +
            `ID : ${matchedPlayer.memberId}\n` +
            `เงินคงเหลือ = ${matchedPlayer.balance.toLocaleString()} 🍃`;

          await pushMsg(srcId, [txtMsg(replyText)]);
          // ถ้ามี defaultGroupId ให้ประกาศในกลุ่มด้วย
          if (groupId && groupId !== uid) {
            await pushMsg(groupId, [txtMsg(announceText)]);
          }
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

      // ── แก้ไขชื่อตัวเอง: ชื่อ ชื่อใหม่ ─────────────────────
      const renameM = text.match(/^ชื่อ\s+(.+)$/);
      if (renameM) {
        const newName = renameM[1].trim();
        if (newName.length < 2 || newName.length > 20) {
          await replyMsg(replyTk, [txtMsg('❌ ชื่อต้องมี 2-20 ตัวอักษร')]);
        } else {
          player.name = newName;
          addLog(db, 'msg', `${name} เปลี่ยนชื่อเป็น ${newName}`, uid);
          await replyMsg(replyTk, [txtMsg(`✅ เปลี่ยนชื่อเป็น "${newName}" แล้ว`)]);
        }
        await saveDB(db); continue;
      }

      // เช็คยอด
      if (/^(ยอด|เงิน|balance|คงเหลือ)$/i.test(lower)) {
        const pend = db.bets.filter(b=>b.uid===uid&&b.status==='pending').reduce((s,b)=>s+b.total,0);
        const balFlex = {
          type: 'flex', altText: `ยอดเงิน ${player.name}: ${player.balance.toLocaleString()} บาท`,
          contents: {
            type: 'bubble', size: 'kilo',
            body: {
              type: 'box', layout: 'vertical', backgroundColor: '#f0fff4',
              paddingAll: '16px', spacing: 'sm',
              contents: [
                { type: 'text', text: '💳 ยอดเงินคงเหลือ', size: 'sm', color: '#27AE60', weight: 'bold' },
                { type: 'separator', margin: 'sm', color: '#2ECC71' },
                { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
                  { type: 'text', text: player.name, size: 'md', weight: 'bold', color: '#1a1a1a', flex: 3 },
                  { type: 'text', text: `ID ${player.memberId}`, size: 'sm', color: '#888', align: 'end', flex: 2 }
                ]},
                { type: 'text', text: player.balance.toLocaleString() + ' บาท',
                  size: 'xxl', weight: 'bold', color: '#27AE60', align: 'center', margin: 'md' },
                ...(pend > 0 ? [{
                  type: 'text', text: `⏳ รอผล: ${pend.toLocaleString()} บาท`,
                  size: 'sm', color: '#E67E22', align: 'center'
                }] : [])
              ]
            }
          }
        };
        await replyMsg(replyTk, [balFlex]);
        await saveDB(db); continue;
      }

      // อันดับ
      if (/^(อันดับ|rank|top)$/i.test(lower)) {
        const sorted = Object.values(db.players).sort((a,b)=>b.balance-a.balance).slice(0,10);
        const medals = ['🥇','🥈','🥉'];
        const rankRows = sorted.map((p,i) => ({
          type:'box', layout:'horizontal', paddingTop:'5px', paddingBottom:'5px',
          contents: [
            { type:'text', text: medals[i]||`${i+1}.`, size:'sm', flex:1 },
            { type:'text', text: p.name.length>14?p.name.slice(0,13)+'…':p.name, size:'sm', color:'#1a1a1a', flex:5, weight: i<3?'bold':'regular' },
            { type:'text', text: p.balance.toLocaleString(), size:'sm', color: i===0?'#f39c12':i===1?'#95a5a6':'#c0392b', flex:3, align:'end', weight:'bold' }
          ]
        }));
        const rankFlex = {
          type:'flex', altText:'🏆 อันดับเงิน Top 10',
          contents: {
            type:'bubble', size:'mega',
            header: {
              type:'box', layout:'horizontal', backgroundColor:'#f39c12', paddingAll:'10px',
              contents: [
                { type:'text', text:'🏆 อันดับเงิน', size:'md', color:'#fff', weight:'bold' },
                { type:'text', text:'Top 10', size:'sm', color:'#fff3cd', align:'end' }
              ]
            },
            body: {
              type:'box', layout:'vertical', paddingAll:'10px', spacing:'none',
              contents: sorted.length ? rankRows : [{ type:'text', text:'ยังไม่มีผู้เล่น', size:'sm', color:'#aaa', align:'center' }]
            }
          }
        };
        await replyMsg(replyTk, [rankFlex]);
        await saveDB(db); continue;
      }

      // วิธีแทง
      if (/^(วิธีแทง|วิธีเล่น|คำสั่ง|help|\?)$/i.test(lower)) {
        await replyMsg(replyTk, [txtMsg(
          `📋 วิธีแทง มารวย\n` +
          `${'─'.repeat(22)}\n` +
          `สูง=100  ต่ำ=200\n` +
          `คู่=100  คี่=100\n` +
          `45=100  (คู่ตาย)\n` +
          `456=50  (สามตัว)\n` +
          `444=100 (ต๊อก)\n` +
          `9=200   (ผลรวม)\n` +
          `6ส=100  (ตัวสูง)\n` +
          `${'─'.repeat(22)}\n` +
          `เพิ่ม 5=40 (เพิ่มแทง)\n` +
          `ยอด     — ดูเงินคงเหลือ\n` +
          `อันดับ  — ดู Top 10\n` +
          `สกอร์   — ดูผลย้อนหลัง\n` +
          `${'─'.repeat(22)}\n` +
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

      // ── สกอร์ย้อนหลัง ─────────────────────────────────────
      if (/^(สกอร์|score|ผลย้อนหลัง|ย้อนหลัง)$/i.test(lower)) {
        const DE = ['','⚀','⚁','⚂','⚃','⚄','⚅'];
        const recent = db.rounds.slice(0, 10);
        const scoreRows = recent.map(r => ({
          type: 'box', layout: 'horizontal',
          paddingTop: '5px', paddingBottom: '5px',
          contents: [
            { type:'text', text:`${r.round}`, size:'xs', color:'#555', flex:2, weight:'bold' },
            { type:'text', text:`${DE[r.d1]||r.d1} ${DE[r.d2]||r.d2} ${DE[r.d3]||r.d3}`, size:'xs', color:'#333', flex:4 },
            { type:'text', text:`${r.sum}`, size:'xs', color:'#555', flex:1, align:'center' },
            {
              type:'text', text: r.label,
              size:'xs', flex:2, align:'end', weight:'bold',
              color: r.label==='สูง'?'#c0392b': r.label==='ต่ำ'?'#2980b9':'#8e44ad'
            }
          ]
        }));
        const scoreFlex = {
          type: 'flex', altText: 'SCORE - HILO ย้อนหลัง 10 รอบ',
          contents: {
            type: 'bubble', size: 'mega',
            header: {
              type:'box', layout:'horizontal', backgroundColor:'#c0392b', paddingAll:'10px',
              contents: [
                { type:'text', text:'SCORE - HILO', size:'md', color:'#fff', weight:'bold', flex:3 },
                { type:'text', text:`ย้อนหลัง 10 รอบ`, size:'xs', color:'#ffcccc', align:'end', flex:2 }
              ]
            },
            body: {
              type:'box', layout:'vertical', paddingAll:'8px', spacing:'none',
              contents: [
                {
                  type:'box', layout:'horizontal', backgroundColor:'#ecf0f1', paddingTop:'4px', paddingBottom:'4px',
                  contents: [
                    { type:'text', text:'รอบ', size:'xs', color:'#888', flex:2, weight:'bold' },
                    { type:'text', text:'ลูกเต๋า', size:'xs', color:'#888', flex:4, weight:'bold' },
                    { type:'text', text:'รวม', size:'xs', color:'#888', flex:1, align:'center', weight:'bold' },
                    { type:'text', text:'ผล', size:'xs', color:'#888', flex:2, align:'end', weight:'bold' }
                  ]
                },
                { type:'separator', color:'#bdc3c7' },
                ...(recent.length ? scoreRows : [{ type:'text', text:'ยังไม่มีผล', size:'sm', color:'#aaa', align:'center' }])
              ]
            }
          }
        };
        await replyMsg(replyTk, [scoreFlex]);
        await saveDB(db); continue;
      }

      // ── สุ่มลูกเต๋า (รอยืนยัน) ──────────────────────────────
      if (/^(สุ่ม|roll|ออกผล)$/.test(lower)) {
        const d1=Math.ceil(Math.random()*6), d2=Math.ceil(Math.random()*6), d3=Math.ceil(Math.random()*6);
        const sum=d1+d2+d3, triple=d1===d2&&d2===d3, hi=sum>=11;
        const DE=['','⚀','⚁','⚂','⚃','⚄','⚅'];
        const lbl = triple?'ต๊อก!':hi?'สูง':'ต่ำ';
        if (!db.pendingResults) db.pendingResults = {};
        db.pendingResults[srcId] = { d1,d2,d3, round:db.currentRound, ts:Date.now() };
        db.isOpen = false;
        const confirmFlex = buildConfirmFlex(db.currentRound, d1, d2, d3, sum, lbl, DE);
        await replyMsg(replyTk, [confirmFlex]);
        await saveDB(db); continue;
      }

      // ── ตั้งผลเอง (รอยืนยัน) ─────────────────────────────────
      const manM = text.match(/^ผล\s+(\d)\s+(\d)\s+(\d)$/);
      if (manM) {
        const [,d1,d2,d3] = manM.map(Number);
        const sum=d1+d2+d3, triple=d1===d2&&d2===d3, hi=sum>=11;
        const DE=['','⚀','⚁','⚂','⚃','⚄','⚅'];
        const lbl = triple?'ต๊อก!':hi?'สูง':'ต่ำ';
        if (!db.pendingResults) db.pendingResults = {};
        db.pendingResults[srcId] = { d1,d2,d3, round:db.currentRound, ts:Date.now() };
        db.isOpen = false;
        const confirmFlex = buildConfirmFlex(db.currentRound, d1, d2, d3, sum, lbl, DE);
        await replyMsg(replyTk, [confirmFlex]);
        await saveDB(db); continue;
      }

      // ── ยืนยันผล Y ───────────────────────────────────────────
      if (/^[yY]$/.test(text.trim())) {
        if (!db.pendingResults) db.pendingResults = {};
        const pending = db.pendingResults[srcId];
        if (pending && (Date.now() - pending.ts) < 5 * 60 * 1000) {
          delete db.pendingResults[srcId];
          await doResult(db, pending.d1, pending.d2, pending.d3, groupId, replyTk);
          await saveDB(db); continue;
        } else {
          await replyMsg(replyTk, [txtMsg('❌ ไม่มีผลรอยืนยัน หรือหมดเวลา (5 นาที)\nพิมพ์ "สุ่ม" หรือ "ผล X X X" ใหม่')]);
          await saveDB(db); continue;
        }
      }

      // ── ยกเลิกผล N ───────────────────────────────────────────
      if (/^[nN]$/.test(text.trim())) {
        if (!db.pendingResults) db.pendingResults = {};
        if (db.pendingResults[srcId]) {
          delete db.pendingResults[srcId];
          db.isOpen = true;
          await replyMsg(replyTk, [txtMsg('🔄 ยกเลิกผลแล้ว รับแทงต่อ\nพิมพ์ "สุ่ม" หรือ "ผล X X X" ใหม่')]);
          await saveDB(db); continue;
        }
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

        // ตรวจเงินพอ
        if (player.balance < total) {
          await replyMsg(replyTk, [txtMsg(
            `❌ เงินไม่พอ!\n` +
            `ต้องการ: ${total.toLocaleString()} บาท\n` +
            `คงเหลือ: ${player.balance.toLocaleString()} บาท\n\n` +
            `💳 ส่งสลิปเติมเงินก่อนแทง`
          )]);
          await saveDB(db); continue;
        }

        // หักเงินทันที
        player.balance  -= total;
        player.totalBet += total;

        db.bets.unshift({
          id:`${Date.now()}`, uid, name, memberId:player.memberId,
          round:db.currentRound, items:allItems, total,
          status:'pending', ts:new Date().toISOString(), groupId,
        });
        if (db.bets.length > 50000) db.bets.length = 50000;
        addLog(db, 'bet', `${name} แทง ${allItems.length} รายการ รวม ${total} (เหลือ ${player.balance})`, uid);

        const replies = [];
        const rTotal = regular.reduce((s,b)=>s+b.amt,0);
        const eTotal = extra.reduce((s,b)=>s+b.amt,0);
        if (regular.length > 0) replies.push(betFlex(name, regular, player.balance, rTotal, 'แทง ✅'));
        if (extra.length   > 0) replies.push(betFlex(name, extra, player.balance, eTotal, 'เพิ่ม ✅'));
        if (replies.length > 0) await replyMsg(replyTk, replies);
        await saveDB(db); continue;
      }
    }

    // ── JOIN: บอทเข้ากลุ่ม → ดึงสมาชิกอัตโนมัติ ─────────────
    if (ev.type === 'join') {
      if (groupId) db.defaultGroupId = groupId;
      addLog(db, 'join', `บอทเข้ากลุ่ม ${groupId||''}`);
      await saveDB(db);
      await replyMsg(replyTk, [txtMsg(`🐉 สวัสดีครับ! มารวย Bot พร้อมแล้ว\n🔄 กำลังดึงข้อมูลสมาชิก...\nพิมพ์ "วิธีแทง" เพื่อดูคำสั่ง`)]);
      if (TOKEN && groupId) {
        setImmediate(async () => {
          try {
            const db2 = await readDB();
            const { added } = await importGroupMembers(db2, groupId);
            await saveDB(db2);
            if (added > 0) await pushMsg(groupId, [txtMsg(`✅ เพิ่มสมาชิก ${added} คนเข้าระบบแล้ว\n💳 ส่งสลิปเติมเงิน แล้วแทงได้เลย!`)]);
          } catch(e) { console.error('auto-import:', e.message); }
        });
      }
    }

    // ── MEMBER JOINED: คนเข้ากลุ่ม ──────────────────────────
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

    // ── MEMBER LEFT ───────────────────────────────────────────
    if (ev.type === 'memberLeft') {
      for (const m of (ev.left?.members||[])) {
        if (m.type!=='user'||!m.userId) continue;
        const p=db.players[m.userId];
        if (p) { p.groupId=null; addLog(db,'msg',`${p.name} ออกจากกลุ่ม`,m.userId); }
      }
      await saveDB(db);
    }

    // ── FOLLOW: add บอท 1:1 ───────────────────────────────────
    if (ev.type === 'follow') {
      const prof = await getProfile(uid, null);
      const dname = prof?.displayName||`สมาชิก${Object.keys(db.players).length+1}`;
      if (!db.players[uid]) {
        const cnt = Object.keys(db.players).length+1;
        db.players[uid] = { name:dname, uid, memberId:cnt, balance:0,
          totalBet:0, totalWin:0, totalLoss:0, joinedAt:new Date().toISOString(), groupId:null };
      }
      const p=db.players[uid];
      await replyMsg(replyTk, [txtMsg(`🐉 ยินดีต้อนรับ ${p.name}!\nID: ${p.memberId} | เงิน: ${p.balance.toLocaleString()} บาท\n💳 ส่งสลิปเติมเงิน\nพิมพ์ "วิธีแทง" เพื่อดูคำสั่ง`)]);
      addLog(db, 'follow', `${p.name} add บอท`, uid);
      await saveDB(db);
    }
  }
});;

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
    imagesMeta:(db.images||[]).map(img=>({id:img.id,name:img.name,category:img.category,tag:img.tag,ts:img.ts,contentType:img.contentType})),
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


// ─── DICE SHAKE GIF → LINE ───────────────────────────────────
const { execFile, spawn } = require('child_process');

// สร้าง GIF ลูกเต๋าสั่นแล้วส่งไป LINE โดยตรง
async function sendDiceGifToLine(d1, d2, d3, groupId, confirmMode) {
  if (!TOKEN || !groupId) return null;
  const tmpPath = path.join(os.tmpdir(), `dice_${Date.now()}.gif`);
  const scriptPath = path.join(__dirname, 'dice_gif.py');

  // 1. Generate GIF
  await new Promise((resolve, reject) => {
    // try python3 first, fallback to python
    const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
    execFile(pyCmd, [scriptPath, String(d1), String(d2), String(d3), tmpPath], 
      { timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) {
          // fallback
          execFile('python', [scriptPath, String(d1), String(d2), String(d3), tmpPath],
            { timeout: 20000 },
            (err2) => { if (err2) reject(err2); else resolve(); }
          );
        } else resolve(parseInt(stdout.trim())||0);
      }
    );
  });

  // 2. Upload to LINE Content API (multipart)
  const gifBuf = require('fs').readFileSync(tmpPath);
  require('fs').unlinkSync(tmpPath);

  // LINE ไม่รองรับอัพโหลด GIF โดยตรงผ่าน push message
  // วิธีที่ดีที่สุด: encode base64 แล้วฝังใน Flex Message (LINE รองรับ data: URI ใน imageUrl ไม่ได้)
  // → ต้องมี public URL เพื่อส่งเป็น image message
  // → เก็บ GIF ใน db.images แล้วส่ง URL ผ่าน /api/images/:id/view
  
  // Store GIF in images DB
  const db = await readDB();
  const sum = d1+d2+d3;
  const triple = d1===d2&&d2===d3;
  const hi = sum>=11;
  const label = triple?'ต๊อก!':hi?'สูง':'ต่ำ';
  
  if (!db.images) db.images = [];
  const imgId = 'dice_' + Date.now();
  db.images.unshift({
    id: imgId,
    name: `ลูกเต๋า ${d1}-${d2}-${d3} (${label})`,
    category: 'announce',
    tag: 'dice',
    data: gifBuf.toString('base64'),
    contentType: 'image/gif',
    ts: new Date().toISOString(),
    autoDelete: true,  // ลบหลัง 30 นาที
  });
  // Keep only last 20 auto-generated dice GIFs
  db.images = db.images.filter((img, i) => !img.autoDelete || i < 20);
  await saveDB(db);

  return { imgId, label, sum };
}

// POST /api/roll-gif — สุ่มลูกเต๋า + ส่ง GIF ไป LINE
app.post('/api/roll-gif', auth, async (req, res) => {
  const { d1, d2, d3, random: useRandom, groupId, confirmMode, confirmed } = req.body;
  const baseUrl = req.body.baseUrl || SERVER_BASE_URL || '';
  
  const rd1 = useRandom ? Math.ceil(Math.random()*6) : +d1;
  const rd2 = useRandom ? Math.ceil(Math.random()*6) : +d2;
  const rd3 = useRandom ? Math.ceil(Math.random()*6) : +d3;
  if (!rd1||!rd2||!rd3) return res.json({ ok:false, error:'invalid dice' });
  
  const db = await readDB();
  const target = groupId || db.defaultGroupId;
  const sum = rd1+rd2+rd3;
  const triple = rd1===rd2&&rd2===rd3;
  const hi = sum>=11;
  const label = triple?'ต๊อก!':hi?'สูง':'ต่ำ';
  const DE = ['','⚀','⚁','⚂','⚃','⚄','⚅'];
  
  // ── ถ้า confirmMode: เก็บ pending แล้วส่ง GIF preview ──
  if (confirmMode && !confirmed) {
    db.isOpen = false;
    if (!db.pendingResults) db.pendingResults = {};
    db.pendingResults['_dashboard'] = { d1:rd1, d2:rd2, d3:rd3, round:db.currentRound, ts:Date.now() };
    await saveDB(db);
    
    // ส่ง GIF ไป LINE พร้อมข้อความขอยืนยัน
    let gifSent = false;
    if (target && baseUrl) {
      try {
        const gifResult = await sendDiceGifToLine(rd1, rd2, rd3, target, true);
        if (gifResult) {
          const imgUrl = `${baseUrl}/api/images/${gifResult.imgId}/view`;
          await linePost('/v2/bot/message/push', {
            to: target,
            messages: [
              { type:'image', originalContentUrl:imgUrl, previewImageUrl:imgUrl },
              { type:'text', text:
                `ตรวจสอบผลที่ออก\n` +
                `${'─'.repeat(20)}\n` +
                `เปิดที่ ${db.currentRound}\n` +
                `${DE[rd1]} ${DE[rd2]} ${DE[rd3]}  รวม ${sum} (${label})\n` +
                `${'─'.repeat(20)}\n` +
                `ยืนยัน y หรือ Y`
              }
            ]
          });
          gifSent = true;
        }
      } catch(e) { console.warn('GIF send error:', e.message); }
    }
    
    if (!gifSent && target) {
      // fallback: ส่ง Flex Message แทน
      const DE2 = ['','⚀','⚁','⚂','⚃','⚄','⚅'];
      const confirmMsg =
        `ตรวจสอบผลที่ออก\n` +
        `${'─'.repeat(20)}\n` +
        `เปิดที่ ${db.currentRound}\n` +
        `${DE2[rd1]} ${DE2[rd2]} ${DE2[rd3]}  รวม ${sum} (${label})\n` +
        `${'─'.repeat(20)}\n` +
        `ยืนยัน y หรือ Y`;
      await pushMsg(target, [txtMsg(confirmMsg)]);
    }
    
    return res.json({ ok:true, pendingConfirm:true, d1:rd1, d2:rd2, d3:rd3, round:db.currentRound, gifSent });
  }
  
  // ── ออกผลจริง (confirmed) ──
  if (db.pendingResults) delete db.pendingResults['_dashboard'];
  db.isOpen = false;
  
  // ส่ง GIF ก่อน ถ้ามี baseUrl
  if (target && baseUrl) {
    try {
      const gifResult = await sendDiceGifToLine(rd1, rd2, rd3, target, false);
      if (gifResult) {
        const imgUrl = `${baseUrl}/api/images/${gifResult.imgId}/view`;
        await linePost('/v2/bot/message/push', {
          to: target,
          messages: [{ type:'image', originalContentUrl:imgUrl, previewImageUrl:imgUrl }]
        });
        await delay(600);
      }
    } catch(e) { console.warn('GIF send error:', e.message); }
  }
  
  // ออกผลปกติ (settle bets, ส่ง summary)
  const results = await doResult(db, rd1, rd2, rd3, target, null);
  await saveDB(db);
  return res.json({ ok:true, d1:rd1, d2:rd2, d3:rd3, results, settled:results.length });
});

// GET /api/gen-gif/:d1/:d2/:d3 — ดู GIF preview (ไม่ส่ง LINE)
app.get('/api/gen-gif/:d1/:d2/:d3', auth, async (req, res) => {
  const { d1, d2, d3 } = req.params;
  const tmpPath = path.join(os.tmpdir(), `preview_${Date.now()}.gif`);
  const scriptPath = path.join(__dirname, 'dice_gif.py');
  try {
    await new Promise((resolve, reject) => {
      const pyCmd2 = process.platform === 'win32' ? 'python' : 'python3';
    execFile(pyCmd2, [scriptPath, String(d1), String(d2), String(d3), tmpPath],
        { timeout: 20000 },
        (err) => {
          if(err) {
            execFile('python', [scriptPath, String(d1), String(d2), String(d3), tmpPath],
              { timeout: 20000 }, (e2) => { if(e2) reject(e2); else resolve(); }
            );
          } else resolve();
        }
      );
    });
    const buf = require('fs').readFileSync(tmpPath);
    require('fs').unlinkSync(tmpPath);
    res.set('Content-Type','image/gif');
    res.set('Cache-Control','no-store');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.post('/api/roll', auth, async (req, res) => {
  const { d1, d2, d3, random, groupId, confirmMode, confirmed } = req.body;
  const db = await readDB();
  const rd1 = random ? Math.ceil(Math.random()*6) : +d1;
  const rd2 = random ? Math.ceil(Math.random()*6) : +d2;
  const rd3 = random ? Math.ceil(Math.random()*6) : +d3;
  if (!rd1||!rd2||!rd3) return res.json({ ok:false, error:'invalid dice' });
  const target = groupId || db.defaultGroupId;

  // confirmMode = แค่ preview ไม่ settle (ส่ง confirm message ไปกลุ่ม)
  if (confirmMode && !confirmed) {
    const sum=rd1+rd2+rd3, triple=rd1===rd2&&rd2===rd3, hi=sum>=11;
    const DE=['','⚀','⚁','⚂','⚃','⚄','⚅'];
    const lbl=triple?'ต๊อก!':hi?'สูง':'ต่ำ';
    db.isOpen = false;
    // เก็บ pending ไว้ใน DB (กัน race condition)
    if (!db.pendingResults) db.pendingResults = {};
    db.pendingResults['_dashboard'] = { d1:rd1, d2:rd2, d3:rd3, round:db.currentRound, ts:Date.now() };
    await saveDB(db);
    // ส่ง confirm message ไปกลุ่มด้วย (ถ้ามี)
    if (target) {
      const confirmMsg =
        `ตรวจสอบผลที่ออก\n` +
        `${'─'.repeat(20)}\n` +
        `เปิดที่ ${db.currentRound}\n` +
        `สรุปผลไฮโล\n` +
        `${DE[rd1]} ${DE[rd2]} ${DE[rd3]}\n` +
        `${rd1} + ${rd2} + ${rd3} = ${sum} (${lbl})\n` +
        `${'─'.repeat(20)}\n` +
        `ยืนยันแผลสรุป y หรือ Y`;
      await pushMsg(target, [txtMsg(confirmMsg)]);
    }
    return res.json({ ok:true, pendingConfirm:true, d1:rd1, d2:rd2, d3:rd3, round:db.currentRound });
  }

  // ออกผลจริง
  db.isOpen = false;
  if (db.pendingResults) delete db.pendingResults['_dashboard'];
  const results = await doResult(db, rd1,rd2,rd3, target, null);
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

// ════════════════════════════════════════════════════════════
// API: ตั้งค่า credentials — ไม่ต้องใช้ .env
// ════════════════════════════════════════════════════════════

// POST /api/credentials { lineSecret, lineToken, anthropicKey, mongoUri, testConnection }
app.post('/api/credentials', auth, async (req, res) => {
  const { lineSecret, lineToken, anthropicKey, mongoUri, testConnection } = req.body;
  const db = await readDB();
  if (!db.settings.credentials) db.settings.credentials = {};

  // อัปเดต runtime + บันทึก DB
  if (lineSecret)   { SECRET        = lineSecret;   db.settings.credentials.lineSecret   = lineSecret;   }
  if (lineToken)    { TOKEN         = lineToken;     db.settings.credentials.lineToken     = lineToken;     }
  if (anthropicKey) { ANTHROPIC_KEY = anthropicKey; db.settings.credentials.anthropicKey = anthropicKey; }
  if (mongoUri && !mongoUri.includes('<password>')) {
    db.settings.credentials.mongoUri = mongoUri;
  }
  await saveDB(db);

  // ทดสอบ LINE connection
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

// GET /api/credentials — ดู status (masked)
app.get('/api/credentials', auth, async (req, res) => {
  const db = await readDB();
  const cr = db.settings?.credentials || {};
  const mask = v => v ? v.slice(0,4)+'••••••'+v.slice(-4) : '';
  res.json({ ok:true,
    lineSecret:   { set:!!SECRET||!!cr.lineSecret,     preview:mask(cr.lineSecret||SECRET)   },
    lineToken:    { set:!!TOKEN||!!cr.lineToken,       preview:mask(cr.lineToken||TOKEN)     },
    anthropicKey: { set:!!ANTHROPIC_KEY||!!cr.anthropicKey, preview:mask(cr.anthropicKey||ANTHROPIC_KEY) },
    mongoUri:     { set:!!MONGO_URI||!!cr.mongoUri,    preview:mask(cr.mongoUri||MONGO_URI)  },
    runtimeActive:{ secret:!!SECRET, token:!!TOKEN, ai:!!ANTHROPIC_KEY, mongo:_mongoOk },
  });
});

// POST /api/mongo-uri — เชื่อมต่อ MongoDB แบบ live
app.post('/api/mongo-uri', auth, async (req, res) => {
  const { mongoUri } = req.body;
  if (!mongoUri) return res.json({ ok:false, error:'กรุณาใส่ URI' });
  if (mongoUri.includes('<password>')) return res.json({ ok:false, error:'แทนที่ <password> ด้วยรหัสผ่านจริงก่อน' });

  // ทดสอบ connection
  let tc;
  try {
    tc = new MongoClient(mongoUri, { serverSelectionTimeoutMS:8000 });
    await tc.connect();
    await tc.db('admin').command({ ping:1 });
    await tc.close(); tc = null;
  } catch(e) {
    if (tc) { try { await tc.close(); } catch {} }
    return res.json({ ok:false, error:'เชื่อมต่อไม่ได้: '+e.message });
  }

  // ปิด connection เดิม + เปิดใหม่
  if (_mongoClient) { try { await _mongoClient.close(); } catch {} }
  _mongoClient = null; _db = null; _mongoOk = false;
  MONGO_URI = mongoUri;
  try {
    await getMongoCol();
    const db = await readDB();
    if (!db.settings.credentials) db.settings.credentials = {};
    db.settings.credentials.mongoUri = mongoUri;
    db.settings.botName      = db.settings.botName      || 'มารวย';
    db.settings.startBalance = db.settings.startBalance ?? 0;
    await saveDB(db);
    await loadCredsFromDB(); // โหลด credentials ที่อาจมีอยู่ใน DB ใหม่
    console.log('✅ MongoDB URI updated live');
    res.json({ ok:true, connected:true, dbName:_db?.databaseName||'himangkorn' });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// GET /api/bot-info
app.get('/api/bot-info', auth, async (req, res) => {
  if (!TOKEN) return res.json({ ok:false, error:'ยังไม่ได้ตั้ง LINE Token' });
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

// POST /api/import-group — ดึงสมาชิกกลุ่ม LINE
app.post('/api/import-group', auth, async (req, res) => {
  if (!TOKEN) return res.json({ ok:false, error:'ยังไม่ได้ตั้ง LINE Token' });
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

// ─── IMAGE MANAGEMENT API ──────────────────────────────────────
// ─── ADMIN USERS API ────────────────────────────────────────
const crypto_mod = require('crypto');
function hashPw(pw) { return crypto_mod.createHash('sha256').update(pw + 'maruay_salt_2025').digest('hex'); }

// Auth middleware with role check
function authRole(role) {
  return async (req, res, next) => {
    const db = await readDB();
    const token = req.headers['x-admin-token'] || req.query.token || '';
    // Support legacy ADMIN_PW as super-admin token
    if (token === ADMIN_PW) { req.adminUser = { role:'admin', name:'Super Admin', username:'admin' }; return next(); }
    // Check adminUsers
    const user = (db.adminUsers||[]).find(u => u.token === token);
    if (!user) return res.status(401).json({ ok:false, error:'unauthorized' });
    if (role === 'admin' && user.role !== 'admin') return res.status(403).json({ ok:false, error:'insufficient role' });
    if (role === 'mod' && !['admin','mod'].includes(user.role)) return res.status(403).json({ ok:false, error:'insufficient role' });
    req.adminUser = user;
    next();
  };
}

// GET /api/users — list all admin users
app.get('/api/users', auth, async (req, res) => {
  const db = await readDB();
  const token = req.headers['x-admin-token'] || req.query.token || '';
  let me = null;
  if (token === ADMIN_PW) {
    me = { id:'root', name:'Super Admin', username:'admin', role:'admin', lastLogin: null };
  } else {
    me = (db.adminUsers||[]).find(u => u.token === token);
  }
  const users = (db.adminUsers||[]).map(u => ({
    id: u.id, name: u.name, username: u.username, role: u.role, lastLogin: u.lastLogin
  }));
  res.json({ ok:true, users, me: me ? { id:me.id, name:me.name, username:me.username, role:me.role, lastLogin:me.lastLogin } : null });
});

// POST /api/users — create/update/delete/changepw
app.post('/api/users', auth, async (req, res) => {
  const { action, id, name, username, password, role } = req.body;
  const db = await readDB();
  if (!db.adminUsers) db.adminUsers = [];

  if (action === 'create') {
    if (!username || !password || !name) return res.json({ ok:false, error:'ข้อมูลไม่ครบ' });
    if (db.adminUsers.find(u => u.username === username)) return res.json({ ok:false, error:'username นี้มีอยู่แล้ว' });
    const newUser = {
      id: Date.now().toString(),
      name: name.trim(),
      username: username.trim().toLowerCase(),
      passwordHash: hashPw(password),
      token: crypto_mod.randomBytes(24).toString('hex'),
      role: role || 'viewer',
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };
    db.adminUsers.push(newUser);
    addLog(db, 'msg', `สร้าง admin user: ${newUser.name} (${newUser.role})`);
    await saveDB(db);
    return res.json({ ok:true, id: newUser.id });
  }

  if (action === 'update') {
    const user = db.adminUsers.find(u => u.id === id);
    if (!user) return res.json({ ok:false, error:'ไม่พบผู้ใช้' });
    if (name)     user.name = name.trim();
    if (role)     user.role = role;
    if (password) user.passwordHash = hashPw(password);
    addLog(db, 'msg', `แก้ไข admin user: ${user.name}`);
    await saveDB(db);
    return res.json({ ok:true });
  }

  if (action === 'delete') {
    const idx = db.adminUsers.findIndex(u => u.id === id);
    if (idx === -1) return res.json({ ok:false, error:'ไม่พบผู้ใช้' });
    const [removed] = db.adminUsers.splice(idx, 1);
    addLog(db, 'msg', `ลบ admin user: ${removed.name}`);
    await saveDB(db);
    return res.json({ ok:true });
  }

  if (action === 'changepw') {
    const token = req.headers['x-admin-token'] || '';
    const user = db.adminUsers.find(u => u.token === token);
    if (!user) return res.json({ ok:false, error:'ไม่พบผู้ใช้ หรือ session หมดอายุ' });
    if (!password) return res.json({ ok:false, error:'ต้องใส่รหัสผ่านใหม่' });
    user.passwordHash = hashPw(password);
    await saveDB(db);
    return res.json({ ok:true });
  }

  return res.json({ ok:false, error:'action ไม่ถูกต้อง' });
});

// POST /api/login — login with username+password, return token
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  // Super admin login
  if (password === ADMIN_PW && (!username || username === 'admin')) {
    return res.json({ ok:true, token: ADMIN_PW, role:'admin', name:'Super Admin' });
  }
  const db = await readDB();
  const user = (db.adminUsers||[]).find(u =>
    u.username === (username||'').toLowerCase() && u.passwordHash === hashPw(password||'')
  );
  if (!user) return res.json({ ok:false, error:'username หรือรหัสผ่านไม่ถูกต้อง' });
  user.lastLogin = new Date().toISOString();
  await saveDB(db);
  return res.json({ ok:true, token: user.token, role: user.role, name: user.name });
});

// GET /api/images — ดูรูปภาพทั้งหมด
app.get('/api/images', auth, async (req, res) => {
  const db = await readDB();
  const images = (db.images || []).map(img => ({
    id: img.id, name: img.name, category: img.category,
    tag: img.tag, ts: img.ts, size: img.data ? Math.round(img.data.length * 0.75 / 1024) : 0,
    contentType: img.contentType,
  }));
  res.json({ ok: true, images });
});

// GET /api/images/:id/data — ดึงข้อมูล base64 ของรูป
app.get('/api/images/:id/data', auth, async (req, res) => {
  const db = await readDB();
  const img = (db.images || []).find(i => i.id === req.params.id);
  if (!img) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, data: img.data, contentType: img.contentType, name: img.name });
});

// POST /api/images — อัพโหลดรูปใหม่ { name, category, tag, data(base64), contentType }
app.post('/api/images', auth, async (req, res) => {
  const { name, category, tag, data, contentType } = req.body;
  if (!name || !data) return res.json({ ok: false, error: 'name and data required' });
  const db = await readDB();
  if (!db.images) db.images = [];
  const img = {
    id: Date.now().toString(),
    name: name.trim(),
    category: category || 'general',
    tag: tag || '',
    data,
    contentType: contentType || 'image/jpeg',
    ts: new Date().toISOString(),
  };
  db.images.unshift(img);
  if (db.images.length > 200) db.images.length = 200;
  addLog(db, 'image', `อัพโหลดรูป: ${img.name} (${img.category})`);
  await saveDB(db);
  res.json({ ok: true, id: img.id });
});

// PUT /api/images/:id — แก้ไขข้อมูลรูป
app.put('/api/images/:id', auth, async (req, res) => {
  const db = await readDB();
  const img = (db.images || []).find(i => i.id === req.params.id);
  if (!img) return res.json({ ok: false, error: 'not found' });
  if (req.body.name)     img.name     = req.body.name.trim();
  if (req.body.category) img.category = req.body.category;
  if (req.body.tag !== undefined) img.tag = req.body.tag;
  if (req.body.data)     { img.data = req.body.data; img.contentType = req.body.contentType || img.contentType; }
  await saveDB(db);
  res.json({ ok: true });
});

// DELETE /api/images/:id — ลบรูป
app.delete('/api/images/:id', auth, async (req, res) => {
  const db = await readDB();
  const before = (db.images || []).length;
  db.images = (db.images || []).filter(i => i.id !== req.params.id);
  if (db.images.length === before) return res.json({ ok: false, error: 'not found' });
  addLog(db, 'image', `ลบรูป ID: ${req.params.id}`);
  await saveDB(db);
  res.json({ ok: true });
});

// POST /api/images/:id/send — ส่งรูปไปยัง LINE กลุ่ม
app.post('/api/images/:id/send', auth, async (req, res) => {
  const db = await readDB();
  const img = (db.images || []).find(i => i.id === req.params.id);
  if (!img) return res.json({ ok: false, error: 'not found' });
  const target = req.body.groupId || db.defaultGroupId;
  if (!target) return res.json({ ok: false, error: 'ไม่มี groupId' });
  if (!TOKEN) return res.json({ ok: false, error: 'ยังไม่ได้ตั้งค่า LINE Token' });

  const caption = req.body.caption || img.name;
  const baseUrl = req.body.baseUrl || SERVER_BASE_URL || '';
  let msgSent = false;

  if (baseUrl) {
    const imgUrl = `${baseUrl}/api/images/${img.id}/view`;
    try {
      await linePost('/v2/bot/message/push', {
        to: target,
        messages: [{
          type: 'image',
          originalContentUrl: imgUrl,
          previewImageUrl: imgUrl,
        }, { type: 'text', text: caption }]
      });
      msgSent = true;
    } catch(e) { console.warn('send image error:', e.message); }
  }

  if (!msgSent) {
    // fallback: ส่งแค่ข้อความ
    await pushMsg(target, [{ type: 'text', text: `📸 ${caption}\n(ส่งรูปต้องตั้ง Base URL ของเซิร์ฟเวอร์ก่อน)` }]);
  }
  addLog(db, 'image', `ส่งรูป "${img.name}" → ${target}`);
  await saveDB(db);
  res.json({ ok: true, sent: msgSent, fallback: !msgSent });
});

// GET /api/images/:id/view — แสดงรูปภาพ (public สำหรับ LINE)
app.get('/api/images/:id/view', async (req, res) => {
  // ต้องตรวจ token หรือเปิด public ตาม config
  const db = await readDB();
  const img = (db.images || []).find(i => i.id === req.params.id);
  if (!img || !img.data) return res.status(404).send('Not found');
  const buf = Buffer.from(img.data, 'base64');
  res.set('Content-Type', img.contentType || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buf);
});

// POST /api/images/send-text — ส่งข้อความ+รูปแบบ flex ไปกลุ่ม
app.post('/api/images/send-text', auth, async (req, res) => {
  const { groupId, text, imageId, baseUrl } = req.body;
  const db = await readDB();
  const target = groupId || db.defaultGroupId;
  if (!target) return res.json({ ok: false, error: 'ไม่มี groupId' });
  const msgs = [];
  if (imageId && baseUrl) {
    const imgUrl = `${baseUrl}/api/images/${imageId}/view`;
    msgs.push({ type: 'image', originalContentUrl: imgUrl, previewImageUrl: imgUrl });
  }
  if (text) msgs.push({ type: 'text', text });
  if (!msgs.length) return res.json({ ok: false, error: 'ไม่มีข้อความหรือรูป' });
  await pushMsg(target, msgs);
  addLog(db, 'image', `ส่งข้อความ+รูปไป ${target}`);
  await saveDB(db);
  res.json({ ok: true });
});

// POST /api/score — ส่งสกอร์ย้อนหลังไปกลุ่ม
app.post('/api/score', auth, async (req, res) => {
  const db = await readDB();
  const target = req.body.groupId || db.defaultGroupId;
  const count  = parseInt(req.body.count) || 10;
  const scoreText = buildScoreText(db.rounds, count);
  if (target) {
    await pushMsg(target, [txtMsg(scoreText)]);
    addLog(db, 'msg', `ส่งสกอร์ย้อนหลัง ${count} รอบไป ${target}`);
    await saveDB(db);
  }
  res.json({ ok: true, text: scoreText });
});

app.get('/health', (_, res) => res.json({ ok:true, ts:new Date().toISOString(), port:PORT, aiEnabled:!!ANTHROPIC_KEY, lineOk:!!TOKEN&&!!SECRET, mongoConnected:_mongoOk }));
app.get('/', (req, res) => {
  const token = req.query.token || '';
  const html = DASHBOARD_HTML
    .replace(/__TOKEN__/g, token)
    .replace(/__PORT__/g, PORT)
    .replace(/__ADMIN_PW__/g, ADMIN_PW)
    .replace(/__BASE_URL__/g, SERVER_BASE_URL || (req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto']+'://'+req.headers['host'] : ''));
  res.send(html);
});

// ─── START ────────────────────────────────────────────────────
async function start() {
  // 1. เชื่อม MongoDB จาก .env ก่อน (ถ้ามี)
  if (MONGO_URI) {
    try {
      await getMongoCol();
      console.log('✅ MongoDB connected (env)');
      await loadCredsFromDB(); // โหลด credentials ที่บันทึกไว้ใน DB
    } catch(e) {
      console.error('❌ MongoDB (env) failed:', e.message);
    }
  } else {
    console.log('ℹ️  ไม่มี MONGODB_URI ใน env — ตั้งค่าผ่านหน้าเว็บได้เลย');
  }

  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║  มารวย v5 — AI Slip + Image Manager     ║');
    console.log('╚══════════════════════════════════════╝');
    console.log(`📊 Dashboard: http://localhost:${PORT}/?token=${ADMIN_PW}`);
    console.log(`🔗 Webhook:   http://localhost:${PORT}/webhook`);
    console.log('');
    console.log('Status:');
    console.log(_mongoOk      ? '  ✅ MongoDB    : connected' : '  ⚠️  MongoDB    : not connected (ตั้งค่าในเว็บได้)');
    console.log(SECRET        ? '  ✅ LINE Secret: OK'        : '  ⚠️  LINE Secret: not set (ตั้งค่าในเว็บได้)');
    console.log(TOKEN         ? '  ✅ LINE Token : OK'        : '  ⚠️  LINE Token : not set (ตั้งค่าในเว็บได้)');
    console.log(ANTHROPIC_KEY ? '  ✅ AI Key     : OK'        : '  ⚠️  AI Key     : not set (ตั้งค่าในเว็บได้)');
    console.log('');
    console.log('💡 ตั้งค่าทุกอย่างได้ที่ Dashboard → ตั้งค่า');

    // ── Keep-alive สำหรับ Render Free (กัน sleep หลัง 15 นาที) ──
    if (SERVER_BASE_URL && process.env.NODE_ENV === 'production') {
      setInterval(() => {
        try {
          const mod = SERVER_BASE_URL.startsWith('https') ? require('https') : require('http');
          mod.get(SERVER_BASE_URL + '/health', r => r.resume()).on('error', ()=>{});
        } catch(e) {}
      }, 14 * 60 * 1000);
      console.log('⏰ Keep-alive enabled →', SERVER_BASE_URL + '/health');
    }
  });
}
start();


// ══════════════════════════════════════════════════════════════
//  DASHBOARD HTML
// ══════════════════════════════════════════════════════════════
const DASHBOARD_HTML = require('fs').readFileSync(require('path').join(__dirname, 'dashboard.html'), 'utf8');
