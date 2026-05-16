const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');
const path = require('path');

// ─── הגדרות ───────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STOREAIX_API_KEY  = process.env.STOREAIX_API_KEY  || 'edb109158f6144d0a5e86e9d7d30542f';
const STOREAIX_APP_ID   = process.env.STOREAIX_APP_ID   || '68db904e3c792b7c9cbaba20';
const VENDOR_ID         = process.env.VENDOR_ID         || '690aee7a415f7dff3d5525d8';
const STOREAIX_BASE     = `https://app.base44.com/api/apps/${STOREAIX_APP_ID}`;
const PORT              = process.env.PORT || 3000;

if (!ANTHROPIC_API_KEY) {
  console.error('❌ חסר ANTHROPIC_API_KEY');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const conversations = {};
let currentQR = null;

// ─── HTTP request helper (no external deps) ───────────────
function httpsRequest(url, options, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

// ─── storeAIx API ─────────────────────────────────────────
async function storeAIxApi(endpoint, method = 'GET', body = null) {
  const bodyStr = body ? JSON.stringify(body) : null;
  const res = await httpsRequest(`${STOREAIX_BASE}/${endpoint}`, {
    method,
    headers: {
      'api-key': STOREAIX_API_KEY,
      'Content-Type': 'application/json',
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
    },
  }, bodyStr ? Buffer.from(bodyStr) : null);

  if (res.status >= 400) throw new Error(`storeAIx ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
}

// ─── Upload image to Base44 ───────────────────────────────
async function uploadImage(imgBuffer, filename, mimetype) {
  try {
    const boundary = '----WaBotBoundary' + Date.now();
    const hdr = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`
    );
    const ftr = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyBuf = Buffer.concat([hdr, imgBuffer, ftr]);

    const res = await httpsRequest(
      `${STOREAIX_BASE}/files/upload`,
      {
        method: 'POST',
        headers: {
          'api-key': STOREAIX_API_KEY,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyBuf.length,
        },
      },
      bodyBuf
    );

    if (res.status === 200 || res.status === 201) {
      const data = JSON.parse(res.body);
      return data.file_url || data.url || null;
    }
    console.log(`⚠️ העלאה נכשלה ${res.status}: ${res.body.substring(0, 100)}`);
    return null;
  } catch (e) {
    console.error('❌ שגיאת upload:', e.message);
    return null;
  }
}

// ─── HTTP Server לQR ──────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr') {
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>✅ הבוט כבר מחובר! אין צורך בQR.</h2>');
      return;
    }
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 400 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html><body style="text-align:center; font-family:Arial; background:#111; color:#fff">
        <h2>📱 סרוק עם WhatsApp</h2>
        <p>WhatsApp → מכשירים מקושרים → קשר מכשיר</p>
        <img src="${qrImage}" style="border:4px solid white; border-radius:8px"/>
        <p>הדף מתרענן אוטומטית כל 15 שניות</p>
        <script>setTimeout(()=>location.reload(), 15000)</script>
        </body></html>
      `);
    } catch(e) {
      res.writeHead(500); res.end('Error: ' + e.message);
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>✅ עדשה מקומית WhatsApp Bot פעיל!</h2><p><a href="/qr" style="color:cyan">לחץ כאן לQR</a></p>');
  }
});
server.listen(PORT, () => console.log(`🌐 Server: http://localhost:${PORT}`));

// ─── הודעת ברכה ───────────────────────────────────────────
function buildGreeting(name) {
  return `שלום${name ? ' ' + name : ''}! 😊
ברוכים הבאים לעדשה מקומית 📸

אתם מוזמנים לשלוח את התמונות.
כשסיימתם לשלוח — כתבו *סיום* ואת מספר התמונות ששלחתם.
לדוגמה: אם שלחתם 23 תמונות, כתבו *סיום 23*`;
}

// ─── פרומפט AI ────────────────────────────────────────────
const SYSTEM_PROMPT = `אתה סוכן מכירות של עדשה מקומית - חנות הדפסות בישראל.
עברית בלבד. קצר. אמוג'י אחד לכל הודעה.

💰 מחירים:
10×15=₪1.80 | 13×18=₪3.50 | 15×21=₪10 | 18×24=₪18 | 20×30=₪23
30×40=₪45 | 40×60=₪90 | 50×70=₪120 | 60×90=₪170
קנבס: 30×40=₪180 | 40×60=₪260 | 50×70=₪320
בלוק עץ: 10×10=₪45 | 13×18=₪75 | 20×30=₪120
זכוכית: 30×40=₪90 | 40×60=₪160
מגנט=₪10 | ספל=₪34.90 | חולצה=₪65 | מחזיק מפתחות=₪24.90
מינימום הזמנה: ₪10

סניפים: רעננה | משמר השרון

שלב 1 — אחרי אישור כמות תמונות:
"קיבלתי [X] תמונות 📸
באיזה גודל, גימור וסניף תרצה?
• גודל: 10×15 (₪1.80) | 13×18 (₪3.50) | 15×21 (₪10) | 20×30 (₪23)
• גימור: מבריק או מט | עם מסגרת או בלי
• סניף: רעננה או משמר השרון"

שלב 2 — אחרי שהלקוח ענה, חשב מחיר:
"סיכום:
[X] תמונות | [גודל] | [גימור] | [סניף]
💰 סה"כ ₪[מחיר]
להוסיף שדרוג? (בלוק עץ / מגנט / קנבס)"

שלב 3 — אחרי אישור:
"ההזמנה התקבלה 🎉 ניצור קשר כשמוכן!"

כללים:
- אל תשאל שם
- אל תגיב על תמונות
- אל תכתוב "ההזמנה התקבלה" לפני שיש גודל + גימור + סניף
- תמונות מעל 15×21 → https://www.adsale.co.il`;

// ─── שיחה ─────────────────────────────────────────────────
function getConversation(phone, name) {
  if (!conversations[phone]) {
    conversations[phone] = {
      phone, customerName: name || null, branch: null,
      messages: [], imageCount: 0, expectedImages: null,
      imagesConfirmed: false, size: null, paperType: null,
      frame: null, orderCreated: false, greeted: false,
      imageUrls: [],
    };
  }
  if (name && !conversations[phone].customerName) conversations[phone].customerName = name;
  return conversations[phone];
}

function extractFromMessage(conv, text) {
  if (!conv.branch) {
    if (text.includes('רעננה')) conv.branch = 'רעננה';
    if (text.includes('משמר') || text.includes('השרון')) conv.branch = 'משמר השרון';
  }
  if (text.includes('מבריק')) conv.paperType = 'מבריק';
  if (text.includes('מט') && !text.includes('מטר')) conv.paperType = 'מט';
  if (text.includes('עם מסגרת')) conv.frame = true;
  if (text.includes('בלי') || text.includes('ללא')) conv.frame = false;
  const sz = text.match(/(\d+)\s*[xX×]\s*(\d+)/);
  if (sz && !conv.size) conv.size = `${sz[1]}x${sz[2]}`;
}

function parseCompletion(text) {
  if (!text) return null;
  const patterns = [/סיום\s*(\d+)/, /זהו\s*(\d+)/, /זה הכל\s*(\d+)/, /שלחתי\s*(\d+)/, /(\d+)\s*תמונות/];
  for (const p of patterns) { const m = text.match(p); if (m) return parseInt(m[1]); }
  return null;
}

async function extractOrderDetails(conv) {
  const history = conv.messages.slice(-20).map(m =>
    `${m.role === 'user' ? 'לקוח' : 'חנות'}: ${m.content}`
  ).join('\n');

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5', max_tokens: 400,
    system: 'Extract print order details from Hebrew WhatsApp conversation. Return ONLY valid JSON.',
    messages: [{ role: 'user', content: `שם: ${conv.customerName} | סניף: ${conv.branch}\nשיחה:\n${history}\nJSON: {"customer_name":"...","branch":"...","size":"...","paper_type":"מבריק/מט","frame":true/false,"image_count":0,"total_price":0,"upgrade_product":null}` }]
  });

  try {
    return JSON.parse(resp.content[0].text.trim().replace(/```json?|```/g, ''));
  } catch(e) {
    console.error('❌ JSON parse:', e.message);
    return null;
  }
}

async function createPrintOrder(conv, details) {
  const name   = conv.customerName || details?.customer_name || 'לקוח WhatsApp';
  const branch = conv.branch || details?.branch || null;
  const size   = conv.size || details?.size || '13x18';
  const paper  = conv.paperType || details?.paper_type || 'מבריק';
  const frame  = conv.frame ?? details?.frame ?? false;
  const count  = conv.expectedImages || conv.imageCount || 0;
  const price  = details?.total_price || 0;

  // נקה מספר טלפון לפורמט ישראלי
  const cleanPhone = conv.phone.replace(/^972/, '0').replace(/\D/g, '');

  // בנה notes עם קישורי תמונות
  const imagesList = conv.imageUrls.length > 0
    ? `\nתמונות (${conv.imageUrls.length}):\n` + conv.imageUrls.join('\n')
    : '';
  const notesText = [branch ? `סניף: ${branch}` : '', imagesList].filter(Boolean).join('\n');

  const payload = {
    customer_name: name,
    customer_phone: cleanPhone,
    image_count: count,
    total_images: count,
    size: size,
    paper_type: paper,
    frame: frame,
    total_price: price,
    total_amount: price,
    notes: notesText,
    vendor_id: VENDOR_ID,
    source: 'whatsapp',
    whatsapp_conversation_id: `wa_${conv.phone}`,
    status: 'pending_printing',
  };

  console.log('📦 יוצר הזמנה:', JSON.stringify(payload).substring(0, 200));
  await storeAIxApi('entities/PrintOrder', 'POST', payload);
  console.log(`✅ הזמנה נוצרה: ${name} | ${cleanPhone} | ${count} תמונות | ${size} | ₪${price}`);
}

async function getAIResponse(conv, userMessage) {
  conv.messages.push({ role: 'user', content: userMessage });
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5', max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: conv.messages.map(m => ({ role: m.role, content: m.content })),
  });
  const reply = resp.content[0].text;
  conv.messages.push({ role: 'assistant', content: reply });
  return reply;
}

// ─── WhatsApp Client ───────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ 
    dataPath: './.wwebjs_auth',
    clientId: 'adasha-bot'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
    ],
  },
});

client.on('qr', (qr) => {
  currentQR = qr;
  console.log('\n══════════════════════════════════════════');
  console.log('   📱 QR מוכן! פתח בדפדפן: /qr');
  console.log('══════════════════════════════════════════\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => { currentQR = null; console.log('🔐 אומת בהצלחה!'); });
client.on('ready', () => { currentQR = null; console.log('\n✅ Bot מוכן — עדשה מקומית\n'); });
client.on('auth_failure', msg => console.error('❌ אימות נכשל:', msg));
client.on('disconnected', reason => {
  console.warn('⚠️ התנתק:', reason);
  setTimeout(() => client.initialize(), 10000);
});

client.on('message', async (msg) => {
  try {
    if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;

    const phone = msg.from.replace('@c.us', '');
    const contact = await msg.getContact();
    const name = contact.pushname || contact.name || null;
    const conv = getConversation(phone, name);

    // טיפול בתמונות
    if (msg.hasMedia && msg.type === 'image') {
      conv.imageCount++;
      console.log(`📸 #${conv.imageCount} מ-${name || phone}`);
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const imgBuffer = Buffer.from(media.data, 'base64');
          const ext = media.mimetype.includes('jpeg') ? 'jpg' : 'png';
          const filename = `wa_${phone}_img${conv.imageCount}.${ext}`;
          const fileUrl = await uploadImage(imgBuffer, filename, media.mimetype);
          if (fileUrl) {
            conv.imageUrls.push(fileUrl);
            console.log(`✅ תמונה #${conv.imageCount} הועלתה`);
          }
        }
      } catch(imgErr) {
        console.error('❌ שגיאת תמונה:', imgErr.message);
      }
      return;
    }

    const text = (msg.body || '').trim();
    if (!text) return;
    console.log(`💬 ${name || phone}: ${text}`);

    // reset שיחה
    if (text.toLowerCase() === 'reset' || text === 'איפוס') {
      delete conversations[phone];
      await msg.reply('✅ השיחה אופסה.');
      return;
    }

    if (!conv.greeted) {
      conv.greeted = true;
      await msg.reply(buildGreeting(name));
      return;
    }

    extractFromMessage(conv, text);

    const declared = parseCompletion(text);
    if (declared !== null && !conv.imagesConfirmed) {
      conv.expectedImages = declared;
      conv.imagesConfirmed = true;
      const orderMsg = `קיבלתי ${declared} תמונות! 📸

באיזה גודל, גימור וסניף תרצה?
• גודל: 10×15 (₪1.80) | 13×18 (₪3.50) | 15×21 (₪10) | 20×30 (₪23)
• גימור: מבריק או מט | עם מסגרת או בלי
• סניף: רעננה או משמר השרון`;
      conv.messages.push({ role: 'assistant', content: orderMsg });
      await msg.reply(orderMsg);
      return;
    }

    const reply = await getAIResponse(conv, text);

    if (reply.includes('ההזמנה התקבלה') && !conv.orderCreated) {
      conv.orderCreated = true;
      try {
        const details = await extractOrderDetails(conv);
        await createPrintOrder(conv, details);
      } catch(e) {
        console.error('❌ שגיאה ביצירת הזמנה:', e.message);
      }
    }

    await msg.reply(reply);
  } catch(err) {
    console.error('❌ שגיאה:', err.message);
  }
});

// מחק lock files ישנים לפני initialize
const fs = require('fs');
const lockPaths = [
  './.wwebjs_auth/puppeteer_profile/SingletonLock',
  './.wwebjs_auth/puppeteer_profile/SingletonCookie',
  './.wwebjs_auth/puppeteer_profile/SingletonSocket',
  './.wwebjs_auth/session-adasha-bot/SingletonLock',
  './.wwebjs_auth/session-adasha-bot/SingletonCookie',
  './.wwebjs_auth/session-adasha-bot/SingletonSocket',
];
lockPaths.forEach(f => {
  try { fs.unlinkSync(f); console.log('🗑️ מחק lock:', f); } catch(e) {}
});

client.initialize();
