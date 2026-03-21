# FORGE — AI Agent Built Different

A witty AI agent with persistent memory, feedback learning, and smart question panels. Built with Next.js + Groq (free forever).

---

## 🚀 Deploy to Vercel in 5 minutes

### Step 1 — Get your free Groq API key
1. Go to [console.groq.com](https://console.groq.com)
2. Sign up free (no credit card)
3. Click **API Keys** → **Create API Key**
4. Copy the key

### Step 2 — Push to GitHub
```bash
git init
git add .
git commit -m "FORGE v1"
```
Create a new repo at github.com, then:
```bash
git remote add origin https://github.com/YOUR_USERNAME/forge-agent.git
git push -u origin main
```

### Step 3 — Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repo
3. Under **Environment Variables**, add:
   - Key: `GROQ_API_KEY`
   - Value: your Groq API key
4. Click **Deploy**

Done. Live URL in under 2 minutes.

---

## 🖥 Run locally with Ollama (no API key needed)

```bash
# Install Ollama from ollama.com, then:
ollama pull llama3.2
ollama serve
```

Then in `app/api/chat/route.js` and `app/api/memory/route.js`, 
swap the URL to `http://localhost:11434/v1/chat/completions`
and remove the Authorization header.

---

## ✨ Features
- 4-step onboarding that adapts FORGE to you
- Persistent memory across sessions (localStorage)
- Feedback learning — 👍👎 makes FORGE smarter
- Smart question panels with clickable options
- Code blocks with copy/download/preview
- Forging mascot animation
- Works with Groq (cloud, free) or Ollama (local, free)
