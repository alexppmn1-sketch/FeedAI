// api/chat.js
const Groq = require('groq-sdk');
const { tavily } = require('@tavily/core');
require('dotenv').config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// === Tavily Tool Definition ===
const tavilyTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Поиск актуальной информации в интернете в реальном времени. Используй когда нужно свежие данные, погоду, новости, цены и т.д.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Что искать (на русском или английском)",
        },
        max_results: { type: "number", default: 5 },
      },
      required: ["query"],
    },
  },
};

// === Выполнение инструмента ===
async function executeTool(toolCall) {
  if (toolCall.function.name === "web_search") {
    const args = JSON.parse(toolCall.function.arguments);
    console.log(`[Tavily] Поиск: ${args.query}`);

    const results = await tvly.search({
      query: args.query,
      max_results: args.max_results || 5,
      search_depth: "advanced", // или "basic"
    });

    return {
      tool_call_id: toolCall.id,
      role: "tool",
      name: "web_search",
      content: JSON.stringify(results.results || results), // возвращаем результаты
    };
  }
  return null;
}

// === Основной обработчик чата ===
module.exports = async function chatHandler(req, res) {
  try {
    const { messages, model = "llama-3.3-70b-versatile" } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages required" });
    }

    let currentMessages = [...messages];

    const maxIterations = 5; // защита от бесконечного цикла
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const completion = await groq.chat.completions.create({
        model: model,
        messages: currentMessages,
        tools: [tavilyTool],
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 1024,
      });

      const responseMessage = completion.choices[0].message;

      // Добавляем ответ модели в историю
      currentMessages.push(responseMessage);

      // Если модель не хочет вызывать инструменты — выходим
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        return res.json({
          content: responseMessage.content,
          usage: completion.usage,
        });
      }

      // Выполняем все tool calls (Tavily)
      const toolResults = [];
      for (const toolCall of responseMessage.tool_calls) {
        const result = await executeTool(toolCall);
        if (result) toolResults.push(result);
      }

      // Добавляем результаты инструментов обратно в чат
      currentMessages.push(...toolResults);
    }

    // Если вышли по лимиту итераций
    res.json({
      content: "Извини, слишком много шагов поиска. Попробуй уточнить запрос.",
    });

  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
};
