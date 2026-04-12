import { NextResponse } from "next/server";

export const maxDuration = 120;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.1-8b-instant";
const MAX_STEPS = 6;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const AGENT_SYSTEM = `You are FORGE, an autonomous coding agent. Complete tasks by taking action immediately.

Your FIRST response MUST be [FILE] — create the file right away. Do NOT start with [THINK].

[FILE]
NAME: filename.ext
CONTENT:
complete file content here

After creating a file, test it:
[CODE]
LANG: python
RUN:
code to test

Then finish:
[DONE]
SUMMARY: what was built

RULES:
- Start with [FILE] immediately — no thinking first
- Write complete, working code — no placeholders
- After file is created, run it with [CODE]
- End with [DONE]`;

async function callGroq(messages, systemPrompt) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 800,
      temperature: 0.3,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content || "";
}

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
    return { output: output.slice(0, 1000), error: stderr.slice(0, 500), success: !stderr };
  } catch (err) {
    return { output: "", error: err.message, success: false };
  }
}

function parseStep(text) {
  const tag = text.match(/^\[(THINK|FILE|CODE|DONE)\]/m);
  if (!tag) return { type: "THINK", content: text };

  const type = tag[1];
  const content = text.slice(text.indexOf(tag[0]) + tag[0].length).trim();

  if (type === "FILE") {
    const nameMatch = content.match(/NAME:\s*(.+)/);
    const contentMatch = content.match(/CONTENT:\s*([\s\S]+)/);
    const rawContent = contentMatch ? contentMatch[1].trim() : content;
    const cleanContent = rawContent.replace(/^```[\w]*\n?/, '').replace(/```$/, '').trim();
    return {
      type: "FILE",
      filename: nameMatch ? nameMatch[1].trim() : "output.txt",
      content: cleanContent,
    };
  }

  if (type === "CODE") {
    const langMatch = content.match(/LANG:\s*(\w+)/);
    const codeMatch = content.match(/RUN:\s*([\s\S]+)/);
    const rawCode = codeMatch ? codeMatch[1].trim() : content;
    const cleanCode = rawCode.replace(/^```[\w]*\n?/, '').replace(/```$/, '').trim();
    return {
      type: "CODE",
      language: langMatch ? langMatch[1].trim() : "python",
      code: cleanCode,
    };
  }

  if (type === "DONE") {
    const summaryMatch = content.match(/SUMMARY:\s*([\s\S]+)/);
    return {
      type: "DONE",
      summary: summaryMatch ? summaryMatch[1].trim() : content,
    };
  }

  return { type: "THINK", content };
}

export async function POST(req) {
  try {
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return NextResponse.json({ error: "GROQ_API_KEY not set" }, { status: 500 });

    const { goal, history = [] } = await req.json();

    const messages = [
      { role: "user", content: `Complete this task: ${goal}` },
      ...history,
    ];

    const steps = [];
    const files = {};
    let isDone = false;

    for (let i = 0; i < MAX_STEPS; i++) {
      const response = await callGroq(messages, AGENT_SYSTEM);
      const step = parseStep(response);

      messages.push({ role: "assistant", content: response });

      if (step.type === "THINK") {
        steps.push({ type: "think", content: step.content });
      }

      else if (step.type === "FILE") {
        files[step.filename] = step.content;
        steps.push({
          type: "file",
          filename: step.filename,
          content: step.content,
        });
        messages.push({
          role: "user",
          content: `File ${step.filename} created. Now test it or continue.`,
        });
      }

      else if (step.type === "CODE") {
        steps.push({ type: "code", language: step.language, code: step.code });
        const result = await executeCode(step.language, step.code);
        steps.push({
          type: "result",
          output: result.output,
          error: result.error,
          success: result.success,
        });
        messages.push({
          role: "user",
          content: result.success
            ? `Code ran successfully. Output:\n${result.output}\n\nContinue or finish with [DONE].`
            : `Code failed. Error:\n${result.error}\n\nFix the error and try again.`,
        });
      }

      else if (step.type === "DONE") {
        steps.push({ type: "done", summary: step.summary });
        isDone = true;
        break;
      }

      if (!isDone) await sleep(15000);
    }

    return NextResponse.json({
      steps,
      files,
      done: isDone,
      summary: isDone ? steps.find(s => s.type === "done")?.summary : "Reached max steps",
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}