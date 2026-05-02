// WSB Intelligence — Local Backend Server
// Fetches Reddit posts + stock prices and serves them to your dashboard

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3456;

// ─── Helper: make an HTTPS GET request ───────────────────────────────────────
function get(requestUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(requestUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'WSBIntelligence/1.0 (personal dashboard)',
        'Accept': 'application/json',
        ...headers
      },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.end();
  });
}

// ─── Fetch Reddit posts ───────────────────────────────────────────────────────
async function fetchRedditPosts() {
  const subreddits = ['wallstreetbets', 'stocks', 'investing', 'StockMarket'];
  const sorts = ['hot', 'top'];
  const all = [];
  const seen = new Set();

  for (const sub of subreddits) {
    for (const sort of sorts) {
      try {
        const data = await get(
          `https://www.reddit.com/r/${sub}/${sort}.json?limit=25&t=day`
        );
        const items = data?.data?.children || [];
        for (const c of items) {
          const d = c.data;
          if (seen.has(d.id)) continue;
          if (d.author === 'AutoModerator' || d.author === '[deleted]') continue;
          seen.add(d.id);
          all.push({
            id: d.id,
            title: d.title,
            text: (d.selftext || '').slice(0, 400),
            author: d.author,
            sub: d.subreddit,
            score: d.score,
            comments: d.num_comments,
          });
        }
        await sleep(200); // gentle rate limiting
      } catch (e) {
        console.log(`  Skipping r/${sub}/${sort}: ${e.message}`);
      }
    }
  }
  return all;
}

// ─── Fetch stock price from Yahoo Finance ────────────────────────────────────
async function fetchPrice(ticker) {
  try {
    const data = await get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`,
      { 'Accept': 'application/json' }
    );
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice || meta.previousClose;
    const prev = meta.previousClose || price;
    const change = price && prev ? ((price - prev) / prev * 100) : 0;
    return {
      price: +price.toFixed(2),
      change: +change.toFixed(2)
    };
  } catch (e) {
    return null;
  }
}

// ─── Extract tickers mentioned in text ───────────────────────────────────────
const KNOWN_TICKERS = new Set([
  'NVDA','AAPL','MSFT','TSLA','META','AMZN','GOOG','GOOGL','AMD','INTC',
  'SPY','QQQ','PLTR','GME','AMC','COIN','MSTR','ARM','SMCI','SHOP',
  'NFLX','DIS','UBER','ABNB','SNAP','PYPL','SQ','V','MA','JPM',
  'BAC','GS','MS','XOM','CVX','BA','LMT','MRNA','PFE','JNJ',
  'RIVN','LCID','NIO','XPEV','F','GM','HOOD','RBLX','U','DKNG',
  'ARKK','IWM','DIA','VTI','VOO','TLT','GLD','SLV','USO',
  'SOFI','UPST','AFRM','OPEN','OPRA','NET','CRWD','DDOG','SNOW','MDB',
  'ZS','OKTA','NOW','CRM','ORCL','IBM','DELL','HPQ','MCHP','QCOM'
]);

function extractTickers(text) {
  const found = new Set();
  // Match $TICKER or standalone TICKER in caps
  const dollarMatches = text.match(/\$([A-Z]{1,5})/g) || [];
  dollarMatches.forEach(m => {
    const t = m.replace('$', '');
    if (KNOWN_TICKERS.has(t)) found.add(t);
  });
  // Also match standalone caps words
  const wordMatches = text.match(/\b([A-Z]{2,5})\b/g) || [];
  wordMatches.forEach(t => {
    if (KNOWN_TICKERS.has(t)) found.add(t);
  });
  return [...found].slice(0, 4);
}

// ─── Simple sentiment scoring ─────────────────────────────────────────────────
const BULL_WORDS = ['buy','bull','long','moon','calls','puts','squeeze','rip','pump','up','green','win','profit','gain','yolo','apes','hold','hodl','rocket','growth','beat','crush','exceed'];
const BEAR_WORDS = ['sell','short','bear','puts','crash','dump','down','red','loss','bankrupt','fail','miss','drop','tank','falling','decline','avoid','overvalued','bubble','retreat'];

function scoreSentiment(text) {
  const lower = text.toLowerCase();
  let bull = 0, bear = 0;
  BULL_WORDS.forEach(w => { if (lower.includes(w)) bull++; });
  BEAR_WORDS.forEach(w => { if (lower.includes(w)) bear++; });
  if (bull > bear) return 'positive';
  if (bear > bull) return 'negative';
  return 'neutral';
}

function detectCall(text) {
  const lower = text.toLowerCase();
  if (/\b(buying|buy|long|calls|going long|bullish on|yolo|loaded up)\b/.test(lower)) return 'buy';
  if (/\b(shorting|short|puts|going short|bearish on|selling)\b/.test(lower)) return 'sell';
  return 'none';
}

// ─── Process posts into structured data ──────────────────────────────────────
async function processPosts(posts) {
  const stockMap = {};
  const userMap = {};

  // Analyze each post
  const analyzed = posts.map(post => {
    const fullText = post.title + ' ' + post.text;
    const tickers = extractTickers(fullText);
    const sentiment = scoreSentiment(fullText);
    const call = detectCall(fullText);
    const callTicker = tickers[0] || null;
    const isRec = call !== 'none' && callTicker !== null;

    // Build stock map
    tickers.forEach(tk => {
      if (!stockMap[tk]) stockMap[tk] = { ticker: tk, mentions: 0, pos: 0, neg: 0, neu: 0, price: null, change: 0 };
      stockMap[tk].mentions++;
      stockMap[tk][sentiment === 'positive' ? 'pos' : sentiment === 'negative' ? 'neg' : 'neu']++;
    });

    // Build user map
    const u = post.author;
    if (!userMap[u]) userMap[u] = { posts: 0, calls: [], tickers: new Set(), bias: { buy: 0, sell: 0 }, sub: post.sub, score: 0 };
    userMap[u].posts++;
    userMap[u].score += post.score;
    tickers.forEach(t => userMap[u].tickers.add(t));

    if (isRec) {
      userMap[u].calls.push({ ticker: callTicker, call, post, sentiment });
      userMap[u].bias[call]++;
    }

    return { ...post, tickers, sentiment, call, callTicker, isRec };
  });

  // Fetch prices for top 25 tickers
  console.log('  Fetching stock prices...');
  const top25 = Object.values(stockMap)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 25);

  for (const s of top25) {
    const priceData = await fetchPrice(s.ticker);
    if (priceData) { s.price = priceData.price; s.change = priceData.change; }
    await sleep(150);
  }

  // Build positions
  const positions = [];
  for (const [username, ud] of Object.entries(userMap)) {
    for (const call of ud.calls) {
      const tk = call.ticker;
      const priceNow = stockMap[tk]?.price || null;
      if (!priceNow) continue;
      positions.push({
        user: username,
        ticker: tk,
        call: call.call,
        entryPrice: priceNow,
        currentPrice: priceNow,
        stake: 1000,
        date: new Date().toLocaleDateString(),
        text: call.post.title.slice(0, 80),
        sub: call.post.sub,
        score: call.post.score
      });
    }
  }

  // Overall sentiment
  const totalPos = analyzed.filter(p => p.sentiment === 'positive').length;
  const totalNeg = analyzed.filter(p => p.sentiment === 'negative').length;
  const overall = totalPos > totalNeg ? 'bullish' : totalNeg > totalPos ? 'bearish' : 'mixed';

  return {
    totalPosts: posts.length,
    overall,
    stocks: top25,
    users: Object.entries(userMap)
      .map(([name, d]) => ({
        username: name,
        sub: d.sub,
        posts: d.posts,
        score: d.score,
        bias: d.bias.buy >= d.bias.sell ? 'bullish' : 'bearish',
        tickers: [...d.tickers].slice(0, 4),
        calls: d.calls.map(c => ({
          ticker: c.ticker,
          call: c.call,
          entryPrice: stockMap[c.ticker]?.price || null,
          currentPrice: stockMap[c.ticker]?.price || null,
          date: new Date().toLocaleDateString(),
          text: c.post.title.slice(0, 80),
          reason: c.sentiment === 'positive' ? 'bullish sentiment detected' : 'bearish sentiment detected'
        }))
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 25),
    positions,
    updatedAt: new Date().toISOString()
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Cache ────────────────────────────────────────────────────────────────────
let cache = null;
let cacheTime = 0;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

async function getData() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_DURATION) {
    console.log('  Serving from cache');
    return cache;
  }
  console.log('  Fetching fresh data...');
  const posts = await fetchRedditPosts();
  console.log(`  Got ${posts.length} posts`);
  cache = await processPosts(posts);
  cacheTime = now;
  return cache;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS headers — allow your dashboard to call this server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/data') {
    try {
      console.log(`[${new Date().toLocaleTimeString()}] Request: /api/data`);
      const data = await getData();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      console.error('Error:', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (parsed.pathname === '/api/price') {
    const ticker = parsed.query.ticker;
    if (!ticker) { res.writeHead(400); res.end(JSON.stringify({ error: 'ticker required' })); return; }
    try {
      const price = await fetchPrice(ticker.toUpperCase());
      res.writeHead(200);
      res.end(JSON.stringify(price || { error: 'not found' }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  } else if (parsed.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0a0a0a;color:#e0e0e0;">
      <h2 style="color:#22c55e;">WSB Intelligence Server Running</h2>
      <p>Server is active on port ${PORT}.</p>
      <p>Open <strong>dashboard.html</strong> in your browser to use the dashboard.</p>
      <p style="color:#666;">API endpoints:</p>
      <ul style="color:#999;">
        <li><a href="/api/data" style="color:#22c55e;">/api/data</a> — all Reddit data + stock prices</li>
        <li>/api/price?ticker=NVDA — single stock price</li>
      </ul>
      </body></html>
    `);
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ██╗    ██╗███████╗██████╗ ');
  console.log('  ██║    ██║██╔════╝██╔══██╗');
  console.log('  ██║ █╗ ██║███████╗██████╔╝');
  console.log('  ██║███╗██║╚════██║██╔══██╗');
  console.log('  ╚███╔███╔╝███████║██████╔╝');
  console.log('   ╚══╝╚══╝ ╚══════╝╚═════╝ ');
  console.log('');
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  Open dashboard.html in your browser`);
  console.log(`  Press Ctrl+C to stop`);
  console.log('');
});
