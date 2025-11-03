const cors = require('cors');
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();

// ✅ Allow requests from Vercel frontend
app.use(cors({
  origin: ['https://smart-trolley-ten.vercel.app', 'http://localhost:3000'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== RAZORPAY CONFIG =====
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ===== DATA STORAGE =====
const BILLS_FILE = path.join(__dirname, 'bills.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

let bills = [];
let sessions = {};

// Load data on startup
async function loadData() {
  try {
    const billsData = await fs.readFile(BILLS_FILE, 'utf8');
    bills = JSON.parse(billsData);
    console.log(`📄 Loaded ${bills.length} bills`);
  } catch (err) {
    console.log('📄 No existing bills, starting fresh');
    bills = [];
  }

  try {
    const sessionsData = await fs.readFile(SESSIONS_FILE, 'utf8');
    sessions = JSON.parse(sessionsData);
    console.log(`🔑 Loaded ${Object.keys(sessions).length} sessions`);
  } catch (err) {
    console.log('🔑 No existing sessions, starting fresh');
    sessions = {};
  }
}

async function saveBills() {
  await fs.writeFile(BILLS_FILE, JSON.stringify(bills, null, 2));
}

async function saveSessions() {
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// Generate Bill ID (A100, A101, etc.)
function generateBillId() {
  const prefix = 'A';
  const lastBill = bills[bills.length - 1];
  const lastNumber = lastBill ? parseInt(lastBill.billId.substring(1)) : 99;
  return `${prefix}${lastNumber + 1}`;
}

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Smart Cart Backend',
    endpoints: {
      createOrder: 'POST /api/create-order',
      getSession: 'GET /api/session/:sessionId',
      createRazorpayOrder: 'POST /api/create-razorpay-order',
      verifyPayment: 'POST /api/verify-payment',
      getBill: 'GET /api/bill/:billId',
      getAllBills: 'GET /api/bills'
    }
  });
});

// ===== CREATE ORDER FROM ESP32 =====
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, esp32_ip } = req.body;
    
    if (!items || !total) {
      return res.status(400).json({ error: 'Missing items or total' });
    }

    const sessionId = uuidv4();
    sessions[sessionId] = {
      items,
      total,
      status: 'pending',
      esp32_ip: esp32_ip || null,
      createdAt: new Date().toISOString()
    };
    
    await saveSessions();
    
    console.log(`🛒 Order created: ${sessionId}, Total: ₹${total}`);
    
    res.json({ 
      sessionId,
      paymentUrl: `https://smart-trolley-ten.vercel.app/pay/${sessionId}`
    });
  } catch (error) {
    console.error('❌ Error creating order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== GET SESSION (for ESP32 polling) =====
app.get('/api/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    sessionId,
    status: session.status,
    billId: session.billId || null,
    total: session.total,
    items: session.items
  });
});

// ===== CREATE RAZORPAY ORDER =====
app.post('/api/create-razorpay-order', async (req, res) => {
  try {
    const { sessionId, amount } = req.body;
    
    if (!sessions[sessionId]) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const order = await razorpay.orders.create({
      amount: amount * 100, // Convert to paise
      currency: 'INR',
      receipt: sessionId
    });
    
    console.log(`💳 Razorpay order created: ${order.id} for session ${sessionId}`);
    
    res.json({
      order_id: order.id,
      amount: order.amount,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error('❌ Razorpay order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ===== VERIFY PAYMENT =====
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { sessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    if (!sessions[sessionId]) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    // Verify signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');
    
    const isValid = expectedSignature === razorpay_signature;
    
    if (isValid) {
      const session = sessions[sessionId];
      const billId = generateBillId();
      
      // Save bill
      const bill = {
        billId,
        sessionId,
        items: session.items,
        total: session.total,
        razorpay_order_id,
        razorpay_payment_id,
        timestamp: new Date().toISOString(),
        status: 'paid'
      };
      
      bills.push(bill);
      session.status = 'paid';
      session.billId = billId;
      
      await saveBills();
      await saveSessions();
      
      console.log(`✅ Payment verified: ${billId}`);
      
      // Try to notify ESP32 if IP is available
      if (session.esp32_ip) {
        notifyESP32(session.esp32_ip, billId).catch(err => {
          console.log(`⚠️ Could not notify ESP32: ${err.message}`);
        });
      }
      
      res.json({ success: true, billId });
    } else {
      console.log('❌ Invalid payment signature');
      res.status(400).json({ success: false, error: 'Invalid signature' });
    }
  } catch (error) {
    console.error('❌ Verification error:', error);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// ===== NOTIFY ESP32 (Optional, with timeout) =====
async function notifyESP32(ip, billId) {
  const axios = require('axios');
  try {
    await axios.post(`http://${ip}/payment-status`, {
      status: 'success',
      billId: billId
    }, { timeout: 5000 });
    console.log(`✅ ESP32 notified at ${ip}`);
  } catch (error) {
    throw error;
  }
}

// ===== GET BILL BY ID =====
app.get('/api/bill/:billId', (req, res) => {
  const { billId } = req.params;
  const bill = bills.find(b => b.billId === billId);
  
  if (bill) {
    res.json(bill);
  } else {
    res.status(404).json({ error: 'Bill not found' });
  }
});

// ===== GET ALL BILLS =====
app.get('/api/bills', (req, res) => {
  res.json({
    total: bills.length,
    bills: bills.map(b => ({
      billId: b.billId,
      total: b.total,
      timestamp: b.timestamp,
      items: b.items.length
    }))
  });
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

loadData().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💳 Razorpay integration active`);
    console.log(`🌐 CORS enabled for Vercel frontend`);
  });
});