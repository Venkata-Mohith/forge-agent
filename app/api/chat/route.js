import { NextResponse } from "next/server";

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// ── Parse simple Q:/O: format into questions array ──
function parseQOFormat(text) {
  const blockMatch = text.match(/::QUESTIONS::([\s\S]*?)::END::/);
  if (!blockMatch) return null;

  const block = blockMatch[1];
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  const questions = [];
  let currentQ = null;

  for (const line of lines) {
    if (line.startsWith('Q:')) {
      if (currentQ) questions.push(currentQ);
      currentQ = { q: line.slice(2).trim(), options: [] };
    } else if (line.startsWith('O:') && currentQ) {
      const optStr = line.slice(2).trim();
      currentQ.options = optStr
        ? optStr.split('|').map(o => o.trim()).filter(Boolean)
        : [];
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

export async function POST(req) {
  try {
    const { messages, systemPrompt } = await req.json();

    if (!GROQ_KEY) {
      return NextResponse.json({ error: "GROQ_API_KEY not set in environment variables" }, { status: 500 });
    }

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

    const data = await res.json();
    if (data.error) return NextResponse.json({ error: data.error.message }, { status: 400 });

    let text = data.choices?.[0]?.message?.content || "";
    text = normalizeQuestions(text);
    text = normalizeSuggestions(text);

    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
