cat > /home/claude/feed-final/api/chat.js << 'EOF'
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

  // ── Step 1: Ask Groq if web search is needed ──
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

  let searchContext = '';
  let searchSources = [];

  if (TAVILY_KEY && userText) {
    // Quick check: does this query need real-time info?
    const needsSearch = await checkIfNeedsSearch(userText, GROQ_KEY);

    if (needsSearch) {
      try {
        const searchResult = await tavilySearch(userText, TAVILY_KEY);
        if (searchResult.results && searchResult.results.length > 0) {
          searchContext = '\n\n[WEB SEARCH RESULTS - use this real-time data to answer]:\n';
          searchResult.results.slice(0, 4).forEach((r, i) => {
            searchContext += `\n[${i+1}] ${r.title}\nURL: ${r.url}\nContent: ${r.content}\n`;
            searchSources.push({ title: r.title, url: r.url });
          });
          searchContext += '\n[END OF SEARCH RESULTS]\n';
          searchContext += 'Use the above search results to give an accurate, up-to-date answer. Include relevant URLs as clickable links when helpful.';
        }
      } catch (e) {
        // Search failed silently — continue without it
      }
    }
  }

  // ── Step 2: Build messages with search context ──
  let augmentedMessages = [...messages];
  if (searchContext) {
    // Inject search results into the last user message
    augmentedMessages = messages.map((m, i) => {
      if (i === messages.length - 1 && m.role === 'user') {
        return { ...m, content: (typeof m.content === 'string' ? m.content : '') + searchContext };
      }
      return m;
    });
  }

  // ── Step 3: Stream response from Groq ──
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
        messages: augmentedMessages,
        max_tokens: 1024,
        temperature: 0.72,
        stream: true
      })
    });

    // Send sources first if we have them
    if (searchSources.length > 0) {
      res.write(`data: ${JSON.stringify({ sources: searchSources })}\n\n`);
    }

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

// ── Check if query needs web search ──
async function checkIfNeedsSearch(query, groqKey) {
  const keywords = [
    'погода', 'weather', 'сегодня', 'today', 'сейчас', 'now', 'новости', 'news',
    'курс', 'price', 'цена', 'rate', 'акции', 'stock', 'биткоин', 'bitcoin', 'крипто', 'crypto',
    'последние', 'latest', 'текущий', 'current', 'живой', 'live', 'онлайн', 'online',
    'расписание', 'schedule', 'матч', 'match', 'игра', 'game', 'счёт', 'score',
    'где', 'where', 'когда', 'when', 'who is', 'кто такой', 'что такое',
    'ресторан', 'restaurant', 'кафе', 'cafe', 'адрес', 'address', 'сайт', 'website',
    'вакансия', 'job', 'работа', 'трафик', 'traffic', 'пробки', 'flight', 'рейс',
    '2024', '2025', '2026', 'произошло', 'happened', 'вышел', 'released',
    'найди', 'find', 'поищи', 'search', 'покажи', 'show me', 'список', 'list of'
  ];
  const q = query.toLowerCase();
  return keywords.some(k => q.includes(k));
}

// ── Tavily web search ──
async function tavilySearch(query, apiKey) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
      include_raw_content: false
    })
  });
  return r.json();
}
EOF
echo "chat.js written, lines: $(wc -l < /home/claude/feed-final/api/chat.js)"
