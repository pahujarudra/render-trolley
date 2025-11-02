const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ===== RAZORPAY CONFIG =====
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ===== DATA STORAGE =====
const BILLS_FILE = path.join(__dirname, 'bills.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// In-memory storage (backed by JSON files)
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

// ===== API ENDPOINTS =====

// Create order from ESP32
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total } = req.body;
    
    if (!items || !total) {
      return res.status(400).json({ error: 'Missing items or total' });
    }

    // Create session
    const sessionId = uuidv4();
    sessions[sessionId] = {
      items,
      total,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    
    await saveSessions();
    
    console.log(`🛒 Order created: ${sessionId}, Total: ₹${total}`);
    
    res.json({ 
      sessionId,
      paymentUrl: `/pay/${sessionId}`
    });
  } catch (error) {
    console.error('❌ Error creating order:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Payment page
app.get('/pay/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  
  if (!session) {
    return res.status(404).send('Session not found');
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Smart Cart Payment</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 500px;
          width: 100%;
          overflow: hidden;
        }
        .header {
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          padding: 30px;
          text-align: center;
        }
        .header h1 { font-size: 28px; margin-bottom: 10px; }
        .header p { opacity: 0.9; font-size: 16px; }
        .content { padding: 30px; }
        .cart-items {
          background: #f7f9fc;
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 20px;
        }
        .item {
          display: flex;
          justify-content: space-between;
          padding: 12px 0;
          border-bottom: 1px solid #e0e6ed;
        }
        .item:last-child { border-bottom: none; }
        .item-name { font-weight: 600; color: #2d3748; }
        .item-qty { color: #718096; margin: 0 10px; }
        .item-price { font-weight: 700; color: #667eea; }
        .total {
          display: flex;
          justify-content: space-between;
          padding: 20px;
          background: #f7f9fc;
          border-radius: 12px;
          margin-bottom: 20px;
          font-size: 20px;
          font-weight: 700;
        }
        .total-label { color: #2d3748; }
        .total-amount { color: #667eea; }
        .pay-btn {
          width: 100%;
          padding: 18px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 12px;
          font-size: 18px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.2s, box-shadow 0.2s;
        }
        .pay-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 30px rgba(102, 126, 234, 0.4);
        }
        .pay-btn:active { transform: translateY(0); }
      </style>
      <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🛒 Smart Cart</h1>
          <p>Review your order</p>
        </div>
        <div class="content">
          <div class="cart-items">
            ${session.items.map(item => `
              <div class="item">
                <span class="item-name">${item.name}</span>
                <div>
                  <span class="item-qty">×${item.quantity}</span>
                  <span class="item-price">₹${item.price * item.quantity}</span>
                </div>
              </div>
            `).join('')}
          </div>
          <div class="total">
            <span class="total-label">Total Amount</span>
            <span class="total-amount">₹${session.total}</span>
          </div>
          <button class="pay-btn" onclick="initiatePayment()">
            💳 Pay Now
          </button>
        </div>
      </div>
      
      <script>
        const sessionId = '${sessionId}';
        const totalAmount = ${session.total};
        
        async function initiatePayment() {
          try {
            const response = await fetch('/api/create-razorpay-order', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, amount: totalAmount })
            });
            
            const data = await response.json();
            
            const options = {
              key: data.key_id,
              amount: data.amount,
              currency: 'INR',
              name: 'Smart Cart',
              description: 'Cart Payment',
              order_id: data.order_id,
              handler: function(response) {
                verifyPayment(response);
              },
              prefill: {
                name: 'Customer',
                email: 'customer@example.com',
                contact: '9999999999'
              },
              theme: { color: '#667eea' }
            };
            
            const rzp = new Razorpay(options);
            rzp.open();
          } catch (error) {
            alert('Payment initiation failed: ' + error.message);
          }
        }
        
        async function verifyPayment(response) {
          try {
            const result = await fetch('/api/verify-payment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId,
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature
              })
            });
            
            const data = await result.json();
            
            if (data.success) {
              window.location.href = '/success?billId=' + data.billId;
            } else {
              alert('Payment verification failed');
            }
          } catch (error) {
            alert('Verification error: ' + error.message);
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Create Razorpay order
app.post('/api/create-razorpay-order', async (req, res) => {
  try {
    const { sessionId, amount } = req.body;
    
    const order = await razorpay.orders.create({
      amount: amount * 100, // Convert to paise
      currency: 'INR',
      receipt: sessionId
    });
    
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

// Verify payment
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { sessionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
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
      
      // Notify ESP32 (you'll need ESP32 IP address)
      // In production, ESP32 would poll or you'd use WebSockets
      
      console.log(`✅ Payment verified: ${billId}`);
      
      res.json({ success: true, billId });
    } else {
      res.status(400).json({ success: false, error: 'Invalid signature' });
    }
  } catch (error) {
    console.error('❌ Verification error:', error);
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

// Success page
app.get('/success', (req, res) => {
  const { billId } = req.query;
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Payment Success</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 500px;
          width: 100%;
          padding: 60px 40px;
          text-align: center;
        }
        .success-icon {
          font-size: 80px;
          margin-bottom: 20px;
          animation: scaleIn 0.5s ease-out;
        }
        @keyframes scaleIn {
          from { transform: scale(0); }
          to { transform: scale(1); }
        }
        h1 { color: #2d3748; margin-bottom: 10px; font-size: 32px; }
        .bill-id {
          background: #f7f9fc;
          padding: 20px;
          border-radius: 12px;
          margin: 30px 0;
          font-size: 18px;
        }
        .bill-label { color: #718096; margin-bottom: 10px; }
        .bill-number {
          font-size: 36px;
          font-weight: 700;
          color: #11998e;
        }
        .home-btn {
          display: inline-block;
          padding: 15px 40px;
          background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%);
          color: white;
          text-decoration: none;
          border-radius: 12px;
          font-weight: 700;
          transition: transform 0.2s;
        }
        .home-btn:hover { transform: translateY(-2px); }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="success-icon">✅</div>
        <h1>Payment Successful!</h1>
        <p style="color: #718096; margin-bottom: 30px;">
          Your payment has been processed successfully
        </p>
        <div class="bill-id">
          <div class="bill-label">Your Bill ID</div>
          <div class="bill-number">${billId}</div>
        </div>
        <a href="/" class="home-btn">Back to Home</a>
      </div>
    </body>
    </html>
  `);
});

// Get bill by ID
app.get('/api/bill/:billId', async (req, res) => {
  const { billId } = req.params;
  const bill = bills.find(b => b.billId === billId);
  
  if (bill) {
    res.json(bill);
  } else {
    res.status(404).json({ error: 'Bill not found' });
  }
});

// Homepage with bill checker
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Smart Cart System</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          padding: 40px 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: white;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          padding: 40px;
        }
        h1 {
          text-align: center;
          color: #2d3748;
          margin-bottom: 10px;
          font-size: 32px;
        }
        .subtitle {
          text-align: center;
          color: #718096;
          margin-bottom: 40px;
        }
        .section {
          background: #f7f9fc;
          border-radius: 12px;
          padding: 30px;
          margin-bottom: 20px;
        }
        .section h2 {
          color: #2d3748;
          margin-bottom: 20px;
          font-size: 20px;
        }
        input {
          width: 100%;
          padding: 15px;
          border: 2px solid #e0e6ed;
          border-radius: 8px;
          font-size: 16px;
          margin-bottom: 15px;
          transition: border-color 0.3s;
        }
        input:focus {
          outline: none;
          border-color: #667eea;
        }
        button {
          width: 100%;
          padding: 15px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 700;
          cursor: pointer;
          transition: transform 0.2s;
        }
        button:hover { transform: translateY(-2px); }
        button:active { transform: translateY(0); }
        .bill-result {
          display: none;
          background: white;
          border-radius: 8px;
          padding: 20px;
          margin-top: 20px;
        }
        .bill-result.show { display: block; }
        .bill-item {
          display: flex;
          justify-content: space-between;
          padding: 10px 0;
          border-bottom: 1px solid #e0e6ed;
        }
        .bill-item:last-child { border-bottom: none; }
        .error {
          color: #e53e3e;
          text-align: center;
          margin-top: 15px;
          display: none;
        }
        .error.show { display: block; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🛒 Smart Cart</h1>
        <p class="subtitle">Scan, Shop, Pay - Seamlessly</p>
        
        <div class="section">
          <h2>📋 Check Previous Bills</h2>
          <input type="text" id="billIdInput" placeholder="Enter Bill ID (e.g., A100)" />
          <button onclick="checkBill()">Check Bill</button>
          <div class="error" id="error"></div>
          <div class="bill-result" id="billResult"></div>
        </div>
      </div>
      
      <script>
        async function checkBill() {
          const billId = document.getElementById('billIdInput').value.trim();
          const resultDiv = document.getElementById('billResult');
          const errorDiv = document.getElementById('error');
          
          resultDiv.classList.remove('show');
          errorDiv.classList.remove('show');
          
          if (!billId) {
            errorDiv.textContent = 'Please enter a Bill ID';
            errorDiv.classList.add('show');
            return;
          }
          
          try {
            const response = await fetch('/api/bill/' + billId);
            
            if (response.ok) {
              const bill = await response.json();
              
              resultDiv.innerHTML = \`
                <h3 style="color: #667eea; margin-bottom: 15px;">Bill Details</h3>
                <div style="margin-bottom: 15px;">
                  <strong>Bill ID:</strong> \${bill.billId}<br>
                  <strong>Date:</strong> \${new Date(bill.timestamp).toLocaleString()}<br>
                  <strong>Status:</strong> <span style="color: #38ef7d;">✓ Paid</span>
                </div>
                <div style="background: #f7f9fc; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                  <strong>Items:</strong>
                  \${bill.items.map(item => \`
                    <div class="bill-item">
                      <span>\${item.name} ×\${item.quantity}</span>
                      <span>₹\${item.price * item.quantity}</span>
                    </div>
                  \`).join('')}
                </div>
                <div style="text-align: right; font-size: 20px; font-weight: 700; color: #667eea;">
                  Total: ₹\${bill.total}
                </div>
              \`;
              resultDiv.classList.add('show');
            } else {
              errorDiv.textContent = 'Bill not found';
              errorDiv.classList.add('show');
            }
          } catch (error) {
            errorDiv.textContent = 'Error checking bill: ' + error.message;
            errorDiv.classList.add('show');
          }
        }
        
        // Allow Enter key to submit
        document.getElementById('billIdInput').addEventListener('keypress', (e) => {
          if (e.key === 'Enter') checkBill();
        });
      </script>
    </body>
    </html>
  `);
});

// Start server
const PORT = process.env.PORT || 3000;

loadData().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`💳 Razorpay integration active`);
  });
});