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

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',     // ← самая выгодная модель по лимитам
        messages: messages,
        max_tokens: 1024,
        temperature: 0.72
      })
    });

    const data = await r.json();

    if (!r.ok) {
      return res.status(r.status).json({ 
        error: data.error?.message || 'Groq error' 
      });
    }

    const reply = data.choices?.[0]?.message?.content || 'Нет ответа';

    return res.status(200).json({ reply });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
