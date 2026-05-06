// WSB Intelligence — Backend Server v4
// StockTwits + Yahoo Finance + persistent positions on disk

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3456;
const POSITIONS_FILE = path.join(__dirname, 'positions.json');

// ─── Persistent positions ─────────────────────────────────────────────────────
function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) return JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
  } catch(e) { console.log('Load positions error:', e.message); }
  return [];
}
function savePositions(p) {
  try { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }
  catch(e) { console.log('Save positions error:', e.message); }
}

let POSITIONS = loadPositions();
console.log(`  Loaded ${POSITIONS.length} existing positions`);

const TICKERS = [
  'NVDA','TSLA','AAPL','AMD','META','MSFT','AMZN','PLTR','COIN','GME',
  'SPY','QQQ','ARM','SMCI','MSTR','GOOGL','NFLX','SOFI','HOOD','RIVN',
  'BAC','JPM','INTC','SHOP','NET'
];

function get(reqUrl) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(reqUrl);
    const req = https.request({
      hostname: parsed.hostname, path: parsed.path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WSBDashboard/1.0)', 'Accept': 'application/json' },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return get(res.headers.location).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('JSON parse failed')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchStockTwits(ticker) {
  try {
    const data = await get(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json?limit=30`);
    return (data?.messages || []).map(m => ({
      id: String(m.id), text: m.body || '', author: m.user?.username || 'unknown',
      score: m.likes?.total || 0, ticker,
      sentiment: m.entities?.sentiment?.basic || null
    }));
  } catch(e) { console.log(`  StockTwits ${ticker}: ${e.message}`); return []; }
}

async function fetchPrice(ticker) {
  try {
    const data = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice || meta.previousClose;
    const prev = meta.previousClose || price;
    return { price: +price.toFixed(2), change: price && prev ? +((price-prev)/prev*100).toFixed(2) : 0 };
  } catch(e) { return null; }
}

const BULL = ['buy','bull','long','moon','calls','squeeze','rip','pump','green','profit','gain','yolo','hold','hodl','rocket','growth','beat','bullish','upside','breakout','accumulate','dip'];
const BEAR = ['sell','short','bear','puts','crash','dump','down','red','loss','fail','drop','tank','falling','decline','avoid','overvalued','bearish','downside','weak'];

function scoreSentiment(text, st) {
  if (st === 'Bullish') return 'positive';
  if (st === 'Bearish') return 'negative';
  const l = text.toLowerCase(); let b = 0, r = 0;
  BULL.forEach(w => { if (l.includes(w)) b++; });
  BEAR.forEach(w => { if (l.includes(w)) r++; });
  return b > r ? 'positive' : r > b ? 'negative' : 'neutral';
}

function detectCall(text, st) {
  if (st === 'Bullish') return 'buy';
  if (st === 'Bearish') return 'sell';
  const l = text.toLowerCase();
  if (/\b(buying|bought|buy|long|calls|bullish on|yolo|loaded up|accumulating|dip buy)\b/.test(l)) return 'buy';
  if (/\b(shorting|shorted|short|puts|bearish on|selling|sold|dumping)\b/.test(l)) return 'sell';
  return 'none';
}

function openPosition(user, ticker, call, price, text) {
  // Unique key — one position per user+ticker+call direction, ever
  const key = `${user}__${ticker}__${call}`;
  if (POSITIONS.find(p => p.key === key)) return; // already exists, never overwrite
  const pos = {
    key, id: key + '__' + Date.now(),
    user, ticker, call,
    entryPrice: price,    // LOCKED — set once, never changes
    currentPrice: price,  // updates on every refresh
    currentChange: 0,
    stake: 1000,
    pnl: 0, pct: 0,
    openedAt: new Date().toISOString(),
    date: new Date().toLocaleDateString(),
    text: text.slice(0, 80),
    sub: 'StockTwits'
  };
  POSITIONS.push(pos);
  savePositions(POSITIONS);
  console.log(`  + Opened: ${call.toUpperCase()} $${ticker} @ $${price} by u/${user}`);
}

function enrichPnl(p) {
  if (!p.currentPrice || !p.entryPrice) return { ...p, pnl: 0, pct: 0 };
  const pnl = p.call === 'buy'
    ? (p.currentPrice - p.entryPrice) / p.entryPrice * p.stake
    : (p.entryPrice - p.currentPrice) / p.entryPrice * p.stake;
  const pct = p.call === 'buy'
    ? (p.currentPrice - p.entryPrice) / p.entryPrice * 100
    : (p.entryPrice - p.currentPrice) / p.entryPrice * 100;
  return { ...p, pnl: +pnl.toFixed(2), pct: +pct.toFixed(2) };
}

async function fetchAllData() {
  console.log('\n  === Fetching data ===');
  const stockMap = {}, userMap = {}, priceCache = {};
  let totalPosts = 0;

  for (let i = 0; i < TICKERS.length; i++) {
    const ticker = TICKERS[i];
    process.stdout.write(`  [${i+1}/25] $${ticker}... `);
    const [mRes, pRes] = await Promise.allSettled([fetchStockTwits(ticker), fetchPrice(ticker)]);
    const msgs = mRes.status === 'fulfilled' ? mRes.value : [];
    const price = pRes.status === 'fulfilled' ? pRes.value : null;
    if (price) priceCache[ticker] = price;
    if (!stockMap[ticker]) stockMap[ticker] = { ticker, mentions: 0, pos: 0, neg: 0, neu: 0, price: null, change: 0 };
    if (price) { stockMap[ticker].price = price.price; stockMap[ticker].change = price.change; }
    msgs.forEach(msg => {
      totalPosts++;
      const sent = scoreSentiment(msg.text, msg.sentiment);
      const call = detectCall(msg.text, msg.sentiment);
      stockMap[ticker].mentions++;
      stockMap[ticker][sent === 'positive' ? 'pos' : sent === 'negative' ? 'neg' : 'neu']++;
      const u = msg.author;
      if (!userMap[u]) userMap[u] = { posts: 0, calls: [], tickers: new Set(), bias: { buy: 0, sell: 0 }, score: 0 };
      userMap[u].posts++; userMap[u].score += (msg.score || 0); userMap[u].tickers.add(ticker);
      if ((call === 'buy' || call === 'sell') && price && price.price > 0) {
        userMap[u].calls.push({ ticker, call, text: msg.text, sent });
        userMap[u].bias[call]++;
        openPosition(u, ticker, call, price.price, msg.text);
      }
    });
    console.log(`${msgs.length} msgs, $${price?.price || 'N/A'}`);
    await sleep(300);
  }

  // Update currentPrice on ALL positions — entryPrice never touched
  let saved = false;
  for (const pos of POSITIONS) {
    const cached = priceCache[pos.ticker];
    if (cached) {
      pos.currentPrice = cached.price;
      pos.currentChange = cached.change;
      saved = true;
    } else {
      const pd = await fetchPrice(pos.ticker);
      if (pd) { pos.currentPrice = pd.price; pos.currentChange = pd.change; saved = true; }
      await sleep(200);
    }
  }
  if (saved) savePositions(POSITIONS);

  const enrichedPositions = POSITIONS.map(enrichPnl);
  const stocks = Object.values(stockMap).sort((a, b) => b.mentions - a.mentions);
  const totalPos = stocks.reduce((a, s) => a + s.pos, 0);
  const totalNeg = stocks.reduce((a, s) => a + s.neg, 0);

  const users = Object.entries(userMap).map(([name, d]) => {
    const up = enrichedPositions.filter(p => p.user === name);
    const wins = up.filter(p => p.pnl > 0).length;
    return {
      username: name, sub: 'StockTwits', posts: d.posts, score: d.score,
      bias: d.bias.buy >= d.bias.sell ? 'bullish' : 'bearish',
      tickers: [...d.tickers].slice(0, 4),
      winRate: up.length > 0 ? Math.round(wins / up.length * 100) : null,
      paperPnl: +up.reduce((a, p) => a + (p.pnl || 0), 0).toFixed(2),
      calls: d.calls.slice(0, 4).map(c => ({
        ticker: c.ticker, call: c.call,
        entryPrice: stockMap[c.ticker]?.price || null,
        currentPrice: stockMap[c.ticker]?.price || null,
        date: new Date().toLocaleDateString(),
        text: c.text.slice(0, 80),
        reason: c.sent === 'positive' ? 'bullish signal' : 'bearish signal'
      }))
    };
  }).sort((a, b) => b.score - a.score).slice(0, 25);

  console.log(`  === Done: ${totalPosts} posts, ${POSITIONS.length} positions ===\n`);
  return {
    totalPosts, overall: totalPos > totalNeg ? 'bullish' : totalNeg > totalPos ? 'bearish' : 'mixed',
    stocks, users, positions: enrichedPositions,
    source: 'StockTwits', updatedAt: new Date().toISOString()
  };
}

let cache = null, cacheTime = 0;
async function getData(force = false) {
  const now = Date.now();
  if (!force && cache && (now - cacheTime) < 10 * 60 * 1000) { console.log('  From cache'); return cache; }
  cache = await fetchAllData();
  cacheTime = now;
  return cache;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/data') {
    try {
      console.log(`[${new Date().toLocaleTimeString()}] /api/data`);
      const data = await getData(parsed.query.force === '1');
      res.writeHead(200); res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }

  } else if (parsed.pathname === '/api/price') {
    try {
      const ticker = (parsed.query.ticker || '').toUpperCase();
      const p = await fetchPrice(ticker);
      res.writeHead(200); res.end(JSON.stringify(p || { error: 'not found' }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }

  } else if (parsed.pathname === '/api/positions') {
    try {
      const enriched = POSITIONS.map(enrichPnl);
      res.writeHead(200); res.end(JSON.stringify({ positions: enriched, total: enriched.length }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }

  } else {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(`<html><body style="font-family:sans-serif;padding:40px;background:#0a0a0a;color:#e0e0e0;">
      <h2 style="color:#22c55e;">WSB Intelligence v4</h2>
      <p>Persistent positions: <strong style="color:#22c55e;">${POSITIONS.length}</strong></p>
      <p><a href="/api/data" style="color:#22c55e;">/api/data</a></p>
      <p><a href="/api/positions" style="color:#22c55e;">/api/positions</a></p>
    </body></html>`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  WSB Intelligence v4 on port ${PORT}`);
  console.log(`  Positions on disk: ${POSITIONS.length}\n`);
});
