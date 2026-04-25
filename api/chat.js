export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages array required' });
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;

  if (!GROQ_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Берём последнее сообщение
  const lastMessage = messages[messages.length - 1];
  const userMessage = lastMessage.content || lastMessage.text || lastMessage || '';

  try {
    const r = await fetch('https://apifreellm.com/api/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        message: userMessage,
        model: 'apifreellm'
      })
    });

    // 🔥 НОВОЕ: безопасно читаем ответ, даже если это не JSON
    let data;
    const contentType = r.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      data = await r.json();
    } else {
      const text = await r.text();
      console.error('Non-JSON response from ApiFreeLLM:', text);
      return res.status(502).json({ 
        error: 'ApiFreeLLM returned invalid response (HTML error page)' 
      });
    }

    if (!r.ok) {
      return res.status(r.status).json({ 
        error: data?.error || data?.message || 'ApiFreeLLM error' 
      });
    }

    const reply = data.response || data.message || 'Нет ответа от модели';

    return res.status(200).json({ reply });

  } catch (e) {
    console.error('Chat handler error:', e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
}
