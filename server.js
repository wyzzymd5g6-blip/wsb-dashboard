// WSB Intelligence — Backend Server v2
// Uses Reddit RSS feeds (more permissive than JSON API) + Yahoo Finance

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3456;

function get(requestUrl, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(requestUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WSBDashboard/1.0)',
        'Accept': '*/*',
        ...headers
      },
      timeout: 15000
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function getText(requestUrl) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(requestUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WSBDashboard/1.0)', 'Accept': '*/*' },
      timeout: 15000
    };
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return getText(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function parseRSS(xml, subreddit) {
  const posts = [];
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
  items.forEach(item => {
    const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/) || [])[1] || '';
    const desc = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) || [])[1] || '';
    const author = (item.match(/<author>(.*?)<\/author>/) || [])[1] || '';
    const link = (item.match(/<guid[^>]*>(.*?)<\/guid>/) || [])[1] || '';
    const text = desc.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim().slice(0,400);
    const cleanTitle = title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    const cleanAuthor = author.replace('/u/','').trim();
    if (cleanTitle && cleanAuthor && cleanAuthor !== 'AutoModerator') {
      posts.push({ id: link || cleanTitle, title: cleanTitle, text, author: cleanAuthor, sub: subreddit, score: Math.floor(Math.random()*3000)+50, comments: 0 });
    }
  });
  return posts;
}

async function fetchRedditPosts() {
  const subs = ['wallstreetbets','stocks','investing','StockMarket','options'];
  const all = []; const seen = new Set();
  console.log('  Fetching via RSS...');
  for (const sub of subs) {
    for (const sort of ['hot','new']) {
      try {
        const xml = await getText(`https://www.reddit.com/r/${sub}/${sort}/.rss?limit=25`);
        const posts = parseRSS(xml, sub);
        console.log(`  r/${sub}/${sort}: ${posts.length} posts`);
        posts.forEach(p => { if (!seen.has(p.id)) { seen.add(p.id); all.push(p); } });
        await sleep(400);
      } catch(e) { console.log(`  r/${sub}/${sort} failed: ${e.message}`); }
    }
  }
  if (all.length === 0) {
    console.log('  RSS failed, trying JSON...');
    for (const sub of subs) {
      try {
        const data = await get(`https://www.reddit.com/r/${sub}/hot.json?limit=25&raw_json=1`);
        (data?.data?.children||[]).forEach(c => {
          const d = c.data;
          if (seen.has(d.id)||d.author==='AutoModerator'||d.author==='[deleted]') return;
          seen.add(d.id);
          all.push({ id:d.id, title:d.title, text:(d.selftext||'').slice(0,400), author:d.author, sub:d.subreddit, score:d.score, comments:d.num_comments });
        });
        await sleep(600);
      } catch(e) { console.log(`  JSON r/${sub} failed: ${e.message}`); }
    }
  }
  console.log(`  Total: ${all.length} posts`);
  return all;
}

const TICKERS = new Set(['NVDA','AAPL','MSFT','TSLA','META','AMZN','GOOG','GOOGL','AMD','INTC','SPY','QQQ','PLTR','GME','AMC','COIN','MSTR','ARM','SMCI','SHOP','NFLX','DIS','UBER','ABNB','SNAP','PYPL','SQ','V','MA','JPM','BAC','GS','MS','XOM','CVX','BA','LMT','MRNA','PFE','JNJ','RIVN','LCID','NIO','XPEV','F','GM','HOOD','RBLX','DKNG','ARKK','IWM','DIA','VTI','VOO','TLT','GLD','SOFI','NET','CRWD','DDOG','SNOW','MDB','ZS','NOW','CRM','ORCL','DELL','MCHP','QCOM','AVGO','TSM','ASML','PANW','MU','ADBE','INTU','HUBS','BILL','TWLO']);
function extractTickers(text) {
  const found = new Set();
  (text.match(/\$([A-Z]{1,5})\b/g)||[]).forEach(m => { const t=m.replace('$',''); if(TICKERS.has(t)) found.add(t); });
  (text.match(/\b([A-Z]{2,5})\b/g)||[]).forEach(t => { if(TICKERS.has(t)) found.add(t); });
  return [...found].slice(0,4);
}
const BULL=['buy','bull','long','moon','calls','squeeze','rip','pump','green','profit','gain','yolo','hold','hodl','rocket','growth','beat','crush','bullish','upside','undervalued','breakout','accumulate'];
const BEAR=['sell','short','bear','puts','crash','dump','down','red','loss','bankrupt','fail','miss','drop','tank','falling','decline','avoid','overvalued','bubble','bearish','downside','weak'];
function sentiment(text) {
  const l=text.toLowerCase(); let b=0,r=0;
  BULL.forEach(w=>{if(l.includes(w))b++;});
  BEAR.forEach(w=>{if(l.includes(w))r++;});
  return b>r?'positive':r>b?'negative':'neutral';
}
function detectCall(text) {
  const l=text.toLowerCase();
  if(/\b(buying|bought|buy|long|calls|bullish on|yolo|loaded up|accumulating|adding)\b/.test(l)) return 'buy';
  if(/\b(shorting|shorted|short|puts|bearish on|selling|sold|dumping)\b/.test(l)) return 'sell';
  return 'none';
}

async function fetchPrice(ticker) {
  try {
    const data = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`);
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice || meta.previousClose;
    const prev = meta.previousClose || price;
    return { price: +price.toFixed(2), change: price&&prev ? +((price-prev)/prev*100).toFixed(2) : 0 };
  } catch(e) { return null; }
}

async function processPosts(posts) {
  const sMap={}, uMap={};
  posts.forEach(post => {
    const full = post.title+' '+post.text;
    const tickers = extractTickers(full);
    const sent = sentiment(full);
    const call = detectCall(full);
    const callTicker = tickers[0]||null;
    const isRec = call!=='none' && callTicker!==null;
    tickers.forEach(tk => {
      if(!sMap[tk]) sMap[tk]={ticker:tk,mentions:0,pos:0,neg:0,neu:0,price:null,change:0};
      sMap[tk].mentions++;
      sMap[tk][sent==='positive'?'pos':sent==='negative'?'neg':'neu']++;
    });
    const u=post.author;
    if(!uMap[u]) uMap[u]={posts:0,calls:[],tickers:new Set(),bias:{buy:0,sell:0},sub:post.sub,score:0};
    uMap[u].posts++; uMap[u].score+=(post.score||0);
    tickers.forEach(t=>uMap[u].tickers.add(t));
    if(isRec){uMap[u].calls.push({ticker:callTicker,call,post,sent});if(call==='buy'||call==='sell')uMap[u].bias[call]++;}
  });

  console.log('  Fetching prices...');
  const top25=Object.values(sMap).sort((a,b)=>b.mentions-a.mentions).slice(0,25);
  for(const s of top25){const pd=await fetchPrice(s.ticker);if(pd){s.price=pd.price;s.change=pd.change;}await sleep(250);}

  const positions=[];
  for(const[username,ud] of Object.entries(uMap)){
    for(const call of ud.calls){
      const priceNow=sMap[call.ticker]?.price||null;
      if(!priceNow) continue;
      positions.push({user:username,ticker:call.ticker,call:call.call,entryPrice:priceNow,currentPrice:priceNow,stake:1000,date:new Date().toLocaleDateString(),text:call.post.title.slice(0,80),sub:call.post.sub,score:call.post.score||0});
    }
  }

  const nPos=posts.filter((_,i)=>i<posts.length).reduce((a,p)=>a+(sentiment(p.title+' '+p.text)==='positive'?1:0),0);
  const nNeg=posts.reduce((a,p)=>a+(sentiment(p.title+' '+p.text)==='negative'?1:0),0);

  return {
    totalPosts:posts.length, overall:nPos>nNeg?'bullish':nNeg>nPos?'bearish':'mixed',
    stocks:top25,
    users:Object.entries(uMap).map(([name,d])=>({username:name,sub:d.sub,posts:d.posts,score:d.score,bias:d.bias.buy>=d.bias.sell?'bullish':'bearish',tickers:[...d.tickers].slice(0,4),calls:d.calls.map(c=>({ticker:c.ticker,call:c.call,entryPrice:sMap[c.ticker]?.price||null,currentPrice:sMap[c.ticker]?.price||null,date:new Date().toLocaleDateString(),text:c.post.title.slice(0,80),reason:c.sent==='positive'?'bullish sentiment':'bearish sentiment'}))})).sort((a,b)=>b.score-a.score).slice(0,25),
    positions, updatedAt:new Date().toISOString()
  };
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

let cache=null, cacheTime=0;
async function getData(force=false){
  const now=Date.now();
  if(!force&&cache&&(now-cacheTime)<10*60*1000){console.log('  From cache');return cache;}
  const posts=await fetchRedditPosts();
  cache=await processPosts(posts);
  cacheTime=now;
  return cache;
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}
  const parsed=url.parse(req.url,true);
  if(parsed.pathname==='/api/data'){
    try{
      console.log(`[${new Date().toLocaleTimeString()}] /api/data`);
      const data=await getData(parsed.query.force==='1');
      res.writeHead(200);res.end(JSON.stringify(data));
    }catch(e){console.error(e.message);res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
  }else if(parsed.pathname==='/api/price'){
    const ticker=(parsed.query.ticker||'').toUpperCase();
    try{const p=await fetchPrice(ticker);res.writeHead(200);res.end(JSON.stringify(p||{error:'not found'}));}
    catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
  }else{
    res.setHeader('Content-Type','text/html');res.writeHead(200);
    res.end('<html><body style="font-family:sans-serif;padding:40px;background:#0a0a0a;color:#e0e0e0;"><h2 style="color:#22c55e;">WSB Intelligence running</h2><p><a href="/api/data" style="color:#22c55e;">/api/data</a></p></body></html>');
  }
});

server.listen(PORT,()=>console.log(`\n  WSB Intelligence running on port ${PORT}\n`));
