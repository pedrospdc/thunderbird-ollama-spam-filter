const scanBtn = document.getElementById("scanBtn");
const stopBtn = document.getElementById("stopBtn");
const progressDiv = document.getElementById("progress");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const statusDiv = document.getElementById("status");

const reviewBtn = document.getElementById("reviewBtn");
const stopReviewBtn = document.getElementById("stopReviewBtn");
const reviewProgressDiv = document.getElementById("reviewProgress");
const reviewProgressBar = document.getElementById("reviewProgressBar");
const reviewProgressText = document.getElementById("reviewProgressText");
const reviewStatusDiv = document.getElementById("reviewStatus");

let polling = null;
let reviewPolling = null;

function updateProgressUI(progress, rate) {
  if (!progress || progress.total === 0) return;

  const pct = Math.round((progress.scanned / progress.total) * 100);
  progressBar.style.width = pct + "%";
  const rateStr = rate ? ` — ${rate} emails/s` : "";
  progressText.textContent = `${progress.scanned}/${progress.total} — ${progress.spamFound} spam found${rateStr}`;
}

function setScanningUI() {
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning...";
  stopBtn.style.display = "block";
  progressDiv.style.display = "block";
  statusDiv.textContent = "";
}

function showDone(result) {
  const prefix = result.cancelled ? "Stopped" : "Done";
  progressBar.style.width = result.cancelled
    ? Math.round((result.scanned / result.total) * 100) + "%"
    : "100%";
  statusDiv.textContent = `${prefix}. Scanned ${result.scanned} messages, found ${result.spamFound} spam. (${result.avgRate} emails/s)`;
  scanBtn.disabled = false;
  scanBtn.textContent = "Scan Current Folder";
  stopBtn.style.display = "none";
}

function startPolling() {
  if (polling) return;
  polling = setInterval(async () => {
    try {
      const state = await messenger.runtime.sendMessage({ action: "getProgress" });
      if (state && state.progress) {
        updateProgressUI(state.progress, state.rate);
      } else {
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
      setScanningUI();
      updateProgressUI(state.progress, state.rate);
      startPolling();
    } else if (state && state.lastResult) {
      progressDiv.style.display = "block";
      showDone(state.lastResult);
    }
    if (state && state.reviewProgress) {
      setReviewingUI();
      updateReviewProgressUI(state.reviewProgress, state.reviewRate);
      startReviewPolling();
    } else if (state && state.lastReviewResult) {
      reviewProgressDiv.style.display = "block";
      showReviewDone(state.lastReviewResult);
    }
  } catch (_) {}
}

scanBtn.addEventListener("click", async () => {
  setScanningUI();
  startPolling();

  try {
    const result = await messenger.runtime.sendMessage({ action: "scanFolder" });
    showDone(result);
  } catch (err) {
    statusDiv.textContent = `Error: ${err.message}`;
    scanBtn.disabled = false;
    scanBtn.textContent = "Scan Current Folder";
    stopBtn.style.display = "none";
  }

  clearInterval(polling);
  polling = null;
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping...";
  await messenger.runtime.sendMessage({ action: "stopScan" });
});

function updateReviewProgressUI(progress, rate) {
  if (!progress || progress.total === 0) return;
  const pct = Math.round((progress.scanned / progress.total) * 100);
  reviewProgressBar.style.width = pct + "%";
  const rateStr = rate ? ` — ${rate} emails/s` : "";
  reviewProgressText.textContent = `${progress.scanned}/${progress.total} — ${progress.restored} restored${rateStr}`;
}

function setReviewingUI() {
  reviewBtn.disabled = true;
  reviewBtn.textContent = "Reviewing...";
  stopReviewBtn.style.display = "block";
  reviewProgressDiv.style.display = "block";
  reviewStatusDiv.textContent = "";
}

function showReviewDone(result) {
  const prefix = result.cancelled ? "Stopped" : "Done";
  reviewProgressBar.style.width = result.cancelled
    ? Math.round((result.scanned / result.total) * 100) + "%"
    : "100%";
  reviewStatusDiv.textContent = `${prefix}. Reviewed ${result.scanned} messages, restored ${result.restored}. (${result.avgRate} emails/s)`;
  reviewBtn.disabled = false;
  reviewBtn.textContent = "Review Spam";
  stopReviewBtn.style.display = "none";
}

function startReviewPolling() {
  if (reviewPolling) return;
  reviewPolling = setInterval(async () => {
    try {
      const state = await messenger.runtime.sendMessage({ action: "getReviewProgress" });
      if (state && state.progress) {
        updateReviewProgressUI(state.progress, state.rate);
      } else {
        clearInterval(reviewPolling);
        reviewPolling = null;
      }
    } catch (_) {}
  }, 500);
}

reviewBtn.addEventListener("click", async () => {
  setReviewingUI();
  startReviewPolling();

  try {
    const result = await messenger.runtime.sendMessage({ action: "reviewSpam" });
    showReviewDone(result);
  } catch (err) {
    reviewStatusDiv.textContent = `Error: ${err.message}`;
    reviewBtn.disabled = false;
    reviewBtn.textContent = "Review Spam";
    stopReviewBtn.style.display = "none";
  }

  clearInterval(reviewPolling);
  reviewPolling = null;
});

stopReviewBtn.addEventListener("click", async () => {
  stopReviewBtn.disabled = true;
  stopReviewBtn.textContent = "Stopping...";
  await messenger.runtime.sendMessage({ action: "stopReview" });
});

restoreState();
