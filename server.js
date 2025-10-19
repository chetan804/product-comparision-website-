require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const USERS_FILE = path.join(__dirname, 'data', 'users.json');

const SERPAPI_KEY = process.env.SERPAPI_KEY;
const FLIPKART_ID = process.env.FLIPKART_AFFILIATE_ID;
const FLIPKART_TOKEN = process.env.FLIPKART_AFFILIATE_TOKEN;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// ---------- Helpers for users ----------
function loadUsers(){
  if(!fs.existsSync(USERS_FILE)) return [];
  try {
    const raw = fs.readFileSync(USERS_FILE);
    return JSON.parse(raw);
  } catch(e){
    return [];
  }
}
function saveUsers(users){
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ---------- Auth routes ----------
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if(!email || !password) return res.status(400).json({ error: 'email and password required' });
  const users = loadUsers();
  if(users.find(u => u.email === email)) return res.status(400).json({ error: 'email already in use' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: Date.now(), name: name || '', email, passwordHash: hash };
  users.push(user);
  saveUsers(users);
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const users = loadUsers();
  const user = users.find(u => u.email === email);
  if(!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if(!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

function requireAuth(req, res, next){
  const auth = req.headers.authorization;
  if(!auth) return res.status(401).json({ error: 'missing auth token' });
  const [scheme, token] = auth.split(' ');
  if(scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'invalid auth header' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch(e){
    return res.status(401).json({ error: 'invalid token' });
  }
}

// ---------- Source fetchers ----------

// 1) SerpApi (Google Shopping)
async function fetchFromSerpApi(q){
  if(!SERPAPI_KEY) throw new Error('SERPAPI_KEY not configured');
  const url = 'https://serpapi.com/search';
  const params = { engine: 'google_shopping', q, api_key: SERPAPI_KEY, num: 10 };
  const r = await axios.get(url, { params, timeout: 15000 });
  const items = r.data.shopping_results || [];
  return items.map(item => ({
    source: item.source || item.shop || 'unknown',
    title: item.title,
    price: item.price || item.extracted_price || null,
    link: item.link || item.product_link || null,
    thumbnail: item.thumbnail || (item.thumbnails && item.thumbnails[0]) || null,
    raw: item
  }));
}

// 2) Flipkart Affiliate API (if configured)
async function fetchFromFlipkartAffiliate(q){
  if(!FLIPKART_ID || !FLIPKART_TOKEN) throw new Error('Flipkart affiliate keys missing');
  const url = 'https://affiliate-api.flipkart.net/affiliate/search/json';
  const res = await axios.get(url, {
    params: { query: q, resultCount: 10 },
    headers: {
      'Fk-Affiliate-Id': FLIPKART_ID,
      'Fk-Affiliate-Token': FLIPKART_TOKEN
    },
    timeout: 10000
  });
  // response format may vary. Try several keys:
  const products = res.data.products || res.data.productInfoList || res.data.product || [];
  const out = [];
  if(Array.isArray(products)){
    for(const p of products){
      const title = (p.productBaseInfoV1 && p.productBaseInfoV1.title) || p.title || (p.product && p.product.title) || '';
      const price = (p.productBaseInfoV1 && p.productBaseInfoV1.flipkartSellingPrice && p.productBaseInfoV1.flipkartSellingPrice.amount)
                    || (p.productBaseInfoV1 && p.productBaseInfoV1.maximumRetailPrice && p.productBaseInfoV1.maximumRetailPrice.amount)
                    || p.price || null;
      const link = (p.productBaseInfoV1 && p.productBaseInfoV1.productUrl) || p.productUrl || p.url || null;
      const thumbnail = (p.productBaseInfoV1 && p.productBaseInfoV1.imageUrls && p.productBaseInfoV1.imageUrls.length && p.productBaseInfoV1.imageUrls[0]) || p.imageUrl || null;
      out.push({ source: 'flipkart', title, price, link, thumbnail, raw: p });
    }
  }
  return out;
}

// 3) Ajio via Apify (optional)
async function fetchFromAjioApify(q){
  if(!APIFY_TOKEN) throw new Error('APIFY_TOKEN missing');
  // NOTE: Replace actorId with the actor you choose on Apify marketplace that scrapes Ajio.
  const actorId = 'easyapi/ajio-product-scraper';
  const runUrl = `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`;
  const startRes = await axios.post(runUrl, { searchQuery: q }, { timeout: 15000 });
  const run = startRes.data;
  const runId = run.data && run.data.id;
  if(!runId) return [];
  const getRunUrl = `https://api.apify.com/v2/acts/${actorId}/runs/${runId}?token=${APIFY_TOKEN}`;
  // poll for success (simple)
  for(let i = 0; i < 20; i++){
    await new Promise(r => setTimeout(r, 1500));
    const st = await axios.get(getRunUrl, { timeout: 10000 });
    const status = st.data && st.data.data && st.data.data.status;
    if(status === 'SUCCEEDED'){
      const datasetId = st.data.data.defaultDatasetId;
      const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`;
      const items = (await axios.get(datasetUrl, { timeout: 10000 })).data || [];
      return items.map(it => ({
        source: 'ajio',
        title: it.title || it.name || '',
        price: it.price || it.final_price || null,
        link: it.url || it.product_link || null,
        thumbnail: it.image || null,
        raw: it
      }));
    }
  }
  return [];
}

// ---------- Aggregation endpoint ----------
app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  if(!q) return res.status(400).json({ error: 'query param q required' });

  const tasks = [];

  // SerpApi (recommended minimal)
  if(SERPAPI_KEY) tasks.push(fetchFromSerpApi(q).catch(e => { console.error('serp error', e.message); return []; }));
  else tasks.push(Promise.resolve([]));

  // Flipkart (optional)
  if(FLIPKART_ID && FLIPKART_TOKEN) tasks.push(fetchFromFlipkartAffiliate(q).catch(e => { console.error('flipkart error', e.message); return []; }));
  else tasks.push(Promise.resolve([]));

  // Ajio via Apify (optional)
  if(APIFY_TOKEN) tasks.push(fetchFromAjioApify(q).catch(e => { console.error('apify ajio error', e.message); return []; }));
  else tasks.push(Promise.resolve([]));

  const [serpResults, flipkartResults, ajioResults] = await Promise.all(tasks);

  // Combine and dedupe by link or title
  const combined = [...flipkartResults, ...ajioResults, ...serpResults];
  const seen = new Set();
  const out = [];
  for(const it of combined){
    const key = (it.link || it.title || '').split('?')[0];
    if(!key) continue;
    if(seen.has(key)) continue;
    seen.add(key);
    let price = it.price;
    if(typeof price === 'string') price = Number(String(price).replace(/[^\d.]/g,'')) || null;
    out.push({ title: it.title, price, link: it.link, thumbnail: it.thumbnail, source: it.source, raw: it.raw });
  }

  // sort by price where numeric
  out.sort((a,b) => {
    const pa = typeof a.price === 'number' ? a.price : Infinity;
    const pb = typeof b.price === 'number' ? b.price : Infinity;
    return pa - pb;
  });

  res.json({ query: q, results: out });
});

// --------- Serve frontend fallback ----------
app.get('*', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
