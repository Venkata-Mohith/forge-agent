import { NextResponse } from "next/server";

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

// ── Piston code execution ──
async function executeCode(language, code) {
  try {
    const res = await fetch("https://emkc.org/api/v2/piston/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: language === "javascript" ? "node" : language,
        version: "*",
        files: [{ content: code }],
        run_timeout: 8000,
      }),
    });
    const data = await res.json();
    const output = data.run?.output || "";
    const stderr = data.run?.stderr || "";
    const exitCode = data.run?.code ?? 1;
    return { success: exitCode === 0, output: output || "(no output)", error: stderr || null };
  } catch (err) {
    return { success: false, output: "", error: err.message };
  }
}

// ── DuckDuckGo search ──
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
    return results.length > 0 ? results.join("\n\n") : "No specific results found.";
  } catch { return "Search unavailable."; }
}

// ── Parse agent response ──
function parseStep(text) {
  const t = text.trim();
  if (t.startsWith("[THINK]")) return { action: "THINK", content: t.replace("[THINK]", "").trim() };
  if (t.startsWith("[SEARCH]")) {
    const q = t.match(/QUERY:\s*(.+)/)?.[1]?.trim();
    return { action: "SEARCH", query: q || "general" };
  }
  if (t.startsWith("[FILE]")) {
    const name = t.match(/NAME:\s*(.+)/)?.[1]?.trim();
    const content = t.match(/CONTENT:\n([\s\S]+)/)?.[1]?.trim();
    return { action: "FILE", filename: name || "output.txt", code: content || "" };
  }
  if (t.startsWith("[CODE]")) {
    const lang = t.match(/LANG:\s*(\w+)/)?.[1]?.trim() || "python";
    const code = t.match(/RUN:\n([\s\S]+)/)?.[1]?.trim() || "";
    return { action: "CODE", language: lang, code };
  }
  if (t.startsWith("[DONE]")) {
    const summary = t.match(/SUMMARY:\s*([\s\S]+)/)?.[1]?.trim() || "Task complete.";
    return { action: "DONE", summary };
  }
  return { action: "THINK", content: t.substring(0, 300) };
}

const AGENT_SYSTEM = `You are an autonomous AI agent that completes tasks step by step.

EVERY response MUST start with exactly one of: [THINK], [SEARCH], [FILE], [CODE], [DONE]

[THINK]
your reasoning here

[SEARCH]
QUERY: what to search for

[FILE]
NAME: filename.ext
CONTENT:
full file content here

[CODE]
LANG: python
RUN:
code to execute

[DONE]
SUMMARY: what was accomplished

RULES:
- Always start with [THINK] to plan
- Create files with [FILE], test them with [CODE]
- Never ask questions — just execute
- End with [DONE] when complete`;

export async function POST(req) {
  try {
    const { goal, history, lastResult, systemContext } = await req.json();

    if (!GROQ_KEY) return NextResponse.json({ error: "GROQ_API_KEY not set" }, { status: 500 });

    // Build message history for this step
    const messages = history || [{ role: "user", content: `Complete this task: ${goal}` }];
    if (lastResult) {
      messages.push({ role: "user", content: lastResult });
    }

    const systemPrompt = systemContext
      ? `${AGENT_SYSTEM}\n\nUSER CONTEXT:\n${systemContext}`
      : AGENT_SYSTEM;

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        max_tokens: 2048,
        temperature: 0.3,
      }),
    });

    const data = await res.json();
    if (data.error) return NextResponse.json({ error: data.error.message }, { status: 400 });

    const responseText = data.choices?.[0]?.message?.content || "";
    const step = parseStep(responseText);

    // Execute side effects server-side
    let result = null;
    let nextUserMessage = null;

    if (step.action === "SEARCH") {
      result = await webSearch(step.query);
      nextUserMessage = `Search results for "${step.query}":\n${result}\n\nContinue with the task.`;
    }

    if (step.action === "CODE" && step.code) {
      result = await executeCode(step.language, step.code);
      nextUserMessage = result.success
        ? `Code ran OK. Output: ${result.output}\n\nIf task is done use [DONE]. Otherwise continue.`
        : `Code failed: ${result.error || result.output}\n\nFix it and try again.`;
    }

    if (step.action === "FILE") {
      nextUserMessage = `File "${step.filename}" created. Now test it with [CODE] or continue.`;
    }

    if (step.action === "THINK") {
      nextUserMessage = "Good. Now take action — create a file, run code, or finish with [DONE].";
    }

    // Return step result + updated history for next call
    const updatedHistory = [
      ...messages,
      { role: "assistant", content: responseText },
    ];

    return NextResponse.json({
      step,
      result,
      nextUserMessage,
      history: updatedHistory,
      raw: responseText,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}