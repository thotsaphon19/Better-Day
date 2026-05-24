require("dotenv").config();

const fs = require("fs");
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
if (!uri) { console.error("❌ ไม่พบ MONGODB_URI ใน .env"); process.exit(1); }

const client = new MongoClient(uri);

async function migrate() {
  try {
    await client.connect();
    console.log("✅ Connected MongoDB");

    const db = client.db("himangkorn"); // ← ชื่อ DB ตรงกับ index.js

    const raw = fs.readFileSync("./db.json", "utf8");
    const data = JSON.parse(raw);

    // ลบ _id ออกก่อน upsert
    const { _id, ...cleanData } = data;

    // upsert เป็น document เดียว { _id: 'main' } ตาม pattern ของ index.js
    const col = db.collection("gamedata");
    await col.replaceOne(
      { _id: "main" },
      { _id: "main", ...cleanData },
      { upsert: true }
    );

    console.log("✅ migrate gamedata (main) สำเร็จ");
    console.log(`   - players: ${Object.keys(data.players || {}).length} คน`);
    console.log(`   - bets:    ${(data.bets || []).length} รายการ`);
    console.log(`   - rounds:  ${(data.rounds || []).length} รอบ`);
    console.log(`   - deposits:${(data.deposits || []).length} รายการ`);
    console.log(`   - logs:    ${(data.logs || []).length} รายการ`);
    console.log(`   - slips:   ${(data.slips || []).length} รายการ`);
    console.log("🎉 Migration Complete");
  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await client.close();
  }
}

migrate();
