const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── הגדרות ───────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STOREAIX_API_KEY  = process.env.STOREAIX_API_KEY  || 'edb109158f6144d0a5e86e9d7d30542f';
const STOREAIX_APP_ID   = process.env.STOREAIX_APP_ID   || '68db904e3c792b7c9cbaba20';
const VENDOR_ID         = process.env.VENDOR_ID         || '690aee7a415f7dff3d5525d8';
const STOREAIX_BASE     = `https://app.base44.com/api/apps/${STOREAIX_APP_ID}`;

if (!ANTHROPIC_API_KEY) {
  console.error('❌ חסר ANTHROPIC_API_KEY');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const conversations = {};

// ─── storeAIx API ─────────────────────────────────────────
async function storeAIxApi(endpoint, method = 'GET', body = null) {
  const res = await fetch(`${STOREAIX_BASE}/${endpoint}`, {
    method,
    headers: { 'api-key': STOREAIX_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`storeAIx ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── הודעת ברכה קבועה ─────────────────────────────────────
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

━━━━━━━━━━━━━━━━━━━━━━
שלב 1 — אחרי אישור כמות תמונות (שאלה אחת משולבת):
"קיבלתי [X] תמונות 📸
איזה גודל, גימור וסניף?
• גודל: 10×15 / 13×18 / 15×21 / 20×30 / אחר
• גימור: מבריק או מט | עם מסגרת או בלי
• סניף: רעננה או משמר השרון"

שלב 2 — אחרי שהלקוח ענה, חשב מחיר וכתוב סיכום:
"סיכום:
[X] תמונות | [גודל] | [גימור] | [סניף]
💰 סה"כ ₪[מחיר]

[שדרוג אחד קצר בלבד]:
• ילדים/נכדים → בלוק עץ 13×18 ₪75 😊
• זוגי/רומנטי → קנבס 30×40 ₪180 😊
• כללי → מגנט ₪10 😊
להוסיף?"

שלב 3 — אחרי תשובת לקוח:
"ההזמנה התקבלה 🎉 ניצור קשר כשמוכן!"

━━━━━━━━━━━━━━━━━━━━━━
כללים:
- אל תשאל שם
- אל תגיב על תמונות
- אל תכתוב "ההזמנה התקבלה" לפני שיש גודל + גימור + סניף
- תמונות מעל 15×21 → https://www.adsale.co.il`;

// ─── שיחה ────────────────────────────────────────────────
function getConversation(phone, name) {
  if (!conversations[phone]) {
    conversations[phone] = {
      phone,
      customerName:    name || null,
      branch:          null,
      messages:        [],
      imageCount:      0,
      expectedImages:  null,
      imagesConfirmed: false,
      size:            null,
      paperType:       null,
      frame:           null,
      orderCreated:    false,
      greeted:         false,
    };
  }
  if (name && !conversations[phone].customerName) {
    conversations[phone].customerName = name;
  }
  return conversations[phone];
}

// ─── חילוץ פרטים מטקסט ───────────────────────────────────
function extractFromMessage(conv, text) {
  if (!conv.branch) {
    if (text.includes('רעננה'))                          conv.branch = 'רעננה';
    if (text.includes('משמר') || text.includes('השרון')) conv.branch = 'משמר השרון';
  }
  if (text.includes('מבריק'))                            conv.paperType = 'מבריק';
  if (text.includes('מט') && !text.includes('מטר'))      conv.paperType = 'מט';
  if (text.includes('עם מסגרת'))                         conv.frame = true;
  if (text.includes('בלי') || text.includes('ללא'))      conv.frame = false;
  const sz = text.match(/(\d+)\s*[xX×]\s*(\d+)/);
  if (sz && !conv.size) conv.size = `${sz[1]}x${sz[2]}`;
}

// ─── זיהוי "סיום X" ───────────────────────────────────────
function parseCompletion(text) {
  if (!text) return null;
  const patterns = [
    /סיום\s*(\d+)/,
    /זהו\s*(\d+)/,
    /זה הכל\s*(\d+)/,
    /סה"כ\s*(\d+)/,
    /(\d+)\s*זה הכל/,
    /(\d+)\s*תמונות?\s*(סיום|זהו|הכל)/,
    /שלחתי\s*(\d+)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseInt(m[1]);
  }
  return null;
}

// ─── חילוץ הזמנה עם AI ────────────────────────────────────
async function extractOrderDetails(conv) {
  const history = conv.messages.slice(-30)
    .map(m => `${m.role === 'user' ? 'לקוח' : 'חנות'}: ${m.content}`)
    .join('\n');

  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    system: 'Extract print order from Hebrew WhatsApp. Return ONLY valid JSON, no markdown.',
    messages: [{
      role: 'user',
      content: `שם: ${conv.customerName} | סניף: ${conv.branch}
שיחה:\n${history}
JSON: {"customer_name":"...","branch":"...","size":"...","paper_type":"מבריק/מט","frame":true/false,"image_count":0,"total_price":0,"upgrade_product":null}`
    }]
  });

  try {
    return JSON.parse(resp.content[0].text.trim().replace(/```json?|```/g, ''));
  } catch (e) {
    console.error('❌ JSON:', e.message);
    return null;
  }
}

// ─── יצירת הזמנה ─────────────────────────────────────────
async function createPrintOrder(conv, details) {
  const name    = conv.customerName   || details?.customer_name   || 'לקוח WhatsApp';
  const branch  = conv.branch         || details?.branch          || null;
  const size    = conv.size           || details?.size            || '13x18';
  const paper   = conv.paperType      || details?.paper_type      || 'מבריק';
  const frame   = conv.frame          ?? details?.frame           ?? false;
  const count   = conv.expectedImages || conv.imageCount          || 0;
  const price   = details?.total_price || 0;
  const upgrade = details?.upgrade_product || null;

  await storeAIxApi('entities/PrintOrder', 'POST', {
    customer_name:            name,
    customer_phone:           conv.phone,
    image_count:              count,
    total_images:             count,
    size, paper_type: paper, frame,
    total_price:              price,
    total_amount:             price,
    upgrade_product:          upgrade,
    notes:                    branch ? `סניף: ${branch}` : '',
    vendor_id:                VENDOR_ID,
    source:                   'whatsapp',
    whatsapp_conversation_id: `wa_${conv.phone}`,
    status:                   'pending_printing',
  });

  console.log('\n═══════════════════════════════════');
  console.log('✅ הזמנה נוצרה:');
  console.log(`   👤 ${name} | 📞 ${conv.phone}`);
  console.log(`   📍 ${branch || 'לא צוין'} | 📸 ${count} תמונות`);
  console.log(`   📐 ${size} | 🖨️  ${paper} | 🖼️  ${frame ? 'עם מסגרת' : 'בלי מסגרת'}`);
  console.log(`   💰 ₪${price} | 🎁 ${upgrade || 'ללא שדרוג'}`);
  console.log('═══════════════════════════════════\n');
}

// ─── AI response ──────────────────────────────────────────
async function getAIResponse(conv, userMessage) {
  conv.messages.push({ role: 'user', content: userMessage });
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: conv.messages.map(m => ({ role: m.role, content: m.content })),
  });
  const reply = resp.content[0].text;
  conv.messages.push({ role: 'assistant', content: reply });
  return reply;
}

// ─── WhatsApp Client ───────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

client.on('qr', (qr) => {
  console.log('\n══════════════════════════════════════════');
  console.log('   📱 סרוק QR: WhatsApp → מכשירים מקושרים');
  console.log('══════════════════════════════════════════\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('🔐 אומת!'));
client.on('ready', () => {
  console.log('\n✅ Bot מוכן — עדשה מקומית');
  console.log('   סניפים: רעננה | משמר השרון\n');
});
client.on('auth_failure', msg => console.error('❌ אימות נכשל:', msg));
client.on('disconnected', reason => {
  console.warn('⚠️ התנתק:', reason);
  setTimeout(() => client.initialize(), 10000);
});

// ─── הודעות נכנסות ────────────────────────────────────────
client.on('message', async (msg) => {
  try {
    if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;

    const phone   = msg.from.replace('@c.us', '');
    const contact = await msg.getContact();
    const name    = contact.pushname || contact.name || null;
    const conv    = getConversation(phone, name);

    // ── תמונה: שקט מוחלט ──────────────────────────────────
    if (msg.hasMedia && msg.type === 'image') {
      conv.imageCount++;
      console.log(`📸 #${conv.imageCount} מ-${name || phone}`);
      return;
    }

    const text = msg.body || '';
    console.log(`💬 ${name || phone}: ${text}`);

    // ── ברכה ראשונה ───────────────────────────────────────
    if (!conv.greeted) {
      conv.greeted = true;
      await msg.reply(buildGreeting(name));
      return;
    }

    extractFromMessage(conv, text);

    // ── סיום X ────────────────────────────────────────────
    const declared = parseCompletion(text);
    if (declared !== null && !conv.imagesConfirmed) {
      conv.expectedImages = declared;
      console.log(`🔢 הצהיר ${declared} | התקבלו ${conv.imageCount}`);

      if (conv.imageCount >= declared) {
        conv.imagesConfirmed = true;
        const reply = await getAIResponse(
          conv,
          `[סיום: ${declared} תמונות אושרו. שאל גודל + גימור + סניף בהודעה אחת.]`
        );
        await msg.reply(reply);
      } else {
        const missing = declared - conv.imageCount;
        await msg.reply(
          `קיבלתי ${conv.imageCount} מתוך ${declared} תמונות 📸\nממתין ל-${missing} נוספות...\nכשסיימת כתוב/י שוב *סיום ${declared}*`
        );
      }
      return;
    }

    // ── הודעה רגילה → AI ──────────────────────────────────
    const reply = await getAIResponse(conv, text);
    await msg.reply(reply);

    if (reply.includes('ההזמנה התקבלה') && !conv.orderCreated) {
      conv.orderCreated = true;
      const details = await extractOrderDetails(conv);
      await createPrintOrder(conv, details);
    }

  } catch (err) {
    console.error('❌ שגיאה:', err.message);
  }
});

console.log('🚀 מאתחל — עדשה מקומית...');
client.initialize();

