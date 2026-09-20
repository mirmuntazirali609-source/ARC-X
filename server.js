const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

/* =========================================================
   BASIC HEALTH / STATUS
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "ARC X",
    groqConfigured: !!GROQ_API_KEY,
    tavilyConfigured: !!TAVILY_API_KEY,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    groqConfigured: !!GROQ_API_KEY,
    tavilyConfigured: !!TAVILY_API_KEY
  });
});

/* =========================================================
   GROQ AI
========================================================= */

async function askGroq(messages, options = {}) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured on the server.");
  }

  const model =
    options.model ||
    "llama-3.3-70b-versatile";

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature:
          typeof options.temperature === "number"
            ? options.temperature
            : 0.7,
        max_tokens:
          options.max_tokens || 3000
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Groq error:", data);

    throw new Error(
      data?.error?.message ||
      "Groq API request failed."
    );
  }

  return data?.choices?.[0]?.message?.content || "";
}

/* =========================================================
   TAVILY WEB SEARCH
========================================================= */

async function tavilySearch(query, options = {}) {
  if (!TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is not configured on the server.");
  }

  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: options.search_depth || "advanced",
        topic: options.topic || "general",
        max_results: options.max_results || 8,
        include_answer: false,
        include_raw_content: false,
        include_images: false
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Tavily error:", data);

    throw new Error(
      data?.message ||
      data?.error ||
      "Tavily search failed."
    );
  }

  return Array.isArray(data.results)
    ? data.results
    : [];
}

/* =========================================================
   NORMAL CHAT
   POST /api/chat
========================================================= */

app.post("/api/chat", async (req, res) => {
  try {
    const message =
      req.body?.message ||
      req.body?.query ||
      req.body?.prompt;

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Message is required."
      });
    }

    const history = Array.isArray(req.body?.messages)
      ? req.body.messages
      : [];

    const messages = [
      {
        role: "system",
        content: `
You are ARC X, an advanced AI assistant.

Be accurate, useful, clear and honest.
Do not claim to have searched the web unless a web-search
request was actually performed.

You can help with:
- questions and explanations
- writing
- coding
- brainstorming
- education
- analysis
- research planning

If information may be outdated, tell the user that live
web search should be used.
        `.trim()
      }
    ];

    for (const item of history.slice(-12)) {
      if (
        item &&
        (item.role === "user" || item.role === "assistant") &&
        item.content
      ) {
        messages.push({
          role: item.role,
          content: String(item.content)
        });
      }
    }

    messages.push({
      role: "user",
      content: String(message)
    });

    const answer = await askGroq(messages);

    res.json({
      ok: true,
      answer,
      response: answer,
      mode: "chat",
      model: "llama-3.3-70b-versatile"
    });

  } catch (error) {
    console.error("CHAT ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "ARC X chat failed."
    });
  }
});

/* =========================================================
   WEB SEARCH
   POST /api/search
========================================================= */

app.post("/api/search", async (req, res) => {
  try {
    const query =
      req.body?.query ||
      req.body?.message ||
      req.body?.prompt;

    if (!query || !String(query).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Search query is required."
      });
    }

    const results = await tavilySearch(String(query), {
      search_depth: "advanced",
      max_results: 8
    });

    const cleanedResults = results.map((item, index) => ({
      position: index + 1,
      title: item.title || "Untitled",
      url: item.url || "",
      content: item.content || "",
      score: item.score || null
    }));

    res.json({
      ok: true,
      query: String(query),
      results: cleanedResults,
      sources: cleanedResults,
      mode: "web-search"
    });

  } catch (error) {
    console.error("SEARCH ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Web search failed."
    });
  }
});

/* =========================================================
   WEB SEARCH + AI ANSWER
   POST /api/search-answer
========================================================= */

app.post("/api/search-answer", async (req, res) => {
  try {
    const query =
      req.body?.query ||
      req.body?.message ||
      req.body?.prompt;

    if (!query || !String(query).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Search query is required."
      });
    }

    const results = await tavilySearch(String(query), {
      search_depth: "advanced",
      max_results: 8
    });

    const sourceText = results
      .map((item, index) => {
        return `
SOURCE ${index + 1}
Title: ${item.title || "Untitled"}
URL: ${item.url || ""}
Content:
${item.content || ""}
        `.trim();
      })
      .join("\n\n");

    const answer = await askGroq([
      {
        role: "system",
        content: `
You are ARC X Web Search.

Answer the user's question using the supplied web sources.

Rules:
1. Prefer information supported by the sources.
2. Do not invent facts.
3. If sources disagree, clearly mention the disagreement.
4. Keep the answer readable.
5. At the end provide a "Sources" section.
6. Include source titles and URLs.
        `.trim()
      },
      {
        role: "user",
        content: `
User question:
${query}

Web sources:
${sourceText}
        `.trim()
      }
    ], {
      temperature: 0.3,
      max_tokens: 4000
    });

    res.json({
      ok: true,
      query: String(query),
      answer,
      response: answer,
      results,
      sources: results,
      mode: "web-search"
    });

  } catch (error) {
    console.error("SEARCH-ANSWER ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Web search answer failed."
    });
  }
});

/* =========================================================
   DEEP RESEARCH
   POST /api/research
========================================================= */

app.post("/api/research", async (req, res) => {
  try {
    const query =
      req.body?.query ||
      req.body?.message ||
      req.body?.prompt;

    if (!query || !String(query).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Research topic is required."
      });
    }

    const results = await tavilySearch(String(query), {
      search_depth: "advanced",
      max_results: 10
    });

    const sourceText = results
      .map((item, index) => {
        return `
SOURCE ${index + 1}
Title: ${item.title || "Untitled"}
URL: ${item.url || ""}
Information:
${item.content || ""}
        `.trim();
      })
      .join("\n\n");

    const research = await askGroq([
      {
        role: "system",
        content: `
You are ARC X Deep Research.

Produce a structured research report based on the
web sources supplied to you.

Use these sections where appropriate:

# Executive Summary
# Key Findings
# Detailed Analysis
# Important Facts
# Different Perspectives
# Limitations / Uncertainty
# Sources

Do not fabricate information.
Distinguish facts from interpretations.
Cite sources by their title and URL.
        `.trim()
      },
      {
        role: "user",
        content: `
Research topic:
${query}

Collected sources:
${sourceText}
        `.trim()
      }
    ], {
      temperature: 0.25,
      max_tokens: 6000
    });

    res.json({
      ok: true,
      query: String(query),
      answer: research,
      research,
      results,
      sources: results,
      mode: "deep-research"
    });

  } catch (error) {
    console.error("RESEARCH ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Deep research failed."
    });
  }
});

/* =========================================================
   CREATE
   POST /api/create
========================================================= */

app.post("/api/create", async (req, res) => {
  try {
    const prompt =
      req.body?.prompt ||
      req.body?.query ||
      req.body?.message;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Creation prompt is required."
      });
    }

    const type =
      req.body?.type ||
      "general";

    const answer = await askGroq([
      {
        role: "system",
        content: `
You are ARC X Create.

Help the user create high-quality content.

Creation types may include:
- social posts
- scripts
- articles
- emails
- documents
- ideas
- marketing copy
- stories
- summaries

Follow the user's requested format and length.
Do not add unnecessary explanations.
        `.trim()
      },
      {
        role: "user",
        content: `
Creation type:
${type}

Request:
${prompt}
        `.trim()
      }
    ], {
      temperature: 0.8,
      max_tokens: 4000
    });

    res.json({
      ok: true,
      answer,
      response: answer,
      type,
      mode: "create"
    });

  } catch (error) {
    console.error("CREATE ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Create failed."
    });
  }
});

/* =========================================================
   CODE
   POST /api/code
========================================================= */

app.post("/api/code", async (req, res) => {
  try {
    const prompt =
      req.body?.prompt ||
      req.body?.query ||
      req.body?.message;

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        ok: false,
        error: "Coding request is required."
      });
    }

    const answer = await askGroq([
      {
        role: "system",
        content: `
You are ARC X Code.

You are an advanced programming assistant.

Help users:
- write code
- debug code
- explain code
- design applications
- fix errors
- improve architecture
- create APIs
- create frontend interfaces

Give complete usable code when requested.
Clearly identify important files.
Do not pretend code has been executed if it has not.
        `.trim()
      },
      {
        role: "user",
        content: String(prompt)
      }
    ], {
      temperature: 0.2,
      max_tokens: 6000
    });

    res.json({
      ok: true,
      answer,
      response: answer,
      mode: "code"
    });

  } catch (error) {
    console.error("CODE ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Code request failed."
    });
  }
});

/* =========================================================
   COMPATIBILITY ROUTES
   These allow different frontend button implementations
   to communicate with the same backend.
========================================================= */

app.post("/api/web-search", async (req, res) => {
  req.url = "/api/search";
  try {
    const query =
      req.body?.query ||
      req.body?.message ||
      req.body?.prompt;

    if (!query) {
      return res.status(400).json({
        ok: false,
        error: "Search query is required."
      });
    }

    const results = await tavilySearch(String(query), {
      search_depth: "advanced",
      max_results: 8
    });

    res.json({
      ok: true,
      query,
      results,
      sources: results,
      mode: "web-search"
    });

  } catch (error) {
    console.error("WEB SEARCH ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Web search failed."
    });
  }
});

app.post("/api/deep-research", async (req, res) => {
  try {
    const query =
      req.body?.query ||
      req.body?.message ||
      req.body?.prompt;

    if (!query) {
      return res.status(400).json({
        ok: false,
        error: "Research topic is required."
      });
    }

    const results = await tavilySearch(String(query), {
      search_depth: "advanced",
      max_results: 10
    });

    const sourceText = results
      .map((item, index) =>
        `SOURCE ${index + 1}
Title: ${item.title}
URL: ${item.url}
Content: ${item.content}`
      )
      .join("\n\n");

    const answer = await askGroq([
      {
        role: "system",
        content:
          "You are ARC X Deep Research. Analyze the supplied sources carefully, synthesize the information, identify uncertainty, and finish with a Sources section containing the source titles and URLs."
      },
      {
        role: "user",
        content:
          `Research this topic:\n${query}\n\nSources:\n${sourceText}`
      }
    ], {
      temperature: 0.25,
      max_tokens: 6000
    });

    res.json({
      ok: true,
      query,
      answer,
      research: answer,
      results,
      sources: results,
      mode: "deep-research"
    });

  } catch (error) {
    console.error("DEEP RESEARCH ERROR:", error);

    res.status(500).json({
      ok: false,
      error: error.message || "Deep research failed."
    });
  }
});

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "ARC X endpoint not found.",
    path: req.path
  });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  res.status(500).json({
    ok: false,
    error: "Internal ARC X server error."
  });
});

/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log("        ARC X AI SUPER APP");
  console.log("========================================");
  console.log(`Server running on port ${PORT}`);
  console.log(`Groq configured: ${!!GROQ_API_KEY}`);
  console.log(`Tavily configured: ${!!TAVILY_API_KEY}`);
  console.log("========================================");
});
