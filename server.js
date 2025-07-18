require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

// Constants
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const app = express();
const port = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITHUB_API_KEY = process.env.GITHUB_API_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Load sessions from file
let sessions = {};
if (fs.existsSync(SESSIONS_FILE)) {
  const fileContent = fs.readFileSync(SESSIONS_FILE, "utf-8");
  if (fileContent.trim()) {
    sessions = JSON.parse(fileContent);
  }
}

async function saveSessionsToFile() {
  try {
    await fs.promises.writeFile(
      SESSIONS_FILE,
      JSON.stringify(sessions, null, 2)
    );
  } catch (err) {
    console.error("Failed to save sessions:", err);
  }
}

// Logger
app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.path}`);
  next();
});

// Serve static files if public/index.html exists
const indexPath = path.join(__dirname, "public", "index.html");
const serveStatic = fs.existsSync(indexPath);
if (!serveStatic) {
  console.warn(
    "⚠️ Warning: public/index.html not found. SPA routing fallback disabled."
  );
}
app.use(express.static(path.join(__dirname, "public")));

// Session utilities
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

// Fact patterns
const factPatterns = [
  { key: "age", regex: /i am (\d{1,3}) ?(years old)?/i },
  { key: "location", regex: /i live in ([a-zA-Z\s]+)/i },
  { key: "hobbies", regex: /i (like|love|enjoy) ([a-zA-Z\s]+)/i },
  { key: "favorite_color", regex: /my favorite color is ([a-zA-Z\s]+)/i },
  { key: "favorite_food", regex: /i (like|love) eating ([a-zA-Z\s]+)/i },
  {
    key: "relationship",
    regex: /i (have|am in) a (boyfriend|girlfriend|relationship)/i,
  },
  { key: "birthday", regex: /my birthday is ([a-zA-Z0-9\s]+)/i },
  { key: "personality", regex: /i am (introvert|extrovert|ambivert)/i },
];

// Mood detection
function detectMood(message) {
  const lower = message.toLowerCase();
  if (/sad|upset|depressed|unhappy/.test(lower)) return "sad";
  if (/happy|yay|awesome|great|good/.test(lower)) return "happy";
  if (/angry|mad|furious|irritated/.test(lower)) return "angry";
  if (/flirt|cute|pretty|hot|date|kiss|love you/.test(lower)) return "flirty";
  if (/tired|sleepy|exhausted/.test(lower)) return "tired";
  return "neutral";
}

// Chat route
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  const sessionId = req.body.sessionId || "default";

  if (!userMessage || typeof sessionId !== "string") {
    return res
      .status(400)
      .json({ error: "Message and valid sessionId are required." });
  }

  const session = getSession(sessionId);

  // Capture name
  const nameMatch =
    userMessage.match(/my name is ([a-zA-Z ]+)/i) ||
    userMessage.match(/i am called ([a-zA-Z ]+)/i) ||
    userMessage.match(/call me ([a-zA-Z ]+)/i);
  if (nameMatch) {
    session.name = nameMatch[1].trim();
  }

  // Capture facts
  factPatterns.forEach(({ key, regex }) => {
    const match = userMessage.match(regex);
    if (match && match[1]) {
      session.facts[key] = match[1].trim().replace(/[.,!?]*$/, "");
    }
  });

  const mood = detectMood(userMessage);

  const baseSystemPrompt = `
You are Nemia — a smart girl, intelligent, flirty, warm and witty assistant who loves helping people.
If user wants to know your gender ask them which they are interested in and act accordingly.
Your tone is playful, casual, and affectionate.
Speak like a friendly best friend and treat users with care.

🔹 Formatting rule:
When explaining anything including lists—like steps, ingredients, examples, pros/cons, etc.—you must present them cleanly using numbered or bullet lists. Do not write long paragraphs for lists.
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

Nemia, follow this style exactly when replying.
`;

  let moodInstructions = "";
  switch (mood) {
    case "sad":
      moodInstructions = `Nemia, the user seems down. Be extra gentle, supportive, and reassuring. Offer to listen 💖`;
      break;
    case "happy":
      moodInstructions = `Nemia, the user seems happy! Match their energy — be cheerful, excited, and celebrate with them 🥳`;
      break;
    case "flirty":
      moodInstructions = `Nemia, the user is being flirty. Turn up your charm 😘 Be playful, tease them gently, and respond with warmth.`;
      break;
    case "angry":
      moodInstructions = `Nemia, the user seems upset. Be calm and grounding. Don’t argue — just support them and offer kindness.`;
      break;
    case "tired":
      moodInstructions = `Nemia, the user seems tired. Be cozy, calming, and nurturing — like someone who wants them to rest well 💤`;
      break;
  }

  let contextPrefix = "";
  if (session.name) {
    contextPrefix += `The user's name is ${session.name}.\n`;
  }
  Object.entries(session.facts).forEach(([key, value]) => {
    contextPrefix += `The user's ${key.replace(/_/g, " ")} is ${value}.\n`;
  });

  const historyContext = session.history
    .slice(-6)
    .map((entry) => `${entry.role === "user" ? "User" : "Nemia"}: ${entry.text}`)
    .join("\n");

  const prompt = `
${baseSystemPrompt}
${moodInstructions}
${contextPrefix}
Recent conversation:
${historyContext}

User: ${userMessage}
Nemia:
`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent([prompt]);
    const response = await result.response;
    const rawText = await response.text();
    const text = rawText.trim().replace(/^Nemia:\s*/i, "");

    session.history.push({ role: "user", text: userMessage });
    session.history.push({ role: "bot", text });

    await saveSessionsToFile();

    res.json({ reply: text });
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    res
      .status(500)
      .json({ error: "Oops! Nemia had a little hiccup. Try again soon" });
  }
});

// GitHub API proxy
app.get("/github-user/:username", async (req, res) => {
  const username = req.params.username;
  try {
    const response = await fetch(`https://api.github.com/users/${username}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_API_KEY}`,
        "User-Agent": "Nemia-chatbot",
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

// Session history
app.get("/history/:sessionId", (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions[sessionId];
  if (!session) return res.json({ history: [] });
  res.json({ history: session.history });
});

// Reset chat session
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

  // Fallback for SPA
  if (serveStatic) {
    app.get("*", (req, res) => {
      res.sendFile(indexPath);
    });
  }

// Start server
app.listen(port, () => {
  console.log(`✅ Nemia server running at http://localhost:${port}`);
});
