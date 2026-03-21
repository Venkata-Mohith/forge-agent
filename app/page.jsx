"use client";
import { useState, useRef, useEffect, useCallback } from "react";

// ─── STORAGE ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = "forge_v5";
function save(data) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {} }
function load() { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } }
function clearStorage() { try { localStorage.removeItem(STORAGE_KEY); } catch {} }

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(ctx, memory) {
  const memBlock = memory?.summary ? `
═══════════════════════════════════
LONG-TERM MEMORY
═══════════════════════════════════
From previous sessions — use naturally, don't recite:
${memory.summary}
${memory.projects?.length ? `Projects: ${memory.projects.join(", ")}` : ""}
${memory.visitCount > 1 ? `Visit #${memory.visitCount} — returning user. Brief warm acknowledgment.` : ""}
` : "";

  const ctxBlock = ctx ? `
═══════════════════════════════════
USER CONTEXT
═══════════════════════════════════
Name: ${ctx.name || "not given"} | Level: ${ctx.level} | Goal: ${ctx.goal} | Stack: ${ctx.stack || "ask when needed"}
Beginner→plain English | Intermediate→balanced | Advanced→technical | Expert→full depth
${ctx.name ? "Use their name occasionally." : ""}
` : "";

  const fbBlock = memory?.feedbackPatterns?.length ? `
═══════════════════════════════════
FEEDBACK FROM THIS USER — CRITICAL
═══════════════════════════════════
Learn from this. Never repeat:
${memory.feedbackPatterns.map((f, i) => `${i + 1}. "${f.issue}" (about: ${f.context})`).join("\n")}
` : "";

  return `You are FORGE — a witty, slightly sarcastic genius who builds things that actually work. Not a chatbot. The smartest developer friend anyone has ever had.
${ctxBlock}${memBlock}${fbBlock}
═══════════════════════════════════
WHO YOU ARE
═══════════════════════════════════
- Opinions. Share them directly. Witty, slightly sarcastic — never mean.
- Keep it real — bad idea? Say so, then help do it better.
- Match energy. Never a yes-machine.

═══════════════════════════════════
FORGE CODE — NEVER BREAK
═══════════════════════════════════
1. NEVER explain what nobody asked for
2. NEVER dump code without explaining the thinking
3. NEVER be overly agreeable — push back
4. NEVER hallucinate — honesty beats confidence
5. NEVER make the user feel stupid
6. ALWAYS ask 3-5 clarifying questions when vague
7. ALWAYS challenge before building

═══════════════════════════════════
CLARIFYING QUESTIONS — EXACT FORMAT. ALWAYS USE THIS.
═══════════════════════════════════
When you need to ask clarifying questions, use EXACTLY this format:

::QUESTIONS::
Q: Your first question here?
O: Option A | Option B | Option C
Q: Your second question here?
O: Option A | Option B
Q: Your third question here?
O: Yes | No | Not sure
::END::

RULES:
- Always start with ::QUESTIONS:: and end with ::END::
- Every Q: line is a question
- Every O: line has options separated by | (pipe character)
- If a question needs a typed answer, write O: (leave empty after colon)
- 3-5 questions max
- NEVER use JSON. NEVER use bullet points. Always use this Q:/O: format.

═══════════════════════════════════
PROMPT REFINEMENT
═══════════════════════════════════
Score clarity 1-10. Below 7 → ask questions. 7+ → silently rewrite to sharpest version, process THAT. Never reveal the rewrite.

═══════════════════════════════════
PROACTIVE INTELLIGENCE
═══════════════════════════════════
After every answer scan for unseen problems, edge cases, better approaches.
If relevant → "⚡ FORGE NOTICED:" + 1-3 lines max.

═══════════════════════════════════
CODE PROTOCOL — ALL 5 STEPS. NO EXCEPTIONS.
═══════════════════════════════════
⚠️ STEP 1 — STACK CHECK: Use <questions> block. NEVER assume. ALWAYS ask first.
⚠️ STEP 2 — RECOMMENDATION: Better option? Say why. Respect their choice.
⚠️ STEP 3 — BLUEPRINT: File tree + descriptions + connections + deps. Before any code.
⚠️ STEP 4 — BUILD: Complete code. Every file. No placeholders.
⚠️ STEP 5 — DEBRIEF: What you built + decisions + watch out for + next step.
SKIP STEP 1 = FAILURE.

═══════════════════════════════════
SMART FOLLOW-UPS
═══════════════════════════════════
After EVERY response (except when asking questions):
<suggestions>
["specific suggestion 1", "specific suggestion 2", "specific suggestion 3"]
</suggestions>

═══════════════════════════════════
DEVIL'S ADVOCATE
═══════════════════════════════════
Before anything significant: "This will work — but [observation]. Proceed or adjust?"
They say proceed → build immediately, no more debate.

═══════════════════════════════════
HOW YOU TALK
═══════════════════════════════════
Short sharp sentences. Depth matches skill level. End with momentum.
Markdown: **bold** \`inline\` \`\`\`lang code blocks

Not a search engine. Not a yes-machine. Not a lecturer. Not a robot.`;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const codeRegistry = new Map();
let codeIdCounter = 0;

function extractBlock(text, tag) {
  if (!text) return null;
  // Try proper tags first
  const m = text.match(new RegExp(`<${tag}>([\s\S]*?)<\/${tag}>`));
  if (m) { try { return JSON.parse(m[1].trim()); } catch {} }

  // Fallback: Llama sometimes outputs raw JSON without tags
  // Look for a JSON array of objects with "q" keys after a short intro line
  if (tag === "questions") {
    const arrayMatch = text.match(/\[\s*\{[\s\S]*?"q"[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed) && parsed[0]?.q) return parsed;
      } catch {}
    }
  }
  if (tag === "suggestions") {
    const arrayMatch = text.match(/\[\s*"[^"]+"/);
    if (arrayMatch) {
      const fullMatch = text.match(/\[[^\[\]]*"[^"]*"[^\[\]]*\]/);
      if (fullMatch) { try { return JSON.parse(fullMatch[0]); } catch {} }
    }
  }
  return null;
}
function stripBlocks(text) {
  if (!text) return "";
  return text
    .replace(/<questions>[\s\S]*?<\/questions>/g, "")
    .replace(/<suggestions>[\s\S]*?<\/suggestions>/g, "")
    .replace(/::QUESTIONS::[\s\S]*?::END::/g, "")
    .replace(/\[[\s\S]*?"q"\s*:[\s\S]*?\]/g, "")
    .replace(/\[\s*"[^"\[\]]+"(?:\s*,\s*"[^"\[\]]+")*\s*\]/g, "")
    .replace(/^\s*[\[\]]\s*$/gm, "")
    .replace(/\[\s*$/gm, "")
    .trim() || "";
}

function parseMarkdown(text) {
  return text
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
      const id = `c${++codeIdCounter}`;
      codeRegistry.set(id, { code: code.trimEnd(), lang: lang || "txt" });
      const escaped = code.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const isHtml = lang === "html" || lang === "HTML";
      return `<div class="code-wrap">
        <div class="code-header">
          <span class="code-lang">${lang || "code"}</span>
          <div class="code-btns">
            ${isHtml ? `<button class="cb preview-cb" data-id="${id}">▶ Preview</button>` : ""}
            <button class="cb download-cb" data-id="${id}">⬇ Save</button>
            <button class="cb copy-cb" data-id="${id}">⎘ Copy</button>
          </div>
        </div>
        <pre class="code-block"><code>${escaped}</code></pre>
      </div>`;
    })
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^[-•] (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`)
    .replace(/⚡ FORGE NOTICED:([\s\S]*?)(?=\n\n|$)/g, '<div class="forge-noticed">⚡ FORGE NOTICED:$1</div>')
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br/>");
}

function timeAgo(ts) {
  if (!ts) return "";
  const d = Math.floor((Date.now() - ts) / 86400000);
  const h = Math.floor((Date.now() - ts) / 3600000);
  const m = Math.floor((Date.now() - ts) / 60000);
  return d > 0 ? `${d}d ago` : h > 0 ? `${h}h ago` : m > 0 ? `${m}m ago` : "just now";
}

// ─── FORGE MASCOT ─────────────────────────────────────────────────────────────
function ForgeMascot() {
  return (
    <div className="forge-thinking-wrap">
      <div className="mascot-scene">
        <svg width="80" height="72" viewBox="0 0 80 72" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges">
          <defs>
            <radialGradient id="mg" cx="50%" cy="100%" r="60%">
              <stop offset="0%" stopColor="#ff6a00" stopOpacity="0.5"/>
              <stop offset="100%" stopColor="#ff6a00" stopOpacity="0"/>
            </radialGradient>
          </defs>
          <ellipse cx="32" cy="68" rx="28" ry="6" fill="url(#mg)" className="pg-glow"/>
          <rect x="18" y="50" width="28" height="6" fill="#3a3a3a"/>
          <rect x="14" y="42" width="36" height="10" fill="#4a4a4a"/>
          <rect x="6" y="42" width="10" height="6" fill="#444"/>
          <rect x="14" y="42" width="36" height="2" fill="#606060"/>
          <rect x="19" y="38" width="20" height="5" fill="#FF8C00" className="pg-metal"/>
          <rect x="19" y="38" width="20" height="2" fill="#FFD740" className="pg-metal"/>
          <rect x="28" y="40" width="6" height="7" fill="#CC4400" className="pg-leg-l"/>
          <rect x="38" y="40" width="6" height="7" fill="#CC4400" className="pg-leg-r"/>
          <rect x="26" y="45" width="8" height="3" fill="#AA3300" className="pg-leg-l"/>
          <rect x="38" y="45" width="8" height="3" fill="#AA3300" className="pg-leg-r"/>
          <rect x="26" y="26" width="20" height="16" fill="#FF5500"/>
          <rect x="26" y="26" width="4" height="16" fill="#CC4400"/>
          <rect x="26" y="26" width="20" height="3" fill="#FF7733"/>
          <rect x="30" y="32" width="12" height="6" fill="#FF7733"/>
          <g className="pg-arm">
            <rect x="14" y="24" width="14" height="5" fill="#FF5500"/>
            <rect x="14" y="24" width="14" height="2" fill="#FF7733"/>
            <rect x="10" y="22" width="6" height="6" fill="#CC4400"/>
            <rect x="2" y="14" width="4" height="14" fill="#8B4513"/>
            <rect x="2" y="14" width="2" height="14" fill="#A0522D"/>
            <rect x="-2" y="8" width="12" height="8" fill="#BBBBBB"/>
            <rect x="-2" y="8" width="12" height="3" fill="#DDDDDD"/>
            <rect x="-2" y="14" width="12" height="2" fill="#999"/>
          </g>
          <rect x="46" y="28" width="10" height="5" fill="#FF5500"/>
          <rect x="54" y="26" width="6" height="6" fill="#CC4400"/>
          <rect x="28" y="10" width="16" height="16" fill="#FF5500"/>
          <rect x="28" y="10" width="16" height="3" fill="#FF7733"/>
          <rect x="30" y="15" width="4" height="4" fill="#111"/>
          <rect x="38" y="15" width="4" height="4" fill="#111"/>
          <rect x="31" y="15" width="2" height="2" fill="#fff"/>
          <rect x="39" y="15" width="2" height="2" fill="#fff"/>
          <rect x="30" y="21" width="12" height="2" fill="#111"/>
          <rect x="30" y="23" width="2" height="2" fill="#111"/>
          <rect x="40" y="23" width="2" height="2" fill="#111"/>
          <rect x="26" y="8" width="20" height="4" fill="#FF8C00"/>
          <rect x="24" y="11" width="24" height="2" fill="#FF8C00"/>
          <rect x="26" y="8" width="20" height="2" fill="#FFAA00"/>
          <g className="pg-sparks">
            <rect x="20" y="37" width="2" height="2" fill="#FFD740" className="sp s1"/>
            <rect x="40" y="36" width="2" height="2" fill="#FF9800" className="sp s2"/>
            <rect x="30" y="34" width="3" height="3" fill="#FFEB3B" className="sp s3"/>
            <rect x="16" y="35" width="2" height="2" fill="#FF6D00" className="sp s4"/>
            <rect x="44" y="38" width="2" height="2" fill="#FFD740" className="sp s5"/>
            <rect x="35" y="32" width="2" height="2" fill="#FFF176" className="sp s6"/>
          </g>
          <rect x="16" y="43" width="30" height="2" fill="none" stroke="#ff9800" strokeWidth="1" className="pg-impact" rx="1"/>
        </svg>
        <div className="mascot-txt">forging...</div>
      </div>
    </div>
  );
}

// ─── ONBOARDING ───────────────────────────────────────────────────────────────
function Onboarding({ onComplete }) {
  const [step, setStep] = useState(0);
  const [ctx, setCtx] = useState({ name: "", level: "", goal: "", stack: "" });
  const [inputVal, setInputVal] = useState("");
  const steps = [
    { key: "name", question: "What should FORGE call you?", sub: "Optional. Skip for anonymity.", type: "text", placeholder: "Your name...", skipLabel: "Stay anonymous" },
    { key: "level", question: "How deep does your technical knowledge go?", sub: "Be honest — FORGE adapts.", type: "options",
      options: [{ label: "Beginner", sub: "Still learning" }, { label: "Intermediate", sub: "Built a few things" }, { label: "Advanced", sub: "Comfortable with complex projects" }, { label: "Expert", sub: "Could hack NASA if motivated" }] },
    { key: "goal", question: "What are you mainly here to do?", sub: "FORGE will prioritize.", type: "options",
      options: [{ label: "Build & Code" }, { label: "Learn & Understand" }, { label: "Plan & Architect" }, { label: "All of the above" }] },
    { key: "stack", question: "Preferred stack?", sub: "Default unless something better fits.", type: "options",
      options: [{ label: "React / Next.js" }, { label: "HTML / CSS / JS" }, { label: "Python" }, { label: "No preference" }], skipLabel: "I'll specify per project" },
  ];
  const cur = steps[step];
  const proceed = (val) => {
    const upd = { ...ctx, [cur.key]: val };
    setCtx(upd); setInputVal("");
    step === steps.length - 1 ? onComplete(upd) : setStep(s => s + 1);
  };
  return (
    <div className="onboard-wrap">
      <div className="onboard-card">
        <div className="onboard-logo">
          <div className="forge-logo-big">F</div>
          <div><div className="onboard-title">FORGE</div><div className="onboard-tagline">Let&apos;s set you up right.</div></div>
        </div>
        <div className="onboard-progress">{steps.map((_, i) => <div key={i} className={`pdot ${i === step ? "active" : i < step ? "done" : ""}`} />)}</div>
        <div className="onboard-q">{cur.question}</div>
        <div className="onboard-sub">{cur.sub}</div>
        {cur.type === "text" ? (
          <div className="onboard-text-wrap">
            <input className="onboard-input" type="text" placeholder={cur.placeholder} value={inputVal}
              onChange={e => setInputVal(e.target.value)} onKeyDown={e => { if (e.key === "Enter") proceed(inputVal.trim()); }} autoFocus />
            <button className="onboard-btn" onClick={() => proceed(inputVal.trim())}>Continue →</button>
            {cur.skipLabel && <button className="onboard-skip" onClick={() => proceed("")}>{cur.skipLabel}</button>}
          </div>
        ) : (
          <div className="onboard-options">
            {cur.options.map(o => (
              <button key={o.label} className="onboard-opt" onClick={() => proceed(o.label)}>
                <span className="opt-label">{o.label}</span>{o.sub && <span className="opt-sub">{o.sub}</span>}
              </button>
            ))}
            {cur.skipLabel && <button className="onboard-skip" onClick={() => proceed("")}>{cur.skipLabel}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MEMORY PANEL ─────────────────────────────────────────────────────────────
function MemoryPanel({ memory, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="mem-panel" onClick={e => e.stopPropagation()}>
        <div className="mem-header"><span>🧠 FORGE REMEMBERS</span><button className="mem-close" onClick={onClose}>×</button></div>
        <div className="mem-body">
          {memory?.summary ? (<>
            <div className="mem-section"><div className="mem-label">FROM PREVIOUS SESSIONS</div><div className="mem-text">{memory.summary}</div></div>
            {memory.projects?.length > 0 && <div className="mem-section"><div className="mem-label">PROJECTS</div><div className="mem-tags">{memory.projects.map(p => <span key={p} className="mem-tag">{p}</span>)}</div></div>}
            <div className="mem-section"><div className="mem-label">STATS</div><div className="mem-stats">
              <div className="mem-stat"><span>{memory.visitCount || 1}</span>visits</div>
              <div className="mem-stat"><span>{memory.totalMessages || 0}</span>messages</div>
              <div className="mem-stat"><span>{timeAgo(memory.lastVisit)}</span>last visit</div>
            </div></div>
          </>) : <div className="mem-empty">No memories yet. FORGE remembers after ~8 messages.</div>}
          <div className="mem-note">Auto-updates every 8 messages.</div>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function ForgeAgent() {
  const [ready, setReady] = useState(false);
  const [userCtx, setUserCtx] = useState(null);
  const [messages, setMessages] = useState(null);
  const [memory, setMemory] = useState(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [dots, setDots] = useState("");
  const [answers, setAnswers] = useState({});
  const [showMemory, setShowMemory] = useState(false);
  const [msgCount, setMsgCount] = useState(0);
  const [feedback, setFeedback] = useState({});
  const [feedbackPrompt, setFeedbackPrompt] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [previewCode, setPreviewCode] = useState(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const messagesRef = useRef(null);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = load();
    if (stored?.ctx) {
      setUserCtx(stored.ctx);
      setMessages(stored.messages || null);
      setMemory(stored.memory || null);
      setMsgCount(stored.messages?.filter(m => m.role === "user").length || 0);
    }
    setReady(true);
  }, []);

  const lastAssistant = messages ? [...messages].reverse().find(m => m.role === "assistant") : null;
  const activeQuestions = lastAssistant ? extractBlock(lastAssistant.content, "questions") : null;
  const activeSuggestions = lastAssistant && !activeQuestions ? extractBlock(lastAssistant.content, "suggestions") : null;

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);
  useEffect(() => {
    if (!loading) return;
    const iv = setInterval(() => setDots(d => d.length >= 3 ? "" : d + "."), 400);
    return () => clearInterval(iv);
  }, [loading]);
  useEffect(() => {
    if (activeQuestions) { const i = {}; activeQuestions.forEach((_, idx) => { i[idx] = ""; }); setAnswers(i); }
  }, [lastAssistant?.id]);

  // Code block button delegation
  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    const handler = (e) => {
      const btn = e.target.closest("[data-id]");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const entry = codeRegistry.get(id);
      if (!entry) return;
      if (btn.classList.contains("copy-cb")) {
        navigator.clipboard.writeText(entry.code).then(() => {
          setCopiedId(id);
          setTimeout(() => setCopiedId(null), 2000);
        });
      }
      if (btn.classList.contains("download-cb")) {
        const extMap = { js: "js", jsx: "jsx", ts: "ts", tsx: "tsx", py: "py", html: "html", css: "css", json: "json", md: "md" };
        const ext = extMap[entry.lang] || "txt";
        const blob = new Blob([entry.code], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = `forge-output.${ext}`; a.click();
        URL.revokeObjectURL(url);
      }
      if (btn.classList.contains("preview-cb")) setPreviewCode(entry.code);
    };
    container.addEventListener("click", handler);
    return () => container.removeEventListener("click", handler);
  }, [messages]);

  useEffect(() => {
    if (!copiedId) return;
    const btn = document.querySelector(`.copy-cb[data-id="${copiedId}"]`);
    if (btn) { btn.textContent = "✓ Copied"; btn.style.color = "#00ff88"; }
    return () => {
      const b = document.querySelector(`.copy-cb[data-id="${copiedId}"]`);
      if (b) { b.textContent = "⎘ Copy"; b.style.color = ""; }
    };
  }, [copiedId]);

  const maybeUpdateMemory = useCallback(async (msgs, mem, count) => {
    if (count > 0 && count % 8 === 0) {
      try {
        const res = await fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: msgs, existingSummary: mem?.summary }),
        });
        const result = await res.json();
        if (result.summary) {
          return {
            ...mem,
            summary: result.summary,
            projects: [...new Set([...(mem?.projects || []), ...(result.projects || [])])],
            lastVisit: Date.now(),
            totalMessages: count,
          };
        }
      } catch {}
    }
    return mem;
  }, []);

  const onboardComplete = (ctx) => {
    const isReturn = !!(memory?.visitCount > 0 && memory?.summary);
    let greeting;
    if (isReturn && memory?.summary) {
      const n = ctx.name ? `Welcome back, ${ctx.name}.` : "Welcome back.";
      const proj = memory.projects?.length ? ` Last time we tackled ${memory.projects[memory.projects.length - 1]}.` : "";
      greeting = `${n} FORGE remembers.${proj}\n\nPick up where we left off or start something new.`;
    } else {
      greeting = ctx.name
        ? `Hey ${ctx.name}. FORGE is ready.\n\n**${ctx.level}** level, **${ctx.goal}**${ctx.stack && ctx.stack !== "No preference" ? `, prefer **${ctx.stack}**` : ""}.\n\nWhat are we building?`
        : `FORGE is ready. **${ctx.level}** · **${ctx.goal}**.\n\nWhat are we building?`;
    }
    const welcome = { role: "assistant", content: greeting, id: "welcome" };
    const msgs = [welcome];
    const mem = { ...(memory || {}), visitCount: (memory?.visitCount || 0) + 1, lastVisit: Date.now(), totalMessages: memory?.totalMessages || 0 };
    setUserCtx(ctx); setMessages(msgs); setMemory(mem);
    save({ ctx, messages: msgs, memory: mem });
  };

  const autoResize = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  };

  const sendMessage = async (overrideContent) => {
    const trimmed = (overrideContent || input).trim();
    if (!trimmed || loading) return;
    const userMsg = { role: "user", content: trimmed, id: Date.now() };
    const newMessages = [...messages, userMsg];
    const newCount = msgCount + 1;
    setMessages(newMessages); setMsgCount(newCount);
    setInput(""); setAnswers({}); setFeedbackPrompt(null);
    setLoading(true);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    const historyMessages = newMessages.map(m => ({ role: m.role, content: m.content }));

    try {
      // Call our Next.js API route — runs server-side, no CORS issues
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: historyMessages,
          systemPrompt: buildSystemPrompt(userCtx, memory),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const reply = data.text || "Something went wrong. Try again.";
      setMessages(prev => {
        const updated = [...prev, { role: "assistant", content: reply, id: Date.now() }];
        save({ ctx: userCtx, messages: updated, memory });
        return updated;
      });

      const updMem = await maybeUpdateMemory(newMessages, memory, newCount);
      if (updMem !== memory) {
        setMemory(updMem);
        save({ ctx: userCtx, messages: newMessages, memory: updMem });
      }
    } catch (e) {
      setMessages(prev => {
        const updated = [...prev, { role: "assistant", content: `Error: ${e.message}. Check your API key in .env.local.`, id: Date.now() }];
        save({ ctx: userCtx, messages: updated, memory });
        return updated;
      });
    } finally {
      setLoading(false);
    }
  };

  const submitAnswers = () => {
    if (!activeQuestions) return;
    sendMessage(activeQuestions.map((q, i) => `${i + 1}. ${q.q}\n→ ${(answers[i] || "").trim() || "(skipped)"}`).join("\n\n"));
  };
  const allAnswered = activeQuestions ? activeQuestions.every((_, i) => (answers[i] || "").trim().length > 0) : false;
  const handleKey = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  const clearAll = () => { clearStorage(); setMessages(null); setUserCtx(null); setMemory(null); setMsgCount(0); setAnswers({}); setFeedback({}); };

  if (!ready) return null;
  if (!userCtx || !messages) return <Onboarding onComplete={onboardComplete} />;

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <div className="forge-logo">F</div>
        <div style={{ minWidth: 0 }}>
          <div className="forge-title">FORGE</div>
          <div className="forge-subtitle">{userCtx.name ? `${userCtx.name} · ` : ""}{userCtx.level} · {userCtx.goal}</div>
        </div>
        <div className="header-right">
          <button className={`mem-btn ${memory?.summary ? "has-memory" : ""}`} onClick={() => setShowMemory(true)}>
            🧠{memory?.summary && <span className="mem-dot" />}
          </button>
          {msgCount > 0 && <span className="msg-counter">{msgCount} msg{msgCount !== 1 ? "s" : ""}</span>}
          {messages.length > 1 && <button className="clear-btn" onClick={clearAll}>RESET</button>}
          <div className="status-dot" />
        </div>
      </div>

      {/* Messages */}
      <div className="messages" ref={messagesRef}>
        {messages.map((msg) => {
          const isA = msg.role === "assistant";
          const display = isA ? stripBlocks(msg.content) : msg.content;
          if (isA && !display) return null;
          return (
            <div key={msg.id} className={`msg-row ${msg.role}`}>
              <div className={`avatar ${isA ? "forge" : "user"}`}>
                {isA ? "F" : (userCtx.name ? userCtx.name[0].toUpperCase() : "U")}
              </div>
              <div className="bubble-wrap">
                <div className={`bubble ${isA ? "forge" : "user"}`}>
                  {isA ? <div dangerouslySetInnerHTML={{ __html: parseMarkdown(display) }} /> : msg.content}
                </div>
                {isA && msg.id !== "welcome" && (
                  <div className="feedback-row">
                    <button className={`fb-btn ${feedback[msg.id] === "up" ? "active-up" : ""}`}
                      onClick={() => { setFeedback(p => ({ ...p, [msg.id]: "up" })); setFeedbackPrompt(null); }}>👍</button>
                    <button className={`fb-btn ${feedback[msg.id] === "down" ? "active-down" : ""}`}
                      onClick={() => { setFeedback(p => ({ ...p, [msg.id]: "down" })); setFeedbackPrompt({ msgId: msg.id, context: display.substring(0, 80) }); }}>👎</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {loading && (
          <>
            <ForgeMascot />
            <div className="msg-row">
              <div className="avatar forge">F</div>
              <div className="thinking">
                <div className="thinking-dot" /><div className="thinking-dot" /><div className="thinking-dot" />
                <span>FORGE is thinking{dots}</span>
              </div>
            </div>
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Suggestions */}
      {activeSuggestions && !loading && (
        <div className="suggestions-bar">
          {activeSuggestions.map((s, i) => (
            <button key={i} className="suggestion-chip" onClick={() => sendMessage(s)}>{s}</button>
          ))}
        </div>
      )}

      {/* Feedback prompt */}
      {feedbackPrompt && (
        <div className="fb-panel">
          <div className="fb-panel-title">What went wrong? <span onClick={() => setFeedbackPrompt(null)} className="fb-dismiss">✕</span></div>
          <div className="fb-options">
            {["Skipped a step", "Wrong answer", "Bad code", "Too long", "Wrong tone", "Missed the point"].map(issue => (
              <button key={issue} className="fb-issue" onClick={() => {
                const pattern = { issue, context: feedbackPrompt.context, ts: Date.now() };
                const updated = { ...memory, feedbackPatterns: [...(memory?.feedbackPatterns || []).slice(-9), pattern] };
                setMemory(updated);
                save({ ctx: userCtx, messages, memory: updated });
                setFeedbackPrompt(null);
              }}>{issue}</button>
            ))}
          </div>
        </div>
      )}

      {/* Question panel */}
      {activeQuestions && !loading && (
        <div className="q-panel">
          <div className="q-panel-inner">
            <div className="q-header"><span>FORGE needs to know</span><div className="q-header-line" /></div>
            {activeQuestions.map((q, i) => (
              <div className="q-item" key={i}>
                <div className="q-label"><span className="q-num">{i + 1}.</span>{q.q}</div>
                {q.options?.length > 0 ? (
                  <div className="q-options">{q.options.map(o => <button key={o} className={`q-opt ${answers[i] === o ? "sel" : ""}`} onClick={() => setAnswers(p => ({ ...p, [i]: o }))}>{o}</button>)}</div>
                ) : (
                  <input className="q-text" type="text" placeholder="Type your answer..." value={answers[i] || ""}
                    onChange={e => setAnswers(p => ({ ...p, [i]: e.target.value }))}
                    onKeyDown={e => { if (e.key === "Enter" && allAnswered) submitAnswers(); }} />
                )}
              </div>
            ))}
            <div className="q-footer">
              <span className="q-progress"><span>{Object.values(answers).filter(v => v.trim()).length}</span>/{activeQuestions.length} answered</span>
              <button className="q-submit" disabled={!allAnswered} onClick={submitAnswers}>SEND TO FORGE →</button>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="input-area">
        <div className="input-wrap">
          <textarea ref={textareaRef} value={input}
            onChange={e => { setInput(e.target.value); autoResize(); }}
            onKeyDown={handleKey}
            placeholder={activeQuestions ? "Or type a free-form reply..." : "Tell FORGE what you need..."}
            rows={1} disabled={loading} />
          <button className="send-btn" onClick={() => sendMessage()} disabled={loading || !input.trim()}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div className="input-hint">SHIFT+ENTER new line · ENTER send</div>
      </div>

      {/* Preview modal */}
      {previewCode && (
        <div className="overlay" onClick={() => setPreviewCode(null)}>
          <div style={{ background: "#0f0f0f", border: "1px solid #1e1e1e", borderRadius: 16, width: "100%", maxWidth: 900, height: "80vh", display: "flex", flexDirection: "column", overflow: "hidden" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "12px 18px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, fontWeight: 700, color: "#00ff88", letterSpacing: 2 }}>
              <span>▶ LIVE PREVIEW</span>
              <button className="mem-close" onClick={() => setPreviewCode(null)}>×</button>
            </div>
            <iframe srcDoc={previewCode} sandbox="allow-scripts" style={{ flex: 1, border: "none", background: "#fff", borderRadius: "0 0 16px 16px" }} title="preview" />
          </div>
        </div>
      )}

      {showMemory && <MemoryPanel memory={memory} onClose={() => setShowMemory(false)} />}
    </div>
  );
}
