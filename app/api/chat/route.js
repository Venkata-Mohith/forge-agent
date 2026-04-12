import { NextResponse } from "next/server";

export const maxDuration = 60;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

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
      { headers: { "User-Agent": "Mozilla/5.0" } }
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
      currentQ.options = line.slice(2).trim().split('|').map(o => o.trim()).filter(Boolean);
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
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return NextResponse.json({ error: "GROQ_API_KEY not set in .env.local" }, { status: 500 });

    const { messages, systemPrompt } = await req.json();

    const groqMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ];

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: groqMessages,
        max_tokens: 4096,
        temperature: 0.8,
      }),
    });

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
        const followUpRes = await fetch(GROQ_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              ...groqMessages,
              { role: "assistant", content: cleanText || "Let me search for that." },
              { role: "user", content: `Search results for "${searchQuery}":\n\n${searchResults}\n\nAnswer using these results.` }
            ],
            max_tokens: 2048,
            temperature: 0.7,
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
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}