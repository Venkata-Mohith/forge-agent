import { NextResponse } from "next/server";

const GROQ_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const MAX_STEPS = 10;

// ── Piston API — free code execution, no key needed ──
async function executeCode(language, code) {
  try {
    // Get available runtimes first to find correct version
    const runtimesRes = await fetch("https://emkc.org/api/v2/piston/runtimes");
    const runtimes = await runtimesRes.json();
    const runtime = runtimes.find(r => 
      r.language === language || r.aliases?.includes(language)
    );
    if (!runtime) return { success: false, output: `Language "${language}" not supported` };

    const res = await fetch("https://emkc.org/api/v2/piston/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: runtime.language,
        version: runtime.version,
        files: [{ content: code }],
        stdin: "",
        args: [],
        run_timeout: 10000,
        compile_timeout: 10000,
      }),
    });
    const data = await res.json();
    const output = data.run?.output || data.compile?.output || "";
    const stderr = data.run?.stderr || data.compile?.stderr || "";
    const exitCode = data.run?.code ?? data.compile?.code ?? 1;
    return {
      success: exitCode === 0,
      output: output || "(no output)",
      error: stderr || null,
      exitCode,
    };
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
    if (results.length > 0) return results.join("\n\n");

    // HTML fallback
    const htmlRes = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; FORGE/1.0)" } }
    );
    const html = await htmlRes.text();
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([^<]{20,300})</g)]
      .slice(0, 3).map(m => m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim());
    return snippets.length > 0 ? snippets.join("\n\n") : "No results found.";
  } catch { return "Search failed."; }
}

// ── Parse FORGE's step response ──
function parseStep(text) {
  const actionMatch = text.match(/::ACTION::(THINK|SEARCH|CREATE_FILE|RUN_CODE|DONE)::/);
  if (!actionMatch) return { action: "THINK", content: text };

  const action = actionMatch[1];
  const afterAction = text.slice(text.indexOf(`::ACTION::${action}::`) + `::ACTION::${action}::`.length);

  if (action === "SEARCH") {
    const query = afterAction.match(/::QUERY::([\s\S]*?)::END::/)?.[1]?.trim();
    return { action, query };
  }
  if (action === "CREATE_FILE") {
    const filename = afterAction.match(/::FILENAME::([\s\S]*?)::END::/)?.[1]?.trim();
    const code = afterAction.match(/::CODE::([\s\S]*?)::END::/)?.[1]?.trim();
    return { action, filename, code };
  }
  if (action === "RUN_CODE") {
    const language = afterAction.match(/::LANGUAGE::([\s\S]*?)::END::/)?.[1]?.trim() || "javascript";
    const code = afterAction.match(/::CODE::([\s\S]*?)::END::/)?.[1]?.trim();
    return { action, language, code };
  }
  if (action === "DONE") {
    const summary = afterAction.match(/::SUMMARY::([\s\S]*?)::END::/)?.[1]?.trim() || "Task complete.";
    return { action, summary };
  }
  return { action: "THINK", content: text };
}

// ── Call Groq ──
async function callGroq(messages, systemPrompt) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 4096,
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content || "";
}

const AGENT_SYSTEM_PROMPT = `You are FORGE AGENT — an autonomous AI that completes tasks step by step.

For EVERY response, you MUST use exactly one of these action formats:

1. THINK (plan or reason):
::ACTION::THINK::
Your thinking here

2. SEARCH (find information):
::ACTION::SEARCH::
::QUERY::what to search for::END::

3. CREATE_FILE (write a file):
::ACTION::CREATE_FILE::
::FILENAME::filename.ext::END::
::CODE::
full file content here
::END::

4. RUN_CODE (execute and test code):
::ACTION::RUN_CODE::
::LANGUAGE::javascript::END::
::CODE::
code to run
::END::

5. DONE (task complete):
::ACTION::DONE::
::SUMMARY::what was accomplished and what files were created::END::

RULES:
- Always start with THINK to plan your approach
- Break complex tasks into small focused steps
- After CREATE_FILE, always do RUN_CODE to verify it works (when possible)
- If code fails, fix it and try again
- End with DONE only when the task is fully complete
- Be thorough — don't skip steps
- Max 10 steps total`;

export async function POST(req) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const { goal, systemContext } = await req.json();
        if (!GROQ_KEY) { send({ type: "error", message: "GROQ_API_KEY not set" }); controller.close(); return; }

        send({ type: "start", goal });

        const agentMessages = [{ role: "user", content: `Complete this task: ${goal}` }];
        const files = []; // track created files
        let stepCount = 0;

        while (stepCount < MAX_STEPS) {
          stepCount++;
          send({ type: "thinking", step: stepCount });

          const fullSystemPrompt = systemContext
            ? `${AGENT_SYSTEM_PROMPT}\n\nUSER CONTEXT:\n${systemContext}`
            : AGENT_SYSTEM_PROMPT;

          let response;
          try {
            response = await callGroq(agentMessages, fullSystemPrompt);
          } catch (err) {
            send({ type: "error", message: err.message });
            break;
          }

          agentMessages.push({ role: "assistant", content: response });
          const step = parseStep(response);

          if (step.action === "THINK") {
            send({ type: "step", action: "THINK", content: step.content || response, step: stepCount });

          } else if (step.action === "SEARCH") {
            send({ type: "step", action: "SEARCH", query: step.query, step: stepCount });
            const results = await webSearch(step.query || "");
            send({ type: "search_result", query: step.query, results });
            agentMessages.push({ role: "user", content: `Search results for "${step.query}":\n\n${results}\n\nContinue with the task.` });

          } else if (step.action === "CREATE_FILE") {
            send({ type: "step", action: "CREATE_FILE", filename: step.filename, step: stepCount });
            if (step.filename && step.code) {
              files.push({ filename: step.filename, code: step.code });
              send({ type: "file_created", filename: step.filename, code: step.code });
              agentMessages.push({ role: "user", content: `File "${step.filename}" created successfully. Continue.` });
            }

          } else if (step.action === "RUN_CODE") {
            send({ type: "step", action: "RUN_CODE", language: step.language, step: stepCount });
            const result = await executeCode(step.language || "javascript", step.code || "");
            send({ type: "code_result", success: result.success, output: result.output, error: result.error });
            const feedback = result.success
              ? `Code executed successfully. Output:\n${result.output}\n\nContinue with the task.`
              : `Code failed with error:\n${result.error || result.output}\n\nFix the error and try again.`;
            agentMessages.push({ role: "user", content: feedback });

          } else if (step.action === "DONE") {
            send({ type: "done", summary: step.summary, files });
            break;
          }

          // Safety: if last step and not done, force completion
          if (stepCount === MAX_STEPS) {
            send({ type: "done", summary: `Reached maximum steps. Files created: ${files.map(f => f.filename).join(", ") || "none"}`, files });
          }
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`));
      } finally {
        controller.close();
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