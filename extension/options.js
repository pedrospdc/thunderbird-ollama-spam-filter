const DEFAULT_SYSTEM_PROMPT =
  'You are an email spam classifier. Analyze the email and respond with a JSON object. Classify as "spam" or "ham". Provide a confidence score from 0.0 to 1.0.';

function toggleChatOptions() {
  const isChatMode = document.getElementById("modelType").value === "chat";
  document.getElementById("chatOptions").style.display = isChatMode
    ? "block"
    : "none";
}

async function loadSettings() {
  const { settings } = await messenger.storage.local.get("settings");
  const s = settings || {};
  document.getElementById("ollamaUrl").value =
    s.ollamaUrl || "http://localhost:11434";
  document.getElementById("model").value =
    s.model || "rosemarla/qwen3-classify";
  document.getElementById("modelType").value = s.modelType || "classify";
  document.getElementById("systemPrompt").value =
    s.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  document.getElementById("spamAction").value = s.spamAction || "junk";
  document.getElementById("confidenceThreshold").value =
    s.confidenceThreshold ?? 0.5;
  document.getElementById("logConversations").checked =
    s.logConversations || false;
  toggleChatOptions();
}

document.getElementById("modelType").addEventListener("change", toggleChatOptions);

document.getElementById("saveBtn").addEventListener("click", async () => {
  const settings = {
    ollamaUrl: document.getElementById("ollamaUrl").value,
    model: document.getElementById("model").value,
    modelType: document.getElementById("modelType").value,
    systemPrompt: document.getElementById("systemPrompt").value,
    spamAction: document.getElementById("spamAction").value,
    confidenceThreshold: parseFloat(
      document.getElementById("confidenceThreshold").value,
    ),
    logConversations: document.getElementById("logConversations").checked,
  };
  await messenger.storage.local.set({ settings });
  const saved = document.getElementById("saved");
  saved.style.display = "inline";
  setTimeout(() => (saved.style.display = "none"), 2000);
});

loadSettings();
