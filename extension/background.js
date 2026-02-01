const DEFAULT_SETTINGS = {
  ollamaUrl: "http://localhost:11434",
  model: "gemma3:12b",
  modelType: "chat",
  spamAction: "junk",
  confidenceThreshold: 0.5,
  concurrency: 4,
  maxBodyChars: 8000,
  logConversations: false,
  systemPrompt:
    'You are an email spam classifier. Classify as "spam" or "ham". Provide a confidence score from 0.0 to 1.0. HAM (not spam) includes: invoices, receipts, order/shipping confirmations, account notifications, support tickets, service updates, utility reminders, personal messages, and transactional emails. SPAM includes: marketing newsletters, product or service advertisements, promotional offers, e-commerce promotions, unsolicited ads, phishing, scams, fake prizes, and deceptive messages. Any email trying to sell, promote, or advertise a product or service is spam. When in doubt, classify as ham.',
};

const CHAT_FORMAT = {
  type: "object",
  properties: {
    classification: { type: "string", enum: ["spam", "ham"] },
    confidence: { type: "number" },
  },
  required: ["classification", "confidence"],
};

const TAG_HAM = "ham_verified";
const TAG_SPAM = "spam_detected";

let scanProgress = null;
let scanStartTime = null;
let lastScanResult = null;
let scanCancelled = false;
let reviewProgress = null;
let reviewStartTime = null;
let lastReviewResult = null;
let reviewCancelled = false;

async function ensureTags() {
  const existing = await messenger.messages.tags.list();
  const keys = existing.map((t) => t.key);
  if (!keys.includes(TAG_HAM)) {
    await messenger.messages.tags.create(TAG_HAM, "Ham Verified", "#4CAF50");
  }
  if (!keys.includes(TAG_SPAM)) {
    await messenger.messages.tags.create(TAG_SPAM, "Spam Detected", "#F44336");
  }
}

ensureTags();

async function addTag(messageId, tagKey) {
  const msg = await messenger.messages.get(messageId);
  const tags = msg.tags || [];
  if (!tags.includes(tagKey)) {
    tags.push(tagKey);
    await messenger.messages.update(messageId, { tags });
  }
}

async function removeTag(messageId, tagKey) {
  const msg = await messenger.messages.get(messageId);
  const tags = (msg.tags || []).filter((t) => t !== tagKey);
  await messenger.messages.update(messageId, { tags });
}

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
      prompt: "/no_think " + emailText,
      stream: false,
      think: false,
      keep_alive: "24h",
      options: {
        num_ctx: 4096,
        num_gpu: 999,
        temperature: 0,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama generate failed (${resp.status})`);
  }

  const data = await resp.json();
  const rawResponse = data.response.trim();

  // Strip <think>...</think> blocks in case the model still produces them.
  const output = rawResponse.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Look for 0 or 1 anywhere in the output (model sometimes adds stray text).
  const has0 = output.includes("0");
  const has1 = output.includes("1");

  if (!has0 && !has1) {
    // Fallback: infer from think block reasoning when the model outputs
    // no valid digit. Check for ham indicators first (more specific),
    // then spam indicators.
    const thinkMatch = rawResponse.match(/<think>[\s\S]*?<\/think>/);
    if (thinkMatch) {
      const t = thinkMatch[0].toLowerCase();
      const hamPatterns = ["not spam", "not indicative of spam", "is ham",
        "is legitimate", "is not", "legitimate email"];
      const spamPatterns = ["classifying as spam", "is spam", "spam content",
        "typical of spam", "likely spam", "indicates spam"];
      const hamHits = hamPatterns.filter((p) => t.includes(p)).length;
      const spamHits = spamPatterns.filter((p) => t.includes(p)).length;
      if (spamHits > hamHits) {
        return { spam: true, confidence: 0.7, model: settings.model, rawResponse };
      }
      if (hamHits > spamHits) {
        return { spam: false, confidence: 0.7, model: settings.model, rawResponse };
      }
    }
    throw new Error(`Unexpected classify response: "${rawResponse}"`);
  }

  // If only one digit is present, use it. If both, use the last one.
  let isSpam;
  if (has0 && !has1) isSpam = false;
  else if (has1 && !has0) isSpam = true;
  else isSpam = output.lastIndexOf("1") > output.lastIndexOf("0");

  return { spam: isSpam, confidence: 1.0, model: settings.model, rawResponse };
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
        num_ctx: 4096,
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
  const from = header.author || "";
  const to = (header.recipients || []).join(", ");
  const emailText = `From: ${from}\nTo: ${to}\nSubject: ${header.subject || ""}\n\nBody: ${body}`;

  let result;
  if (settings.modelType === "chat") {
    result = await classifyViaChat(settings, emailText);
  } else {
    result = await classifyViaGenerate(settings, emailText);
  }

  if (settings.logConversations) {
    const classification = result.spam ? "SPAM" : "HAM";
    console.log(
      `[Ollama Spam Filter] Subject: "${header.subject || "(no subject)"}" → ${classification} (confidence: ${result.confidence}) | Response: ${result.rawResponse}`,
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
        await addTag(message.id, TAG_SPAM);
        await handleSpam(message.id, settings, folder.accountId);
      } else {
        await addTag(message.id, TAG_HAM);
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
  scanCancelled = false;
  scanProgress = { total: allMessages.length, scanned: 0, spamFound: 0 };

  // Process messages concurrently (matches OLLAMA_NUM_PARALLEL).
  const concurrency = settings.concurrency || 4;
  let idx = 0;

  async function worker() {
    while (idx < allMessages.length && !scanCancelled) {
      const message = allMessages[idx++];
      try {
        const result = await classifyMessage(message.id, settings);
        if (
          result &&
          result.spam &&
          result.confidence >= settings.confidenceThreshold
        ) {
          await addTag(message.id, TAG_SPAM);
          await handleSpam(message.id, settings, folder.accountId);
          scanProgress.spamFound++;
        } else {
          await addTag(message.id, TAG_HAM);
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
  const cancelled = scanCancelled;
  const result = { ...scanProgress, avgRate, cancelled };
  lastScanResult = result;
  scanProgress = null;
  scanStartTime = null;
  scanCancelled = false;
  return result;
}

// Review all messages in Junk folders, reclassify, and restore false positives
async function reviewSpam() {
  const settings = await getSettings();
  const accounts = await messenger.accounts.list();

  const allMessages = [];
  for (const account of accounts) {
    const junk = await findSpecialFolder(account.id, "junk");
    if (!junk) continue;
    let page = await messenger.messages.list(junk.id);
    allMessages.push(...page.messages.map((m) => ({ message: m, accountId: account.id })));
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      allMessages.push(...page.messages.map((m) => ({ message: m, accountId: account.id })));
    }
  }

  reviewStartTime = Date.now();
  lastReviewResult = null;
  reviewCancelled = false;
  reviewProgress = { total: allMessages.length, scanned: 0, restored: 0 };

  const concurrency = settings.concurrency || 4;
  let idx = 0;

  async function worker() {
    while (idx < allMessages.length && !reviewCancelled) {
      const { message, accountId } = allMessages[idx++];
      try {
        const result = await classifyMessage(message.id, settings);
        if (
          !result ||
          !result.spam ||
          result.confidence < settings.confidenceThreshold
        ) {
          // Reclassified as ham — restore to inbox
          await removeTag(message.id, TAG_SPAM);
          await addTag(message.id, TAG_HAM);
          const inbox = await findSpecialFolder(accountId, "inbox");
          if (inbox) {
            await messenger.messages.move([message.id], inbox.id);
          }
          reviewProgress.restored++;
        }
      } catch (err) {
        console.error(`Error reviewing message ${message.id}:`, err);
      }
      reviewProgress.scanned++;
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const totalSec = (Date.now() - reviewStartTime) / 1000;
  const avgRate = totalSec > 0 ? (reviewProgress.scanned / totalSec).toFixed(1) : "0";
  const cancelled = reviewCancelled;
  const result = { ...reviewProgress, avgRate, cancelled };
  lastReviewResult = result;
  reviewProgress = null;
  reviewStartTime = null;
  reviewCancelled = false;
  return result;
}

// Handle messages from popup
messenger.runtime.onMessage.addListener(async (request) => {
  if (request.action === "scanFolder") {
    return await scanCurrentFolder();
  }
  if (request.action === "stopScan") {
    scanCancelled = true;
    return { ok: true };
  }
  if (request.action === "getProgress") {
    let rate = null;
    if (scanProgress && scanStartTime && scanProgress.scanned > 0) {
      const elapsed = (Date.now() - scanStartTime) / 1000;
      if (elapsed > 0) rate = (scanProgress.scanned / elapsed).toFixed(1);
    }
    return { progress: scanProgress, rate };
  }
  if (request.action === "getState") {
    let rate = null;
    if (scanProgress && scanStartTime && scanProgress.scanned > 0) {
      const elapsed = (Date.now() - scanStartTime) / 1000;
      if (elapsed > 0) rate = (scanProgress.scanned / elapsed).toFixed(1);
    }
    let reviewRate = null;
    if (reviewProgress && reviewStartTime && reviewProgress.scanned > 0) {
      const elapsed = (Date.now() - reviewStartTime) / 1000;
      if (elapsed > 0) reviewRate = (reviewProgress.scanned / elapsed).toFixed(1);
    }
    return {
      progress: scanProgress, rate, lastResult: lastScanResult,
      reviewProgress, reviewRate, lastReviewResult,
    };
  }
  if (request.action === "reviewSpam") {
    return await reviewSpam();
  }
  if (request.action === "stopReview") {
    reviewCancelled = true;
    return { ok: true };
  }
  if (request.action === "getReviewProgress") {
    let rate = null;
    if (reviewProgress && reviewStartTime && reviewProgress.scanned > 0) {
      const elapsed = (Date.now() - reviewStartTime) / 1000;
      if (elapsed > 0) rate = (reviewProgress.scanned / elapsed).toFixed(1);
    }
    return { progress: reviewProgress, rate };
  }
});
