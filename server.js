const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
const PORT = process.env.PORT || 10000;
const GROQ_KEY = process.env.GROQ_API_KEY;
const TAVILY_KEY = process.env.TAVILY_API_KEY;

app.get("/", (req, res) => {
  res.json({
    name: "ARC X",
    status: "online",
    message: "ARC X AI Search Engine backend is running."
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    groqConfigured: !!GROQ_KEY,
    tavilyConfigured: !!TAVILY_KEY
  });
});

app.post("/api/search", async (req, res) => {
  try {
    const question = String(req.body.question || "").trim();

    if (!question) {
      return res.status(400).json({
        error: "Please enter a question."
      });
    }

    if (!GROQ_KEY || !TAVILY_KEY) {
      return res.status(500).json({
        error: "ARC X API keys are not configured on the server."
      });
    }

    // STEP 1: Search the live web with Tavily
    const searchResponse = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TAVILY_KEY}`
      },
      body: JSON.stringify({
        query: question,
        search_depth: "basic",
        topic: "general",
        max_results: 6,
        include_answer: false,
        include_raw_content: false
      })
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();

      return res.status(502).json({
        error: "Web search failed.",
        details: errorText
      });
    }

    const searchData = await searchResponse.json();

    const sources = (searchData.results || []).map((item, index) => ({
      id: index + 1,
      title: item.title,
      url: item.url,
      content: item.content,
      score: item.score
    }));

    if (sources.length === 0) {
      return res.json({
        answer: "I couldn't find useful web sources for that question.",
        sources: []
      });
    }

    // STEP 2: Give the live search results to Groq
    const sourceText = sources
      .map(
        (source) =>
          `[SOURCE ${source.id}]
Title: ${source.title}
URL: ${source.url}
Content: ${source.content}`
      )
      .join("\n\n");

    const systemPrompt = `
You are ARC X, a real AI search and research engine.

Answer the user's question using the supplied live web search sources.

Rules:
1. Do not pretend you searched anything beyond the supplied sources.
2. Prefer accurate and recent information.
3. If sources disagree, clearly explain the disagreement.
4. Do not invent facts or sources.
5. Cite claims using [1], [2], [3], etc.
6. Only use citation numbers that actually exist in the supplied sources.
7. Give a useful direct answer first.
8. Use headings or bullet points when they improve readability.
9. If the evidence is insufficient, say so honestly.
`;

    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_KEY}`
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: `USER QUESTION:
${question}

LIVE WEB SOURCES:
${sourceText}`
            }
          ],
          temperature: 0.2,
          max_completion_tokens: 1800
        })
      }
    );

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();

      return res.status(502).json({
        error: "AI response failed.",
        details: errorText
      });
    }

    const groqData = await groqResponse.json();

    const answer =
      groqData.choices?.[0]?.message?.content ||
      "ARC X could not generate an answer.";

    // STEP 3: Return the AI answer + original sources
    res.json({
      answer,
      sources: sources.map((source) => ({
        id: source.id,
        title: source.title,
        url: source.url
      }))
    });
  } catch (error) {
    console.error("ARC X error:", error);

    res.status(500).json({
      error: "Something went wrong inside ARC X."
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ARC X running on port ${PORT}`);
});
