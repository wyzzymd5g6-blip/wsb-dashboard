// WSB Intelligence — Backend Server v3
// Uses StockTwits API (free, no auth, no blocks) + Yahoo Finance for prices

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3456;

// Top 25 tickers to track on StockTwits
const TICKERS = [
  'NVDA','TSLA','AAPL','AMD','META','MSFT','AMZN','PLTR','COIN','GME',
  'SPY','QQQ','ARM','SMCI','MSTR','GOOGL','NFLX','SOFI','HOOD','RIVN',
  'BAC','JPM','AMD','INTC','SHOP'
];

function get(reqUrl) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(reqUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WSBDashboard/1.0)',
        'Accept': 'application/json'
      },
      timeout: 15000
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Fetch StockTwits messages for a ticker ───────────────────────────────────
async function fetchStockTwits(ticker) {
  try {
    const data = await get(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json?limit=30`);
    const messages = data?.messages || [];
    return messages.map(m => ({
      id: String(m.id),
      title: m.body || '',
      text: m.body || '',
      author: m.user?.username || 'unknown',
      sub: 'StockTwits',
      score: m.likes?.total || 0,
      comments: m.conversation?.replies || 0,
      ticker,
      sentiment: m.entities?.sentiment?.basic || null, // 'Bullish' or 'Bearish' — users tag this!
      created: m.created_at
    }));
  } catch(e) {
    console.log(`  StockTwits ${ticker} failed: ${e.message}`);
    return [];
  }
}

// ─── Fetch stock price from Yahoo Finance ─────────────────────────────────────
async function fetchPrice(ticker) {
  try {
    const data = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice || meta.previousClose;
    const prev = meta.previousClose || price;
    return {
      price: +price.toFixed(2),
      change: price && prev ? +((price - prev) / prev * 100).toFixed(2) : 0
    };
  } catch(e) { return null; }
}

// ─── Sentiment helpers ────────────────────────────────────────────────────────
const BULL = ['buy','bull','long','moon','calls','squeeze','rip','pump','green','profit','gain','yolo','hold','hodl','rocket','growth','beat','crush','bullish','upside','breakout','accumulate','dip'];
const BEAR = ['sell','short','bear','puts','crash','dump','down','red','loss','fail','miss','drop','tank','falling','decline','avoid','overvalued','bubble','bearish','downside','weak','overbought'];

function scoreSentiment(text, stSentiment) {
  // StockTwits users manually tag Bullish/Bearish — use that first if available
  if (stSentiment === 'Bullish') return 'positive';
  if (stSentiment === 'Bearish') return 'negative';
  const l = text.toLowerCase();
  let b = 0, r = 0;
  BULL.forEach(w => { if (l.includes(w)) b++; });
  BEAR.forEach(w => { if (l.includes(w)) r++; });
  return b > r ? 'positive' : r > b ? 'negative' : 'neutral';
}

function detectCall(text, stSentiment) {
  if (stSentiment === 'Bullish') return 'buy';
  if (stSentiment === 'Bearish') return 'sell';
  const l = text.toLowerCase();
  if (/\b(buying|bought|buy|long|calls|bullish on|yolo|loaded up|accumulating|adding|dip buy)\b/.test(l)) return 'buy';
  if (/\b(shorting|shorted|short|puts|bearish on|selling|sold|dumping)\b/.test(l)) return 'sell';
  return 'none';
}

// ─── Main data fetch + process ────────────────────────────────────────────────
async function fetchAllData() {
  console.log('  Fetching StockTwits data for top 25 tickers...');

  const stockMap = {};
  const userMap = {};
  const positions = [];
  let totalPosts = 0;

  // Fetch prices and StockTwits data in parallel batches
  for (let i = 0; i < TICKERS.length; i++) {
    const ticker = TICKERS[i];
    console.log(`  [${i+1}/25] $${ticker}`);

    // Fetch StockTwits messages and price in parallel
    const [messages, priceData] = await Promise.allSettled([
      fetchStockTwits(ticker),
      fetchPrice(ticker)
    ]);

    const msgs = messages.status === 'fulfilled' ? messages.value : [];
    const price = priceData.status === 'fulfilled' ? priceData.value : null;

    // Init stock entry
    if (!stockMap[ticker]) {
      stockMap[ticker] = { ticker, mentions: 0, pos: 0, neg: 0, neu: 0, price: null, change: 0 };
    }
    if (price) { stockMap[ticker].price = price.price; stockMap[ticker].change = price.change; }

    // Process each message
    msgs.forEach(msg => {
      totalPosts++;
      const sent = scoreSentiment(msg.text, msg.sentiment);
      const call = detectCall(msg.text, msg.sentiment);

      stockMap[ticker].mentions++;
      stockMap[ticker][sent === 'positive' ? 'pos' : sent === 'negative' ? 'neg' : 'neu']++;

      const u = msg.author;
      if (!userMap[u]) userMap[u] = { posts: 0, calls: [], tickers: new Set(), bias: { buy: 0, sell: 0 }, sub: 'StockTwits', score: 0 };
      userMap[u].posts++;
      userMap[u].score += (msg.score || 0);
      userMap[u].tickers.add(ticker);

      if ((call === 'buy' || call === 'sell') && price) {
        userMap[u].calls.push({ ticker, call, text: msg.text, sent });
        userMap[u].bias[call]++;

        // Open paper position
        const existing = positions.find(p => p.user === u && p.ticker === ticker && p.call === call);
        if (!existing) {
          positions.push({
            user: u, ticker, call,
            entryPrice: price.price,
            currentPrice: price.price,
            stake: 1000,
            date: new Date().toLocaleDateString(),
            text: msg.text.slice(0, 80),
            sub: 'StockTwits',
            score: msg.score || 0
          });
        }
      }
    });

    await sleep(300); // gentle rate limiting
  }

  // Calculate overall sentiment
  const stocks = Object.values(stockMap).sort((a, b) => b.mentions - a.mentions);
  const totalPos = stocks.reduce((a, s) => a + s.pos, 0);
  const totalNeg = stocks.reduce((a, s) => a + s.neg, 0);
  const overall = totalPos > totalNeg ? 'bullish' : totalNeg > totalPos ? 'bearish' : 'mixed';

  // Build users list
  const users = Object.entries(userMap)
    .map(([name, d]) => ({
      username: name, sub: 'StockTwits', posts: d.posts, score: d.score,
      bias: d.bias.buy >= d.bias.sell ? 'bullish' : 'bearish',
      tickers: [...d.tickers].slice(0, 4),
      calls: d.calls.slice(0, 4).map(c => ({
        ticker: c.ticker, call: c.call,
        entryPrice: stockMap[c.ticker]?.price || null,
        currentPrice: stockMap[c.ticker]?.price || null,
        date: new Date().toLocaleDateString(),
        text: c.text.slice(0, 80),
        reason: c.sent === 'positive' ? 'bullish signal' : 'bearish signal'
      }))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  console.log(`  Done: ${totalPosts} posts, ${stocks.length} stocks, ${positions.length} positions`);

  return {
    totalPosts, overall, stocks,
    users, positions,
    source: 'StockTwits',
    updatedAt: new Date().toISOString()
  };
}

// ─── Cache (10 min) ───────────────────────────────────────────────────────────
let cache = null;
let cacheTime = 0;

async function getData(force = false) {
  const now = Date.now();
  if (!force && cache && (now - cacheTime) < 10 * 60 * 1000) {
    console.log('  Serving from cache');
    return cache;
  }
  cache = await fetchAllData();
  cacheTime = now;
  return cache;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/data') {
    try {
      console.log(`[${new Date().toLocaleTimeString()}] /api/data requested`);
      const data = await getData(parsed.query.force === '1');
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch(e) {
      console.error('Error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (parsed.pathname === '/api/price') {
    const ticker = (parsed.query.ticker || '').toUpperCase();
    try {
      const p = await fetchPrice(ticker);
      res.writeHead(200);
      res.end(JSON.stringify(p || { error: 'not found' }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(`<html><body style="font-family:sans-serif;padding:40px;background:#0a0a0a;color:#e0e0e0;">
      <h2 style="color:#22c55e;">WSB Intelligence — Live</h2>
      <p>Source: StockTwits + Yahoo Finance</p>
      <p><a href="/api/data" style="color:#22c55e;">/api/data</a> — full dashboard data</p>
      <p><a href="/api/price?ticker=NVDA" style="color:#22c55e;">/api/price?ticker=NVDA</a> — single stock price</p>
    </body></html>`);
  }
});

server.listen(PORT, () => {
  console.log(`\n  WSB Intelligence running on port ${PORT}`);
  console.log(`  Source: StockTwits + Yahoo Finance\n`);
});
