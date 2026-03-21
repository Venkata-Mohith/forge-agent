import { NextResponse } from "next/server";

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export async function POST(req) {
  try {
    const { messages, existingSummary } = await req.json();

    const recent = messages
      .slice(-20)
      .map((m) => `${m.role.toUpperCase()}: ${String(m.content).substring(0, 300)}`)
      .join("\n\n");

    const prompt =
      (existingSummary
        ? `Previous memory:\n${existingSummary}\n\nNew conversation:\n${recent}\n\nUpdate the memory.`
        : `Conversation:\n${recent}\n\nGenerate memory summary.`) +
      '\n\nRespond ONLY with valid JSON: {"summary": "2-4 sentences", "projects": ["names"]}';

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "You are a memory summarizer. Respond with valid JSON only. No markdown." },
          { role: "user", content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.3,
      }),
    });

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || "";
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ summary: "", projects: [] });
  }
}
