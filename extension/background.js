const DEFAULT_SETTINGS = {
  ollamaUrl: "http://localhost:11434",
  model: "rosemarla/qwen3-classify",
  modelType: "classify",
  spamAction: "junk",
  confidenceThreshold: 0.5,
  concurrency: 4,
  maxBodyChars: 2000,
  logConversations: false,
  systemPrompt:
    'You are an email spam classifier. Analyze the email and respond with a JSON object. Classify as "spam" or "ham". Provide a confidence score from 0.0 to 1.0.',
};

const CHAT_FORMAT = {
  type: "object",
  properties: {
    classification: { type: "string", enum: ["spam", "ham"] },
    confidence: { type: "number" },
  },
  required: ["classification", "confidence"],
};

let scanProgress = null;
let scanStartTime = null;
let lastScanResult = null;

async function getSettings() {
  const { settings } = await messenger.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

// Recursively extract plain text from a MessagePart MIME tree.
function extractText(part) {
  if (part.contentType === "text/plain" && part.body) {
    return part.body;
  }

  if (part.parts) {
    for (const child of part.parts) {
      if (child.contentType === "text/plain" && child.body) {
        return child.body;
      }
    }
    for (const child of part.parts) {
      const text = extractText(child);
      if (text) return text;
    }
  }

  if (part.contentType === "text/html" && part.body) {
    return part.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return "";
}

// Call Ollama /api/generate for binary classify models (returns 0 or 1).
async function classifyViaGenerate(settings, emailText) {
  const resp = await fetch(`${settings.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      prompt: emailText,
      stream: false,
      keep_alive: "24h",
      options: {
        num_ctx: 2048,
        num_gpu: 999,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama generate failed (${resp.status})`);
  }

  const data = await resp.json();
  const trimmed = data.response.trim();

  // Model may include thinking tags; look for the last 0 or 1
  const last0 = trimmed.lastIndexOf("0");
  const last1 = trimmed.lastIndexOf("1");

  if (last0 === -1 && last1 === -1) {
    throw new Error(`Unexpected classify response: "${trimmed}"`);
  }

  const isSpam = last1 > last0;
  return { spam: isSpam, confidence: 1.0, model: settings.model, rawResponse: trimmed };
}

// Call Ollama /api/chat with structured JSON output for general models.
async function classifyViaChat(settings, emailText) {
  const resp = await fetch(`${settings.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: settings.systemPrompt },
        { role: "user", content: emailText },
      ],
      stream: false,
      format: CHAT_FORMAT,
      keep_alive: "24h",
      options: {
        num_ctx: 2048,
        num_gpu: 999,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama chat failed (${resp.status})`);
  }

  const data = await resp.json();
  const parsed = JSON.parse(data.message.content);

  return {
    spam: parsed.classification === "spam",
    confidence: parsed.confidence,
    model: settings.model,
    rawResponse: data.message.content,
  };
}

async function classifyMessage(messageId, settings) {
  const header = await messenger.messages.get(messageId);
  const full = await messenger.messages.getFull(messageId);
  let body = extractText(full);
  // Truncate body — spam signals are in the first few thousand chars.
  // Shorter input = faster inference and less VRAM.
  if (body.length > settings.maxBodyChars) {
    body = body.slice(0, settings.maxBodyChars);
  }
  const emailText = `Subject: ${header.subject || ""}\n\nBody: ${body}`;

  let result;
  if (settings.modelType === "chat") {
    result = await classifyViaChat(settings, emailText);
  } else {
    result = await classifyViaGenerate(settings, emailText);
  }

  if (settings.logConversations) {
    const classification = result.spam ? "SPAM" : "HAM";
    console.log(
      `[AI Spam Filter] Subject: "${header.subject || "(no subject)"}" → ${classification} (confidence: ${result.confidence}) | Response: ${result.rawResponse}`,
    );
  }

  return result;
}

async function findSpecialFolder(accountId, specialUse) {
  const folders = await messenger.folders.query({
    accountId,
    specialUse: [specialUse],
  });
  if (folders && folders.length > 0) {
    return folders[0];
  }
  return null;
}

async function handleSpam(messageId, settings, accountId) {
  switch (settings.spamAction) {
    case "junk": {
      const folder = await findSpecialFolder(accountId, "junk");
      if (folder) {
        await messenger.messages.move([messageId], folder.id);
      } else {
        console.warn("Junk folder not found, moving to trash instead");
        const trash = await findSpecialFolder(accountId, "trash");
        if (trash) await messenger.messages.move([messageId], trash.id);
      }
      break;
    }
    case "trash": {
      const folder = await findSpecialFolder(accountId, "trash");
      if (folder) {
        await messenger.messages.move([messageId], folder.id);
      }
      break;
    }
    case "delete":
      await messenger.messages.delete([messageId], true);
      break;
  }
}

// Listen for new mail
messenger.messages.onNewMailReceived.addListener(async (folder, messageList) => {
  const settings = await getSettings();
  for (const message of messageList.messages) {
    try {
      const result = await classifyMessage(message.id, settings);
      if (
        result &&
        result.spam &&
        result.confidence >= settings.confidenceThreshold
      ) {
        console.log(
          `Spam detected: "${message.subject}" (confidence: ${result.confidence})`,
        );
        await handleSpam(message.id, settings, folder.accountId);
      }
    } catch (err) {
      console.error("Spam filter error:", err);
    }
  }
});

// Scan all messages in the currently displayed folder
async function scanCurrentFolder() {
  const settings = await getSettings();
  const tabs = await messenger.mailTabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tabs || tabs.length === 0) {
    throw new Error("No active mail tab");
  }

  const folder = tabs[0].displayedFolder;
  if (!folder) {
    throw new Error("No folder displayed");
  }

  const allMessages = [];
  let page = await messenger.messages.list(folder.id);
  allMessages.push(...page.messages);
  while (page.id) {
    page = await messenger.messages.continueList(page.id);
    allMessages.push(...page.messages);
  }

  scanStartTime = Date.now();
  lastScanResult = null;
  scanProgress = { total: allMessages.length, scanned: 0, spamFound: 0 };

  // Process messages concurrently (matches OLLAMA_NUM_PARALLEL).
  const concurrency = settings.concurrency || 4;
  let idx = 0;

  async function worker() {
    while (idx < allMessages.length) {
      const message = allMessages[idx++];
      try {
        const result = await classifyMessage(message.id, settings);
        if (
          result &&
          result.spam &&
          result.confidence >= settings.confidenceThreshold
        ) {
          await handleSpam(message.id, settings, folder.accountId);
          scanProgress.spamFound++;
        }
      } catch (err) {
        console.error(`Error classifying message ${message.id}:`, err);
      }
      scanProgress.scanned++;
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const totalSec = (Date.now() - scanStartTime) / 1000;
  const avgRate = totalSec > 0 ? (scanProgress.scanned / totalSec).toFixed(1) : "0";
  const result = { ...scanProgress, avgRate };
  lastScanResult = result;
  scanProgress = null;
  scanStartTime = null;
  return result;
}

// Handle messages from popup
messenger.runtime.onMessage.addListener(async (request) => {
  if (request.action === "scanFolder") {
    return await scanCurrentFolder();
  }
  if (request.action === "getProgress") {
    return { progress: scanProgress, startTime: scanStartTime };
  }
  if (request.action === "getState") {
    return { progress: scanProgress, startTime: scanStartTime, lastResult: lastScanResult };
  }
});
