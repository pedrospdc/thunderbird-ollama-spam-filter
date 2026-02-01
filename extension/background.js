const DEFAULT_SETTINGS = {
  ollamaUrl: "http://localhost:11434",
  model: "rosemarla/qwen3-classify",
  modelType: "classify",
  spamAction: "junk",
  confidenceThreshold: 0.5,
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
  return { spam: isSpam, confidence: 1.0, model: settings.model };
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
  };
}

async function classifyMessage(messageId, settings) {
  const header = await messenger.messages.get(messageId);
  const full = await messenger.messages.getFull(messageId);
  const body = extractText(full);
  const emailText = `Subject: ${header.subject || ""}\n\nBody: ${body}`;

  if (settings.modelType === "chat") {
    return classifyViaChat(settings, emailText);
  }
  return classifyViaGenerate(settings, emailText);
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

  scanProgress = { total: allMessages.length, scanned: 0, spamFound: 0 };

  for (const message of allMessages) {
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

  const result = { ...scanProgress };
  scanProgress = null;
  return result;
}

// Handle messages from popup
messenger.runtime.onMessage.addListener(async (request) => {
  if (request.action === "scanFolder") {
    return await scanCurrentFolder();
  }
  if (request.action === "getProgress") {
    return scanProgress;
  }
});
