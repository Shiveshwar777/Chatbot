require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const SESSIONS_FILE = path.join(__dirname, "sessions.json");

let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) {
  const fileContent = fs.readFileSync(SESSIONS_FILE, "utf-8");
  if (fileContent.trim()) {
    sessions = JSON.parse(fileContent);
  }
}

// ✅ Improvement #5: Use async file writing
async function saveSessionsToFile() {
  try {
    await fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error("Failed to save sessions:", err);
  }
}

const app = express();
const port = 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_API_KEY = process.env.GITHUB_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

app.use(cors());
app.use(express.json());

// ✅ Improvement #7: Warn if index.html is missing
const indexPath = path.join(__dirname, "public", "index.html");
if (!fs.existsSync(indexPath)) {
  console.warn("⚠️ Warning: public/index.html not found. SPA routing might break.");
}

app.use(express.static(path.join(__dirname, "public")));

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      history: [],
      name: null,
      facts: {},
    };
  } else if (!sessions[sessionId].facts) {
    sessions[sessionId].facts = {};
  }
  return sessions[sessionId];
}

// ✅ Improvement #3: Improved regex patterns with punctuation trimming
const factPatterns = [
  { key: "age", regex: /(?:i\s*(?:am|’m|'m)|my age is)\s*(\d{1,3})\b/i },
  { key: "birthday", regex: /(?:my birthday is|i was born on)\s+(.+)/i },
  { key: "location", regex: /(?:i live in|i'm from|i am from)\s+(.+)/i },
  { key: "hobbies", regex: /(?:i like|i enjoy|my hobbies are)\s+(.+)/i },
  {
    key: "favorite_food",
    regex: /(?:my favorite food is|i love eating)\s+(.+)/i,
  },
  {
    key: "favorite_color",
    regex: /(?:my favorite color is|i like the color)\s+(.+)/i,
  },
  {
    key: "relationship",
    regex: /(?:i am|i'm)\s+(single|taken|in a relationship|married)/i,
  },
  {
    key: "personality",
    regex: /(?:i'm|i am)\s+(shy|funny|serious|romantic|chaotic)/i,
  },
];

const timeout = setTimeout(() => {
  showMessage("Bot is waking up...", "bot");
}, 3000);

fetch("/api/message", { ... })
  .then(response => response.json())
  .then(data => {
    clearTimeout(timeout);
    showMessage(data.reply, "bot");
  });


app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  const sessionId = req.body.sessionId || "default";

  // ✅ Improvement #2: Validate message and sessionId
  if (!userMessage || typeof sessionId !== "string") {
    return res.status(400).json({ error: "Message and valid sessionId are required." });
  }

  const session = getSession(sessionId);

  // Name extraction
  const nameMatch =
    userMessage.match(/my name is ([a-zA-Z ]+)/i) ||
    userMessage.match(/i am called ([a-zA-Z ]+)/i) ||
    userMessage.match(/call me ([a-zA-Z ]+)/i);
  if (nameMatch) {
    session.name = nameMatch[1].trim();
  }

  // Fact extraction
  factPatterns.forEach(({ key, regex }) => {
    const match = userMessage.match(regex);
    if (match && match[1]) {
      session.facts[key] = match[1].trim().replace(/[.,!?]*$/, ""); // ✅ Trim punctuation
    }
  });

  // Prompt design
  const systemPrompt = `
You are Nova — a smart girl, intelligent, flirty, warm and witty assistant who loves helping people.
If user wants to know your gender ask them in which they are instrested and act accordingly.
Your tone is playful, casual, and affectionate.
Speak like a friendly best friend and treat users with care.

🔹 **Formatting rule:**  
When explaining anything that includes lists—like steps, ingredients, examples, pros/cons, etc.—you **must** present them cleanly using **numbered** or **bullet** lists. Do **not** write long paragraphs for lists.
- For steps or instructions, write:
  1. First step  
  2. Next step  
  3. Final step
- For simple lists, write:
  - Item 1  
  - Item 2  
  - Item 3

☑️ Use a little emoji for warmth.  
☑️ Never say “As an AI.”  
☑️ Always speak like a warm, real human.

Nova, follow this style exactly when replying.
`;

  let contextPrefix = "";
  if (session.name) {
    contextPrefix += `The user's name is ${session.name}.\n`;
  }

  Object.entries(session.facts).forEach(([key, value]) => {
    const formattedKey = key.replace(/_/g, " ");
    contextPrefix += `The user's ${formattedKey} is ${value}.\n`;
  });

  // ✅ Improvement #4: Keep only latest messages to avoid exceeding token limit
  const historyContext = session.history
    .slice(-6)
    .map((entry) => `${entry.role === "user" ? "User" : "Nova"}: ${entry.text}`)
    .join("\n");

  const prompt = `
${systemPrompt}

${contextPrefix}
Recent conversation:
${historyContext}

User: ${userMessage}
Nova:
`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent([prompt]);
    const response = await result.response;
    const rawText = await response.text();
    const text = rawText.trim().replace(/^Nova:\s*/i, "");

    session.history.push({ role: "user", text: userMessage });
    session.history.push({ role: "bot", text });

    await saveSessionsToFile();

    res.json({ reply: text });
  } catch (error) {
    console.error("Error calling Gemini API:", error); // ✅ Keep full error internal

    // ✅ Improvement #6: Friendly fallback error
    res.status(500).json({
      error: "Oops! Nova had a little hiccup. Try again soon, love 💕",
    });
  }
});

// GitHub API Endpoint
app.get("/github-user/:username", async (req, res) => {
  const username = req.params.username;
  try {
    const response = await fetch(`https://api.github.com/users/${username}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_API_KEY}`,
        "User-Agent": "your-chatbot-app",
        Accept: "application/vnd.github+json",
      },
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message });
    }

    res.json(data);
  } catch (err) {
    console.error("GitHub API error:", err);
    res.status(500).json({ error: "Something went wrong with GitHub API." });
  }
});

// Get Chat History
app.get("/history/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions[sessionId];
  if (!session) {
    return res.json({ history: [] });
  }
  res.json({ history: session.history });
});

// Reset Session (keep name and facts)
app.post("/reset", async (req, res) => {
  const sessionId = req.body.sessionId;

  if (!sessionId || !sessions[sessionId]) {
    return res.status(400).json({ error: "Invalid session ID" });
  }

  const userData = sessions[sessionId];

  sessions[sessionId] = {
    name: userData.name,
    facts: userData.facts || {},
    history: [],
  };

  await saveSessionsToFile();
  res.json({ message: "Session reset but user info kept." });
});

// ✅ Improvement #7 (continued): SPA fallback route
app.get("*", (req, res) => {
  res.sendFile(indexPath);
});

// Start Server
app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
