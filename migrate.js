// ═══════════════════════════════════════════════════════════
//  migrate.js — Better Day v4 — นำข้อมูลจาก db.json → MongoDB
//  รัน: node migrate.js
// ═══════════════════════════════════════════════════════════
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("❌ ไม่พบ MONGODB_URI ใน .env");
  process.exit(1);
}

async function migrate() {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    console.log("🔌 กำลังเชื่อมต่อ MongoDB...");
    await client.connect();
    console.log("✅ Connected MongoDB");

    // ── ชื่อ DB ต้องตรงกับ index.js ────────────────────────
    const db = client.db("himangkorn");
    const col = db.collection("gamedata");

    // ── อ่าน db.json ────────────────────────────────────────
    const dbPath = path.join(__dirname, "db.json");
    if (!fs.existsSync(dbPath)) {
      console.error("❌ ไม่พบไฟล์ db.json");
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));

    // ── ตรวจว่ามีข้อมูลใน MongoDB แล้วหรือยัง ───────────────
    const existing = await col.findOne({ _id: "main" }).catch(() => null);
    if (existing) {
      const playerCount = Object.keys(existing.players || {}).length;
      console.log(`⚠️  พบข้อมูลใน MongoDB แล้ว (${playerCount} ผู้เล่น)`);
      const overwrite = process.argv.includes("--force");
      if (!overwrite) {
        console.log("   ใช้ --force เพื่อเขียนทับ เช่น:  node migrate.js --force");
        console.log("✅ ไม่มีการเปลี่ยนแปลง");
        return;
      }
      console.log("⚡ --force: เขียนทับข้อมูลเดิม");
    }

    // ── upsert เป็น document เดียว { _id: 'main' } ──────────
    // pattern เดียวกับ readDB()/saveDB() ใน index.js
    const { _id, ...cleanData } = raw; // ล้าง _id เก่าจาก json ถ้ามี
    await col.replaceOne(
      { _id: "main" },
      { _id: "main", ...cleanData },
      { upsert: true }
    );

    // ── สรุปผล ───────────────────────────────────────────────
    console.log("\n🎉 Migration Complete!");
    console.log("─".repeat(40));
    console.log(`   players  : ${Object.keys(raw.players  || {}).length} คน`);
    console.log(`   bets     : ${(raw.bets     || []).length} รายการ`);
    console.log(`   rounds   : ${(raw.rounds   || []).length} รอบ`);
    console.log(`   deposits : ${(raw.deposits || []).length} รายการ`);
    console.log(`   logs     : ${(raw.logs     || []).length} รายการ`);
    console.log(`   slips    : ${(raw.slips    || []).length} รายการ`);
    console.log(`   round    : ${raw.currentRound}`);
    console.log(`   isOpen   : ${raw.isOpen}`);
    console.log("─".repeat(40));
    console.log("\n✅ พร้อมใช้งาน — รัน: node index.js");

  } catch (err) {
    if (err.message?.includes("Server selection timed out")) {
      console.error("\n❌ เชื่อมต่อ MongoDB ไม่ได้ — ตรวจสอบ:");
      console.error("   1. MONGODB_URI ใน .env ถูกต้องหรือไม่");
      console.error("   2. MongoDB Atlas → Network Access → เพิ่ม IP 0.0.0.0/0 (Allow All)");
      console.error("      หรือเพิ่ม IP เครื่องที่รัน migrate นี้");
    } else {
      console.error("❌ Error:", err.message);
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}

migrate();
