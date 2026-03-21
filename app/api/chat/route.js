import { NextResponse } from "next/server";

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// ── Web search using DuckDuckGo — no API key, completely free ──
async function webSearch(query) {
  try {
    // DuckDuckGo instant answer API — free, no key needed
    const ddgRes = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "FORGE-Agent/1.0" } }
    );
    const ddg = await ddgRes.json();

    const results = [];

    // Abstract (main answer)
    if (ddg.AbstractText) {
      results.push(`${ddg.AbstractText} (${ddg.AbstractURL})`);
    }

    // Answer (instant answer like calculations, facts)
    if (ddg.Answer) {
      results.push(`Answer: ${ddg.Answer}`);
    }

    // Related topics
    if (ddg.RelatedTopics?.length > 0) {
      ddg.RelatedTopics.slice(0, 3).forEach(t => {
        if (t.Text) results.push(t.Text);
      });
    }

    // Infobox data
    if (ddg.Infobox?.content?.length > 0) {
      ddg.Infobox.content.slice(0, 3).forEach(item => {
        if (item.label && item.value) results.push(`${item.label}: ${item.value}`);
      });
    }

    if (results.length > 0) return results.join("\n\n");

    // Fallback: DuckDuckGo HTML search scrape (gets actual results)
    const htmlRes = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; FORGE/1.0)" } }
    );
    const html = await htmlRes.text();

    // Extract result snippets from HTML
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([^<]{20,300})</g)]
      .slice(0, 4)
      .map(m => m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#x27;/g,"'").trim());

    return snippets.length > 0 ? snippets.join("\n\n") : null;
  } catch (err) {
    return null;
  }
}

// ── Parse Q:/O: format ──
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
    if (!GROQ_KEY) return NextResponse.json({ error: "GROQ_API_KEY not set" }, { status: 500 });

    const groqMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
    ];

    // First call to Groq
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: groqMessages, max_tokens: 4096, temperature: 0.8 }),
    });
    const data = await res.json();
    if (data.error) return NextResponse.json({ error: data.error.message }, { status: 400 });

    let text = data.choices?.[0]?.message?.content || "";

    // Handle web search if FORGE requested it
    const searchQuery = extractSearchQuery(text);
    if (searchQuery) {
      const searchResults = await webSearch(searchQuery);
      const cleanText = text.replace(/::SEARCH::[\s\S]*?::DONE::/g, '').trim();

      if (searchResults) {
        const followUpMessages = [
          ...groqMessages,
          { role: "assistant", content: cleanText || "Let me search for that." },
          {
            role: "user",
            content: `Search results for "${searchQuery}":\n\n${searchResults}\n\nAnswer the original question using these search results. Be specific and cite what you found.`
          }
        ];
        const res2 = await fetch(GROQ_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({ model: MODEL, messages: followUpMessages, max_tokens: 4096, temperature: 0.7 }),
        });
        const data2 = await res2.json();
        text = data2.choices?.[0]?.message?.content || text;
        text = `🔍 *Searched: "${searchQuery}"*\n\n` + text;
      } else {
        // Search returned nothing — just use the original response without the search tag
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