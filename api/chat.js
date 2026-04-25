export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) {
    return res.status(500).json({ error: 'API key not configured in Vercel' });
  }

  const lastMessage = messages[messages.length - 1];
  const userMessage = lastMessage.content || lastMessage.text || lastMessage || '';

  try {
    const r = await fetch('https://apifreellm.com/api/v1/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
        // 🔥 Эти заголовки обходят Cloudflare
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Referer': 'https://apifreellm.com/'
      },
      body: JSON.stringify({
        message: userMessage,
        model: 'apifreellm'
      })
    });

    const responseText = await r.text();

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      return res.status(502).json({
        error: `ApiFreeLLM blocked by Cloudflare (status ${r.status})`,
        details: responseText.substring(0, 700)
      });
    }

    if (!r.ok) {
      return res.status(r.status).json({
        error: data.error || data.message || `ApiFreeLLM error ${r.status}`,
        details: data
      });
    }

    const reply = data.response || data.message || 'Нет ответа';
    return res.status(200).json({ reply });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
