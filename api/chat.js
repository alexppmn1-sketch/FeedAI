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
  const SERPER_KEY = process.env.SERPER_API_KEY;   // ← новая переменная

  if (!GROQ_KEY) {
    res.write(`data: ${JSON.stringify({ error: 'GROQ_API_KEY not configured' })}\n\n`);
    return res.end();
  }

  // === Определение модели (текст / vision) ===
  const hasImage = messages.some(msg => {
    if (!msg.content) return false;
    if (typeof msg.content === 'string') return msg.content.includes('data:image');
    if (Array.isArray(msg.content)) {
      return msg.content.some(item => 
        item.type === 'image_url' || 
        (item.image_url && item.image_url.url?.includes('data:image'))
      );
    }
    return false;
  });

  const model = hasImage 
    ? "meta-llama/llama-4-scout-17b-16e-instruct" 
    : "llama-3.1-8b-instant";

  console.log(`[DEBUG] Запрос. Модель: ${model} | Изображение: ${hasImage}`);

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

  let searchContext = '';
  let searchSources = [];

  // === Поиск через Serper ===
  if (SERPER_KEY && userText && needsSearch(userText)) {
    res.write(`data: ${JSON.stringify({ searching: true })}\n\n`);
    try {
      const result = await serperSearch(userText, SERPER_KEY);
      if (result.organic?.length) {
        searchContext = '\n\n[WEB SEARCH RESULTS - актуальные данные]:\n';
        result.organic.slice(0, 5).forEach((r, i) => {
          searchContext += `\n[${i+1}] ${r.title}\nURL: ${r.link}\nContent: ${r.snippet}\n`;
          searchSources.push({ title: r.title, url: r.link });
        });
        searchContext += '\n[END SEARCH RESULTS]\nИспользуй эти данные для точного ответа.';
      }
    } catch (e) {
      console.error('[Serper] Error:', e);
    }
  }

  let augmentedMessages = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === 'user' && searchContext) {
      return { ...m, content: (typeof m.content === 'string' ? m.content : '') + searchContext };
    }
    return m;
  });

  if (searchSources.length > 0) {
    res.write(`data: ${JSON.stringify({ sources: searchSources })}\n\n`);
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${GROQ_KEY}` 
      },
      body: JSON.stringify({
        model: model,
        messages: augmentedMessages,
        max_tokens: 1024,
        temperature: 0.7,
        stream: true
      })
    });

    if (!r.ok) {
      const errorText = await r.text();
      console.error(`[Groq Error] ${r.status}:`, errorText);
      res.write(`data: ${JSON.stringify({ error: `Groq API error ${r.status}` })}\n\n`);
      return res.end();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const json = JSON.parse(raw);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) res.write(`data: ${JSON.stringify({ token: delta })}\n\n`);
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    console.error('[Chat Error]:', e);
    res.write(`data: ${JSON.stringify({ error: e.message || 'Unknown error' })}\n\n`);
  }

  res.end();
}

// === Улучшенная функция поиска (ловит вопросы про год, дату и т.д.) ===
function needsSearch(query) {
  const keywords = [
    'погода','weather','прогноз','forecast','сейчас','now','сегодня','today',
    'год','year','какой год','какой сейчас год','текущий год','current year',
    'новости','news','последние','latest','курс','price','цена','биткоин','bitcoin'
  ];
  const q = query.toLowerCase();
  return keywords.some(k => q.includes(k));
}

// === Новый поиск через Serper.dev ===
async function serperSearch(query, apiKey) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      q: query,
      gl: 'ru',     // Россия
      hl: 'ru',     // русский язык
      num: 6
    })
  });
  return r.json();
}
