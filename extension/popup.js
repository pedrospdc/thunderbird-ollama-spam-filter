const scanBtn = document.getElementById("scanBtn");
const progressDiv = document.getElementById("progress");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const statusDiv = document.getElementById("status");

let polling = null;

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning...";
  progressDiv.style.display = "block";
  statusDiv.textContent = "";

  // Poll for progress updates
  polling = setInterval(async () => {
    try {
      const progress = await messenger.runtime.sendMessage({ action: "getProgress" });
      if (progress && progress.total > 0) {
        const pct = Math.round((progress.scanned / progress.total) * 100);
        progressBar.style.width = pct + "%";
        progressText.textContent = `${progress.scanned}/${progress.total} — ${progress.spamFound} spam found`;
      }
    } catch (_) {}
  }, 500);

  try {
    const result = await messenger.runtime.sendMessage({ action: "scanFolder" });
    statusDiv.textContent = `Done. Scanned ${result.scanned} messages, found ${result.spamFound} spam.`;
    progressBar.style.width = "100%";
  } catch (err) {
    statusDiv.textContent = `Error: ${err.message}`;
  }

  clearInterval(polling);
  scanBtn.disabled = false;
  scanBtn.textContent = "Scan Current Folder";
});
