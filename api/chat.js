export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    res.write(`data: ${JSON.stringify({ error: 'Invalid request' })}\n\n`);
    return res.end();
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;
  const TAVILY_KEY = process.env.TAVILY_API_KEY;

  if (!GROQ_KEY) {
    res.write(`data: ${JSON.stringify({ error: 'API key not configured' })}\n\n`);
    return res.end();
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

  let searchContext = '';
  let searchSources = [];

  if (TAVILY_KEY && userText && needsSearch(userText)) {
    // Tell client we're searching
    res.write(`data: ${JSON.stringify({ searching: true })}\n\n`);
    try {
      const result = await tavilySearch(userText, TAVILY_KEY);
      if (result.results?.length) {
        searchContext = '\n\n[WEB SEARCH RESULTS - use this real-time data]:\n';
        result.results.slice(0, 5).forEach((r, i) => {
          searchContext += `\n[${i+1}] ${r.title}\nURL: ${r.url}\nContent: ${r.content}\n`;
          searchSources.push({ title: r.title, url: r.url });
        });
        searchContext += '\n[END SEARCH RESULTS]\nUse the above to answer accurately. Include relevant URLs as markdown links [text](url) when helpful.';
      }
    } catch (e) { /* silent fail */ }
  }

  let augmentedMessages = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === 'user' && searchContext) {
      return { ...m, content: (typeof m.content === 'string' ? m.content : '') + searchContext };
    }
    return m;
  });

  // Send sources to client before streaming
  if (searchSources.length > 0) {
    res.write(`data: ${JSON.stringify({ sources: searchSources })}\n\n`);
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        messages: augmentedMessages,
        max_tokens: 1024,
        temperature: 0.7,
        stream: true
      })
    });

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') { res.write('data: [DONE]\n\n'); continue; }
          try {
            const json = JSON.parse(raw);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) res.write(`data: ${JSON.stringify({ token: delta })}\n\n`);
          } catch {}
        }
      }
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
  }
  res.end();
}

function needsSearch(query) {
  const keywords = [
    'погода','weather','прогноз','forecast',
    'сегодня','today','сейчас','now','вчера','yesterday','завтра','tomorrow',
    'новости','news','последние','latest','текущий','current',
    'курс','price','цена','rate','акции','stock','биткоин','bitcoin','крипто','crypto','доллар','евро',
    'расписание','schedule','матч','match','счёт','score','игра','game',
    'где','where','адрес','address','сайт','website','ресторан','restaurant','кафе','cafe',
    'рейс','flight','трафик','traffic','пробки',
    '2024','2025','2026','вышел','released','произошло','happened',
    'найди','find','поищи','search','покажи','show me',
    'кто такой','who is','что такое','what is','когда','when',
    'список','list','топ','top','лучшие','best'
  ];
  const q = query.toLowerCase();
  return keywords.some(k => q.includes(k));
}

async function tavilySearch(query, apiKey) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
      include_raw_content: false
    })
  });
  return r.json();
}
