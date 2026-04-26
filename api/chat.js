// api/chat.js
const Groq = require('groq-sdk');
const { tavily } = require('@tavily/core');
require('dotenv').config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// === Проверка на наличие изображения ===
function hasImage(messages) {
  return messages.some(msg => {
    if (!msg.content) return false;
    if (typeof msg.content === 'string') return msg.content.includes('data:image');
    if (Array.isArray(msg.content)) {
      return msg.content.some(item => 
        item.type === 'image_url' || 
        (item.image_url && item.image_url.url && item.image_url.url.includes('data:image'))
      );
    }
    return false;
  });
}

// === Выбор модели ===
function getModel(messages) {
  const imageDetected = hasImage(messages);
  console.log(`[DEBUG] Изображение обнаружено: ${imageDetected}`);

  if (imageDetected) {
    console.log("[Model] → Llama 4 Scout (vision)");
    return "meta-llama/llama-4-scout-17b-16e-instruct";
  }

  console.log("[Model] → Llama 3.1 8B (текст)");
  return "llama-3.1-8b-instant";
}

// === Tavily Tool ===
const tavilyTool = {
  type: "function",
  function: {
    name: "web_search",
    description: "Поиск актуальной информации в интернете в реальном времени.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Что искать" }, max_results: { type: "number", default: 5 } },
      required: ["query"],
    },
  },
};

async function executeTool(toolCall) {
  if (toolCall.function.name === "web_search") {
    const args = JSON.parse(toolCall.function.arguments);
    const results = await tvly.search({ query: args.query, max_results: args.max_results || 5 });
    return { tool_call_id: toolCall.id, role: "tool", name: "web_search", content: JSON.stringify(results.results || results) };
  }
  return null;
}

// === Основной обработчик ===
module.exports = async function chatHandler(req, res) {
  try {
    const { messages } = req.body;
    console.log("[DEBUG] Запрос получен. Сообщений:", messages?.length || 0);

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages required" });
    }

    const model = getModel(messages);

    let currentMessages = [...messages];
    const maxIterations = 5;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      const completion = await groq.chat.completions.create({
        model: model,
        messages: currentMessages,
        tools: model.includes("scout") ? [tavilyTool] : undefined,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 1024,
      });

      const responseMessage = completion.choices[0].message;
      currentMessages.push(responseMessage);

      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        return res.json({ content: responseMessage.content, modelUsed: model });
      }

      const toolResults = [];
      for (const toolCall of responseMessage.tool_calls) {
        const result = await executeTool(toolCall);
        if (result) toolResults.push(result);
      }
      currentMessages.push(...toolResults);
    }

    res.json({ content: "Слишком много шагов. Уточни запрос." });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({ error: error.message || "Внутренняя ошибка" });
  }
};
