# 🍀 มารวย Bot v5

LINE Bot + Dashboard สำหรับเกมไฮโล

## Deploy บน Render

### 1. สร้าง Web Service ใหม่

- ไปที่ [render.com](https://render.com) → New → Web Service
- Connect GitHub repo หรือ upload zip
- ตั้งค่าดังนี้:

| Field | Value |
|-------|-------|
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `node migrate.js && node index.js` |
| **Region** | Singapore |

### 2. ตั้งค่า Environment Variables

| KEY | VALUE |
|-----|-------|
| `ADMIN_PASSWORD` | รหัสผ่านที่ต้องการ เช่น `Maruay01` |
| `LINE_CHANNEL_ACCESS_TOKEN` | จาก LINE Developers Console |
| `LINE_CHANNEL_SECRET` | จาก LINE Developers Console |
| `ANTHROPIC_API_KEY` | สำหรับวิเคราะห์สลิป AI |
| `MONGODB_URI` | `mongodb+srv://...` จาก MongoDB Atlas |
| `SERVER_BASE_URL` | URL ของ Render เช่น `https://maruay-bot.onrender.com` |
| `PORT` | `10000` |

### 3. ตั้งค่า LINE Webhook

หลัง Deploy สำเร็จ ไปที่ LINE Developers Console:
- Webhook URL: `https://your-app.onrender.com/webhook`
- เปิด Use webhook: ✅

### 4. เข้าใช้งาน Dashboard

`https://your-app.onrender.com/?token=รหัสผ่านของคุณ`

## คำสั่งในกลุ่ม LINE

| พิมพ์ | ทำอะไร |
|-------|--------|
| `วิธีแทง` | ดูคำสั่งทั้งหมด |
| `สูง=100` | แทงสูง 100 บาท |
| `ยอด` | ดูเงินคงเหลือ |
| `สกอร์` | ดูผลย้อนหลัง 10 รอบ |
| `เปิด` | เปิดรับแทง (admin) |
| `สุ่ม` | สุ่มลูกเต๋า (admin) |
| `Y` | ยืนยันออกผล (admin) |
