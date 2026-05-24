require("dotenv").config();

const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGODB_URI);

let db;

async function connectDB() {
  if (!db) {
    await client.connect();

    db = client.db("mangkorn");

    console.log("✅ MongoDB Ready");
  }

  return db;
}

module.exports = connectDB;