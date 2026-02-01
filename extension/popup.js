const scanBtn = document.getElementById("scanBtn");
const progressDiv = document.getElementById("progress");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const statusDiv = document.getElementById("status");

let polling = null;
let lastScanned = 0;
let lastTime = 0;
let rate = 0;

function updateProgressUI(progress, startTime) {
  if (!progress || progress.total === 0) return;

  const now = Date.now();
  const elapsed = (now - lastTime) / 1000;
  if (elapsed > 0 && progress.scanned > lastScanned) {
    rate = (progress.scanned - lastScanned) / elapsed;
    lastScanned = progress.scanned;
    lastTime = now;
  }
  // On first poll after reopen, estimate rate from overall progress
  if (rate === 0 && startTime && progress.scanned > 0) {
    rate = progress.scanned / ((now - startTime) / 1000);
    lastScanned = progress.scanned;
    lastTime = now;
  }

  const pct = Math.round((progress.scanned / progress.total) * 100);
  progressBar.style.width = pct + "%";
  const rateStr = rate > 0 ? ` — ${rate.toFixed(1)} emails/s` : "";
  progressText.textContent = `${progress.scanned}/${progress.total} — ${progress.spamFound} spam found${rateStr}`;
}

function showDone(result) {
  progressBar.style.width = "100%";
  statusDiv.textContent = `Done. Scanned ${result.scanned} messages, found ${result.spamFound} spam. (${result.avgRate} emails/s)`;
  scanBtn.disabled = false;
  scanBtn.textContent = "Scan Current Folder";
}

function startPolling() {
  if (polling) return;
  polling = setInterval(async () => {
    try {
      const state = await messenger.runtime.sendMessage({ action: "getProgress" });
      if (state && state.progress) {
        updateProgressUI(state.progress, state.startTime);
      } else {
        // Scan finished while we were polling
        clearInterval(polling);
        polling = null;
      }
    } catch (_) {}
  }, 500);
}

// On popup open, check if a scan is already running or just finished
async function restoreState() {
  try {
    const state = await messenger.runtime.sendMessage({ action: "getState" });
    if (state && state.progress) {
      // Scan is in progress
      scanBtn.disabled = true;
      scanBtn.textContent = "Scanning...";
      progressDiv.style.display = "block";
      statusDiv.textContent = "";
      updateProgressUI(state.progress, state.startTime);
      startPolling();
    } else if (state && state.lastResult) {
      // A scan finished recently
      progressDiv.style.display = "block";
      showDone(state.lastResult);
    }
  } catch (_) {}
}

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning...";
  progressDiv.style.display = "block";
  statusDiv.textContent = "";
  lastScanned = 0;
  lastTime = Date.now();
  rate = 0;

  startPolling();

  try {
    const result = await messenger.runtime.sendMessage({ action: "scanFolder" });
    showDone(result);
  } catch (err) {
    statusDiv.textContent = `Error: ${err.message}`;
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan Current Folder";
  }

  clearInterval(polling);
  polling = null;
});

restoreState();
