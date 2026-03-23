import { NextResponse } from "next/server";


export const maxDuration = 300; // 5 minute timeout for slow local models
const OLLAMA_URL = "http://localhost:11434/v1/chat/completions";
const MODEL = "qwen2.5:3b";

async function webSearch(query) {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`,
      { headers: { "User-Agent": "FORGE-Agent/1.0" } }
    );
    const data = await res.json();
    const results = [];
    if (data.AbstractText) results.push(data.AbstractText);
    if (data.Answer) results.push(`Answer: ${data.Answer}`);
    data.RelatedTopics?.slice(0, 3).forEach(t => { if (t.Text) results.push(t.Text); });
    if (results.length > 0) return results.join("\n\n");
    const htmlRes = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; FORGE/1.0)" } }
    );
    const html = await htmlRes.text();
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([^<]{20,300})</g)]
      .slice(0, 3).map(m => m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim());
    return snippets.length > 0 ? snippets.join("\n\n") : null;
  } catch { return null; }
}

function parseQOFormat(text) {
  const blockMatch = text.match(/::QUESTIONS::([\s\S]*?)::END::/);
  if (!blockMatch) return null;
  const lines = blockMatch[1].split('\n').map(l => l.trim()).filter(Boolean);
  const questions = [];
  let currentQ = null;
  for (const line of lines) {
    if (line.startsWith('Q:')) {
      if (currentQ) questions.push(currentQ);
      currentQ = { q: line.slice(2).trim(), options: [] };
    } else if (line.startsWith('O:') && currentQ) {
      const optStr = line.slice(2).trim();
      currentQ.options = optStr ? optStr.split('|').map(o => o.trim()).filter(Boolean) : [];
    }
  }
  if (currentQ) questions.push(currentQ);
  return questions.length > 0 ? questions : null;
}

function normalizeQuestions(text) {
  if (/<questions>[\s\S]*?<\/questions>/.test(text)) return text;
  const questions = parseQOFormat(text);
  if (!questions) return text;
  const tagged = `<questions>\n${JSON.stringify(questions, null, 2)}\n</questions>`;
  const clean = text.replace(/::QUESTIONS::[\s\S]*?::END::/g, '').trim();
  return (clean + '\n\n' + tagged).trim();
}

function normalizeSuggestions(text) {
  if (/<suggestions>[\s\S]*?<\/suggestions>/.test(text)) return text;
  const match = text.match(/\[\s*"[^"\[\]]{5,}"(?:\s*,\s*"[^"\[\]]{5,}")*\s*\]/);
  if (!match) return text;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed) && parsed.every(s => typeof s === "string")) {
      return text.replace(match[0], `<suggestions>\n${JSON.stringify(parsed)}\n</suggestions>`).trim();
    }
  } catch {}
  return text;
}

function extractSearchQuery(text) {
  const match = text.match(/::SEARCH::\s*(.+?)\s*::DONE::/);
  return match ? match[1].trim() : null;
}

export async function POST(req) {
  try {
    const { messages, systemPrompt } = await req.json();

    const ollamaMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ];

   const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120000); // 2 min timeout

const res = await fetch(OLLAMA_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  signal: controller.signal,
  body: JSON.stringify({
    model: MODEL,
    messages: ollamaMessages,
    stream: false,
    options: { temperature: 0.8, num_predict: 512 }, // reduced tokens for speed
  }),
});
clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: err }, { status: 400 });
    }

    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || "";

    const searchQuery = extractSearchQuery(text);
    if (searchQuery) {
      const searchResults = await webSearch(searchQuery);
      const cleanText = text.replace(/::SEARCH::[\s\S]*?::DONE::/g, '').trim();
      if (searchResults) {
        const followUpRes = await fetch(OLLAMA_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              ...ollamaMessages,
              { role: "assistant", content: cleanText || "Let me search for that." },
              { role: "user", content: `Search results for "${searchQuery}":\n\n${searchResults}\n\nAnswer using these results.` }
            ],
            stream: false,
            options: { temperature: 0.7, num_predict: 4096 },
          }),
        });
        const data2 = await followUpRes.json();
        text = data2.choices?.[0]?.message?.content || text;
        text = `🔍 *Searched: "${searchQuery}"*\n\n` + text;
      } else {
        text = cleanText;
      }
    }

    text = normalizeQuestions(text);
    text = normalizeSuggestions(text);

    const files = [...text.matchAll(/:::FILE:([^:]+):::/g)].map(m => m[1].trim());
    return NextResponse.json({ text, searchQuery: searchQuery || null, files });
  } catch (err) {
    if (err.message?.includes("ECONNREFUSED") || err.message?.includes("fetch failed")) {
      return NextResponse.json({ error: "Ollama is not running. Run: ollama serve" }, { status: 503 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}