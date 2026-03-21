import { NextResponse } from "next/server";

// Tell Vercel this needs more than 10 seconds
export const maxDuration = 60;

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const MAX_STEPS = 8;

// ── Piston API — free code execution ──
async function executeCode(language, code) {
  try {
    const res = await fetch("https://emkc.org/api/v2/piston/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: language === "javascript" ? "node" : language,
        version: "*",
        files: [{ content: code }],
        run_timeout: 10000,
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
    return results.length > 0 ? results.join("\n\n") : "No results found.";
  } catch { return "Search failed."; }
}

// ── Groq call ──
async function callGroq(messages, systemPrompt) {
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
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content || "";
}

// ── Strict agent system prompt ──
const AGENT_SYSTEM = `You are an autonomous AI agent. You complete tasks step by step.

CRITICAL: Every single response MUST start with one of these EXACT tags:
[THINK], [SEARCH], [FILE], [CODE], [DONE]

FORMAT FOR EACH ACTION:

[THINK]
Your reasoning or plan here.

[SEARCH]
QUERY: what to search for

[FILE]
NAME: filename.ext
CONTENT:
the full file content goes here

[CODE]
LANG: python
RUN:
the code to execute

[DONE]
SUMMARY: describe what was completed and what files were created

STRICT RULES:
- Response MUST start with [THINK], [SEARCH], [FILE], [CODE], or [DONE]
- Do NOT write explanations outside the format
- Do NOT ask questions — just execute
- First step is always [THINK] to plan
- After creating a file with [FILE], use [CODE] to test it works
- Use [DONE] only when fully complete
- Maximum 8 steps`;

// ── Parse agent response ──
function parseAgentResponse(text) {
  const t = text.trim();

  if (t.startsWith("[THINK]")) {
    return { action: "THINK", content: t.replace("[THINK]", "").trim() };
  }
  if (t.startsWith("[SEARCH]")) {
    const queryMatch = t.match(/QUERY:\s*(.+)/);
    return { action: "SEARCH", query: queryMatch?.[1]?.trim() || "general search" };
  }
  if (t.startsWith("[FILE]")) {
    const nameMatch = t.match(/NAME:\s*(.+)/);
    const contentMatch = t.match(/CONTENT:\n([\s\S]+)/);
    return {
      action: "FILE",
      filename: nameMatch?.[1]?.trim() || "output.txt",
      code: contentMatch?.[1]?.trim() || t,
    };
  }
  if (t.startsWith("[CODE]")) {
    const langMatch = t.match(/LANG:\s*(\w+)/);
    const runMatch = t.match(/RUN:\n([\s\S]+)/);
    return {
      action: "CODE",
      language: langMatch?.[1]?.trim() || "python",
      code: runMatch?.[1]?.trim() || "",
    };
  }
  if (t.startsWith("[DONE]")) {
    const summaryMatch = t.match(/SUMMARY:\s*([\s\S]+)/);
    return { action: "DONE", summary: summaryMatch?.[1]?.trim() || "Task complete." };
  }

  // Fallback — treat as THINK
  return { action: "THINK", content: t.substring(0, 200) };
}

export async function POST(req) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
      };

      try {
        const { goal, systemContext } = await req.json();
        if (!GROQ_KEY) { send({ type: "error", message: "GROQ_API_KEY not set" }); controller.close(); return; }

        send({ type: "start", goal });

        const agentMessages = [{ role: "user", content: `Complete this task step by step: ${goal}` }];
        const files = [];
        let stepCount = 0;
        let consecutiveThinks = 0;

        while (stepCount < MAX_STEPS) {
          stepCount++;
          send({ type: "thinking", step: stepCount });

          let response;
          try {
            response = await callGroq(agentMessages, AGENT_SYSTEM);
          } catch (err) {
            send({ type: "error", message: err.message });
            break;
          }

          agentMessages.push({ role: "assistant", content: response });
          const step = parseAgentResponse(response);

          if (step.action === "THINK") {
            consecutiveThinks++;
            send({ type: "step", action: "THINK", content: step.content, step: stepCount });
            agentMessages.push({ role: "user", content: "Good. Now take the next action — create a file, run code, or finish." });
            // If stuck thinking, push it to act
            if (consecutiveThinks >= 2) {
              agentMessages.push({ role: "user", content: "Stop thinking and take action now. Create files or run code." });
            }

          } else if (step.action === "SEARCH") {
            consecutiveThinks = 0;
            send({ type: "step", action: "SEARCH", query: step.query, step: stepCount });
            const results = await webSearch(step.query);
            send({ type: "search_result", query: step.query });
            agentMessages.push({ role: "user", content: `Search results:\n${results}\n\nContinue with the task.` });

          } else if (step.action === "FILE") {
            consecutiveThinks = 0;
            send({ type: "step", action: "CREATE_FILE", filename: step.filename, step: stepCount });
            if (step.filename && step.code) {
              files.push({ filename: step.filename, code: step.code });
              send({ type: "file_created", filename: step.filename, code: step.code });
              agentMessages.push({ role: "user", content: `File "${step.filename}" created. Continue — run it to verify or create more files.` });
            }

          } else if (step.action === "CODE") {
            consecutiveThinks = 0;
            send({ type: "step", action: "RUN_CODE", language: step.language, step: stepCount });
            const result = await executeCode(step.language, step.code);
            send({ type: "code_result", success: result.success, output: result.output, error: result.error });
            const feedback = result.success
              ? `Code ran successfully. Output: ${result.output}\n\nIf task is complete use [DONE]. Otherwise continue.`
              : `Code failed: ${result.error || result.output}\n\nFix and try again.`;
            agentMessages.push({ role: "user", content: feedback });

          } else if (step.action === "DONE") {
            send({ type: "done", summary: step.summary, files });
            break;
          }

          if (stepCount === MAX_STEPS) {
            send({ type: "done", summary: `Completed ${stepCount} steps. Files: ${files.map(f => f.filename).join(", ") || "none"}`, files });
          }
        }
      } catch (err) {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`)); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}