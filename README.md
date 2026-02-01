# thunderbird-model-spam-filter

Thunderbird extension that classifies emails as spam using a local AI model via [Ollama](https://ollama.com). No external services — everything runs on your machine.

## Architecture

```
Thunderbird Extension (JS)  →  Ollama API (localhost:11434)
   reads emails                  classifies spam
   moves/deletes spam            runs model locally
```

## Prerequisites

- [Ollama](https://ollama.com) running locally
- Thunderbird 128+ (Manifest V3 support)

## Setup

### 1. Pull a model

```bash
# Option A: Pre-built spam classifier (fast, 1.2GB)
ollama pull rosemarla/qwen3-classify

# Option B: General model with custom prompt (more flexible)
ollama pull qwen3:1.7b
```

### 2. Allow the extension to reach Ollama

Set the `OLLAMA_ORIGINS` environment variable before starting Ollama:

```bash
OLLAMA_ORIGINS="moz-extension://*" ollama serve
```

### 3. Install the extension

1. Open Thunderbird → Add-ons Manager
2. Gear icon → Install Add-on From File
3. Select the `extension/manifest.json` file

### 4. Configure

Extension settings (Add-ons Manager → AI Spam Filter → Options):

- **Ollama URL** — default `http://localhost:11434`
- **Model** — `rosemarla/qwen3-classify` (default) or any Ollama model
- **Model Type** — `classify` (binary 0/1 models) or `chat` (structured JSON via system prompt)
- **Spam Action** — Move to Junk (default), Move to Trash, or Delete Permanently
- **Confidence Threshold** — 0.0 to 1.0

## Usage

- **Automatic**: New incoming mail is classified automatically
- **Manual**: Click the toolbar button → "Scan Current Folder" to scan all messages in the displayed folder
