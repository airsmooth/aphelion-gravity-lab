const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { app, BrowserWindow, dialog, session } = require("electron");

const APP_ID = "com.aphelion.gravitylab";
const MAX_RECOVERY_ATTEMPTS = 2;
const UNRESPONSIVE_GRACE_MS = 5_000;
const HEALTHY_RECOVERY_RESET_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 4_000;
const ENDURANCE_STALL_LIMIT = 5;

const smokeTest = process.argv.includes("--smoke-test");
const enduranceArgument = process.argv.find((argument) =>
  argument === "--endurance-test" || argument.startsWith("--endurance-test="));
const enduranceTest = Boolean(enduranceArgument);
const automatedTest = smokeTest || enduranceTest;
const enduranceReportArgument = process.argv.find((argument) =>
  argument.startsWith("--endurance-report="));

let commandLineError = null;
let enduranceSeconds = null;
let enduranceReportPath = null;

if (smokeTest && enduranceTest) {
  commandLineError = "--smoke-test and --endurance-test cannot be used together";
}

if (enduranceTest) {
  const rawSeconds = enduranceArgument.includes("=")
    ? enduranceArgument.slice(enduranceArgument.indexOf("=") + 1)
    : "900";
  const parsedSeconds = Number(rawSeconds);
  if (!Number.isFinite(parsedSeconds) || parsedSeconds < 5 || parsedSeconds > 86_400) {
    commandLineError = "--endurance-test must be between 5 and 86400 seconds";
  } else {
    enduranceSeconds = Math.ceil(parsedSeconds);
  }
}

if (enduranceReportArgument) {
  enduranceReportPath = enduranceReportArgument.slice(enduranceReportArgument.indexOf("=") + 1);
  if (!enduranceTest) {
    commandLineError = "--endurance-report requires --endurance-test";
  } else if (!path.isAbsolute(enduranceReportPath)) {
    commandLineError = "--endurance-report must be an absolute path";
  }
}

// Automated checks must be able to run beside an already-open copy of Aphelion.
// A separate user-data directory also keeps their cache and diagnostic log isolated.
if (automatedTest) {
  const testUserData = fs.mkdtempSync(path.join(app.getPath("temp"), "aphelion-test-"));
  app.setPath("userData", testUserData);
}

const singleInstance = automatedTest || app.requestSingleInstanceLock();
let mainWindow = null;
let isQuitting = false;
let recoveryAttempts = 0;
let recoveryReloadTimer = null;
let unresponsiveTimer = null;
let healthyRecoveryTimer = null;
let automationStarted = false;
let automationFinished = false;
let automationTimeout = null;
let endurancePollTimer = null;

const enduranceState = {
  startedAt: null,
  lastSnapshot: null,
  progressChanges: 0,
  heartbeatChanges: 0,
  consecutiveProgressStalls: 0,
  maxConsecutiveProgressStalls: 0,
  consecutiveHeartbeatStalls: 0,
  maxConsecutiveHeartbeatStalls: 0,
  sampleCount: 0,
  unresponsiveEvents: 0,
  renderProcessGoneEvents: 0,
  rendererErrors: [],
  recentSamples: [],
  initialPrivateBytes: 0,
  initialWorkingSetBytes: 0,
  baselinePrivateBytes: 0,
  baselineWorkingSetBytes: 0,
  memoryBaselineAtSeconds: 0,
  lastPrivateBytes: 0,
  lastWorkingSetBytes: 0,
  peakPrivateBytes: 0,
  peakWorkingSetBytes: 0,
};

if (!singleInstance) {
  app.quit();
}

app.setAppUserModelId(APP_ID);

function writeDiagnostic(message) {
  try {
    const line = `${new Date().toISOString()} ${message}\n`;
    fs.appendFileSync(path.join(app.getPath("userData"), "aphelion.log"), line, "utf8");
  } catch {
    // Diagnostics must never prevent the application from opening.
  }
}

function rendererPath() {
  return path.join(__dirname, "..", "desktop-dist", "index.html");
}

function isLocalRendererUrl(url) {
  try {
    const destination = path.resolve(fileURLToPath(new URL(url))).toLowerCase();
    return destination === path.resolve(rendererPath()).toLowerCase();
  } catch {
    return false;
  }
}

function isBenignRendererConsoleMessage(message) {
  // Chromium reports this as an error-level console entry even though the rest
  // of the file renderer's CSP remains active. frame-ancestors is response-only.
  return message.includes("The Content Security Policy directive 'frame-ancestors' is ignored");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function clearWindowTimers() {
  if (recoveryReloadTimer) clearTimeout(recoveryReloadTimer);
  if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
  if (healthyRecoveryTimer) clearTimeout(healthyRecoveryTimer);
  recoveryReloadTimer = null;
  unresponsiveTimer = null;
  healthyRecoveryTimer = null;
}

function clearAutomationTimers() {
  if (automationTimeout) clearTimeout(automationTimeout);
  if (endurancePollTimer) clearTimeout(endurancePollTimer);
  automationTimeout = null;
  endurancePollTimer = null;
}

function captureProcessMemory() {
  let privateBytes = 0;
  let workingSetBytes = 0;
  for (const metric of app.getAppMetrics()) {
    // Electron's ProcessMemoryInfo values are KiB.
    privateBytes += (metric.memory?.privateBytes ?? 0) * 1_024;
    workingSetBytes += (metric.memory?.workingSetSize ?? 0) * 1_024;
  }
  enduranceState.peakPrivateBytes = Math.max(enduranceState.peakPrivateBytes, privateBytes);
  enduranceState.peakWorkingSetBytes = Math.max(enduranceState.peakWorkingSetBytes, workingSetBytes);
  return { privateBytes, workingSetBytes };
}

function writeEnduranceReport(report) {
  if (!enduranceReportPath) return null;
  try {
    fs.mkdirSync(path.dirname(enduranceReportPath), { recursive: true });
    fs.writeFileSync(enduranceReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function finishSmokeTest(code, message) {
  if (!smokeTest || automationFinished) return;
  automationFinished = true;
  clearAutomationTimers();
  if (message) process.stdout.write(`${message}\n`);
  app.exit(code);
}

function finishEnduranceTest(passed, reason, extra = {}) {
  if (!enduranceTest || automationFinished) return;
  automationFinished = true;
  clearAutomationTimers();
  const endedAt = new Date();
  const startedAt = enduranceState.startedAt ?? endedAt;
  const report = {
    schemaVersion: 1,
    app: "Aphelion Gravity Lab",
    version: app.getVersion(),
    passed,
    reason,
    requestedSeconds: enduranceSeconds,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds: Number(((endedAt.getTime() - startedAt.getTime()) / 1_000).toFixed(3)),
    samples: enduranceState.sampleCount,
    progressChanges: enduranceState.progressChanges,
    heartbeatChanges: enduranceState.heartbeatChanges,
    maxConsecutiveProgressStalls: enduranceState.maxConsecutiveProgressStalls,
    maxConsecutiveHeartbeatStalls: enduranceState.maxConsecutiveHeartbeatStalls,
    unresponsiveEvents: enduranceState.unresponsiveEvents,
    renderProcessGoneEvents: enduranceState.renderProcessGoneEvents,
    rendererErrors: enduranceState.rendererErrors,
    recoveryAttempts,
    initialPrivateBytes: enduranceState.initialPrivateBytes,
    initialWorkingSetBytes: enduranceState.initialWorkingSetBytes,
    baselinePrivateBytes: enduranceState.baselinePrivateBytes,
    baselineWorkingSetBytes: enduranceState.baselineWorkingSetBytes,
    memoryBaselineAtSeconds: enduranceState.memoryBaselineAtSeconds,
    finalPrivateBytes: enduranceState.lastPrivateBytes,
    finalWorkingSetBytes: enduranceState.lastWorkingSetBytes,
    privateBytesDelta: enduranceState.lastPrivateBytes - enduranceState.baselinePrivateBytes,
    workingSetBytesDelta: enduranceState.lastWorkingSetBytes - enduranceState.baselineWorkingSetBytes,
    peakPrivateBytes: enduranceState.peakPrivateBytes,
    peakWorkingSetBytes: enduranceState.peakWorkingSetBytes,
    rendererQuery: enduranceState.lastSnapshot?.locationSearch ?? null,
    finalSnapshot: enduranceState.lastSnapshot,
    recentSamples: enduranceState.recentSamples,
    ...extra,
  };
  const reportError = writeEnduranceReport(report);
  if (reportError) {
    passed = false;
    reason = `${reason}; report write failed: ${reportError}`;
  }
  process.stdout.write(`ENDURANCE ${passed ? "PASS" : "FAIL"}: ${reason}\n`);
  app.exit(passed ? 0 : 1);
}

function failAutomatedTest(reason, extra = {}) {
  if (enduranceTest) {
    finishEnduranceTest(false, reason, extra);
  } else if (smokeTest) {
    finishSmokeTest(1, `SMOKE FAIL: ${reason}`);
  }
}

async function loadRenderer(window, recovery = false) {
  try {
    const loadOptions = enduranceTest ? { query: { endurance: "1" } } : {};
    await window.loadFile(rendererPath(), loadOptions);
  } catch (error) {
    const detail = error instanceof Error ? error.stack : String(error);
    writeDiagnostic(`load failure: ${detail}`);
    if (automatedTest) {
      failAutomatedTest(`local renderer load failed: ${detail}`);
      return;
    }
    if (recovery) {
      recoverRenderer(window, "recovery load failure");
      return;
    }
    dialog.showErrorBox(
      "Aphelion could not start",
      "The local simulation files could not be loaded. Rebuild or reinstall the application.",
    );
    app.exit(1);
  }
}

function scheduleHealthyRecoveryReset(window) {
  if (healthyRecoveryTimer) clearTimeout(healthyRecoveryTimer);
  healthyRecoveryTimer = setTimeout(() => {
    healthyRecoveryTimer = null;
    if (isQuitting || window.isDestroyed()) return;
    if (recoveryAttempts > 0) writeDiagnostic("renderer remained healthy; recovery budget reset");
    recoveryAttempts = 0;
  }, HEALTHY_RECOVERY_RESET_MS);
}

function showRecoveryFailure(window, trigger) {
  writeDiagnostic(`renderer recovery exhausted: ${trigger}`);
  if (automatedTest) {
    failAutomatedTest(`renderer recovery exhausted: ${trigger}`);
    return;
  }
  void dialog.showMessageBox(window, {
    type: "error",
    title: "Aphelion recovery",
    message: "The simulation stopped repeatedly.",
    detail: "Close and reopen the application. A diagnostic log was saved in the app data folder.",
    buttons: ["Close"],
  }).then(() => app.quit());
}

function recoverRenderer(window, trigger) {
  if (isQuitting || window.isDestroyed() || automationFinished) return;
  if (recoveryReloadTimer) return;
  if (healthyRecoveryTimer) clearTimeout(healthyRecoveryTimer);
  healthyRecoveryTimer = null;
  recoveryAttempts += 1;
  if (recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
    showRecoveryFailure(window, trigger);
    return;
  }
  writeDiagnostic(`renderer recovery ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}: ${trigger}`);
  recoveryReloadTimer = setTimeout(() => {
    recoveryReloadTimer = null;
    if (!isQuitting && !window.isDestroyed()) void loadRenderer(window, true);
  }, 350);
}

async function installRendererMonitor(window) {
  await withTimeout(window.webContents.executeJavaScript(`(() => {
    if (!window.__APHELION_AUTOMATION__) {
      const state = { errors: [], frames: 0, lastFrameAt: performance.now() };
      window.__APHELION_AUTOMATION__ = state;
      window.addEventListener('error', (event) => {
        state.errors.push(String(event.error?.stack || event.message || 'window error'));
      });
      window.addEventListener('unhandledrejection', (event) => {
        state.errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection'));
      });
      const pulse = (now) => {
        state.frames += 1;
        state.lastFrameAt = now;
        requestAnimationFrame(pulse);
      };
      requestAnimationFrame(pulse);
    }
    return true;
  })()`), SNAPSHOT_TIMEOUT_MS, "renderer monitor installation timed out");
}

async function readRendererSnapshot(window) {
  const snapshot = await withTimeout(window.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('canvas');
    const text = document.body?.innerText ?? '';
    const monitor = window.__APHELION_AUTOMATION__ ?? { errors: [], frames: 0, lastFrameAt: 0 };
    let diagnostics = null;
    try {
      const source = typeof window.__APHELION_DIAGNOSTICS__ === 'function'
        ? window.__APHELION_DIAGNOSTICS__()
        : window.__APHELION_DIAGNOSTICS__;
      if (source) diagnostics = JSON.parse(JSON.stringify(source));
    } catch (error) {
      monitor.errors.push(String(error?.message || error));
    }
    return {
      title: document.title,
      locationSearch: window.location.search,
      hasBrand: text.includes('APHELION'),
      recoveryMode: text.includes('APHELION / RECOVERY MODE'),
      alert: document.querySelector('[role="alert"]')?.textContent?.trim() ?? null,
      bodyCount: Number(document.querySelector('.gravity-lab')?.getAttribute('data-body-count') ?? 0),
      enduranceStatus: document.documentElement.dataset.aphelionEndurance ?? null,
      universeCanvasStatuses: Array.from(document.querySelectorAll('[data-universe-canvas-status]'))
        .map((element) => element.getAttribute('data-universe-canvas-status')),
      universeCanvasError: Boolean(
        document.querySelector('[data-universe-canvas-status="error"], [data-universe-canvas-error="active"]'),
      ),
      simulationTime: document.querySelector('.simulation-time strong')?.textContent?.trim() ?? null,
      transportAction: document.querySelector('.primary-transport')?.getAttribute('aria-label') ?? null,
      canvasWidth: canvas?.getBoundingClientRect().width ?? 0,
      canvasHeight: canvas?.getBoundingClientRect().height ?? 0,
      heartbeatFrames: monitor.frames,
      lastHeartbeatAt: monitor.lastFrameAt,
      errors: monitor.errors.slice(-20),
      diagnostics,
    };
  })()`), SNAPSHOT_TIMEOUT_MS, "renderer liveness poll timed out");
  return snapshot;
}

async function waitForRendererReady(window, timeoutMilliseconds = 8_000, requireEnduranceWorkload = false) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastSnapshot = null;
  while (Date.now() < deadline && !automationFinished) {
    lastSnapshot = await readRendererSnapshot(window);
    const workloadReady = !requireEnduranceWorkload
      || (lastSnapshot.enduranceStatus === "active" && lastSnapshot.bodyCount === 32);
    if (lastSnapshot.title === "Aphelion Gravity Lab"
        && lastSnapshot.hasBrand
        && lastSnapshot.simulationTime
        && lastSnapshot.canvasWidth > 0
        && lastSnapshot.canvasHeight > 0
        && workloadReady) {
      return lastSnapshot;
    }
    await delay(200);
  }
  throw new Error(`renderer did not become ready: ${JSON.stringify(lastSnapshot)}`);
}

async function runSmokeTest(window) {
  try {
    await installRendererMonitor(window);
    const first = await waitForRendererReady(window);
    await delay(2_200);
    const second = await readRendererSnapshot(window);
    const passed = !second.recoveryMode
      && !second.alert
      && !second.universeCanvasError
      && second.errors.length === 0
      && second.locationSearch === ''
      && first.simulationTime !== second.simulationTime
      && second.heartbeatFrames > first.heartbeatFrames;
    finishSmokeTest(
      passed ? 0 : 1,
      passed
        ? `SMOKE PASS: local renderer advanced from ${first.simulationTime} to ${second.simulationTime}`
        : `SMOKE FAIL: renderer did not advance ${JSON.stringify({ first, second })}`,
    );
  } catch (error) {
    finishSmokeTest(1, `SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function recordEnduranceSample(snapshot, elapsedSeconds) {
  const previous = enduranceState.lastSnapshot;
  if (previous) {
    if (snapshot.simulationTime !== previous.simulationTime) {
      enduranceState.progressChanges += 1;
      enduranceState.consecutiveProgressStalls = 0;
    } else {
      enduranceState.consecutiveProgressStalls += 1;
    }
    if (snapshot.heartbeatFrames > previous.heartbeatFrames) {
      enduranceState.heartbeatChanges += 1;
      enduranceState.consecutiveHeartbeatStalls = 0;
    } else {
      enduranceState.consecutiveHeartbeatStalls += 1;
    }
  }
  enduranceState.maxConsecutiveProgressStalls = Math.max(
    enduranceState.maxConsecutiveProgressStalls,
    enduranceState.consecutiveProgressStalls,
  );
  enduranceState.maxConsecutiveHeartbeatStalls = Math.max(
    enduranceState.maxConsecutiveHeartbeatStalls,
    enduranceState.consecutiveHeartbeatStalls,
  );
  enduranceState.sampleCount += 1;
  enduranceState.lastSnapshot = snapshot;
  const memory = captureProcessMemory();
  if (enduranceState.sampleCount === 1) {
    enduranceState.initialPrivateBytes = memory.privateBytes;
    enduranceState.initialWorkingSetBytes = memory.workingSetBytes;
    enduranceState.baselinePrivateBytes = memory.privateBytes;
    enduranceState.baselineWorkingSetBytes = memory.workingSetBytes;
  } else if (enduranceState.memoryBaselineAtSeconds === 0 && elapsedSeconds >= 5) {
    // Exclude renderer/GPU startup allocation from the steady-state delta.
    enduranceState.baselinePrivateBytes = memory.privateBytes;
    enduranceState.baselineWorkingSetBytes = memory.workingSetBytes;
    enduranceState.memoryBaselineAtSeconds = Number(elapsedSeconds.toFixed(3));
  }
  enduranceState.lastPrivateBytes = memory.privateBytes;
  enduranceState.lastWorkingSetBytes = memory.workingSetBytes;
  enduranceState.recentSamples.push({
    elapsedSeconds: Number(elapsedSeconds.toFixed(3)),
    simulationTime: snapshot.simulationTime,
    heartbeatFrames: snapshot.heartbeatFrames,
    memory,
  });
  if (enduranceState.recentSamples.length > 120) enduranceState.recentSamples.shift();
}

async function runEnduranceTest(window) {
  try {
    await installRendererMonitor(window);
    const initial = await waitForRendererReady(window, 8_000, true);
    if (initial.locationSearch !== "?endurance=1") {
      throw new Error(`endurance renderer query was not applied: ${initial.locationSearch || "<empty>"}`);
    }
    if (initial.enduranceStatus !== "active" || initial.bodyCount !== 32) {
      throw new Error(
        `endurance workload was not ready: status ${initial.enduranceStatus ?? "<missing>"}, bodies ${initial.bodyCount}`,
      );
    }
    if (initial.universeCanvasError) throw new Error("universe canvas failed during endurance setup");
    if (initial.transportAction !== "Pause simulation") {
      throw new Error(`simulation was not running: ${initial.transportAction ?? "no transport status"}`);
    }
    enduranceState.startedAt = new Date();
    recordEnduranceSample(initial, 0);
    const deadline = enduranceState.startedAt.getTime() + enduranceSeconds * 1_000;

    const poll = async () => {
      if (automationFinished) return;
      try {
        const snapshot = await readRendererSnapshot(window);
        const elapsedSeconds = (Date.now() - enduranceState.startedAt.getTime()) / 1_000;
        recordEnduranceSample(snapshot, elapsedSeconds);

        if (snapshot.recoveryMode) throw new Error("renderer entered recovery mode");
        if (snapshot.alert) throw new Error(`simulation alert: ${snapshot.alert}`);
        if (snapshot.enduranceStatus !== "active" || snapshot.bodyCount !== 32) {
          throw new Error(
            `endurance workload changed: status ${snapshot.enduranceStatus ?? "<missing>"}, bodies ${snapshot.bodyCount}`,
          );
        }
        if (snapshot.universeCanvasError) throw new Error("universe canvas reported a render failure");
        if (snapshot.errors.length > 0) throw new Error(`renderer error: ${snapshot.errors.at(-1)}`);
        if (snapshot.transportAction !== "Pause simulation") {
          throw new Error(`simulation stopped running: ${snapshot.transportAction ?? "no transport status"}`);
        }
        if (enduranceState.consecutiveProgressStalls >= ENDURANCE_STALL_LIMIT) {
          throw new Error(`simulation time did not advance for ${ENDURANCE_STALL_LIMIT} polls`);
        }
        if (enduranceState.consecutiveHeartbeatStalls >= ENDURANCE_STALL_LIMIT) {
          throw new Error(`renderer animation did not advance for ${ENDURANCE_STALL_LIMIT} polls`);
        }

        if (Date.now() >= deadline) {
          const passed = enduranceState.progressChanges > 0 && enduranceState.heartbeatChanges > 0;
          finishEnduranceTest(
            passed,
            passed ? "renderer stayed responsive and the simulation kept advancing" : "no measurable simulation progress",
          );
          return;
        }
        endurancePollTimer = setTimeout(() => void poll(), 1_000);
      } catch (error) {
        finishEnduranceTest(false, error instanceof Error ? error.message : String(error));
      }
    };

    endurancePollTimer = setTimeout(() => void poll(), 1_000);
  } catch (error) {
    finishEnduranceTest(false, error instanceof Error ? error.message : String(error));
  }
}

function beginAutomation(window) {
  if (automationStarted || automationFinished) return;
  automationStarted = true;
  if (commandLineError) {
    failAutomatedTest(commandLineError);
    return;
  }
  if (smokeTest) {
    void runSmokeTest(window);
  } else if (enduranceTest) {
    void runEnduranceTest(window);
  }
}

function createWindow() {
  const window = new BrowserWindow({
    title: "Aphelion Gravity Lab",
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#020202",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: !automatedTest,
      devTools: !app.isPackaged,
    },
  });

  window.removeMenu();
  window.once("ready-to-show", () => {
    if (enduranceTest) {
      // A genuinely visible renderer exercises the normal animation/rendering
      // cadence. Chromium intentionally reduces requestAnimationFrame for a
      // never-shown window even when timer throttling is disabled.
      window.showInactive();
    } else if (!smokeTest) {
      window.show();
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  window.webContents.on("will-navigate", (event, url) => {
    if (!isLocalRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame === false || code === -3) return;
    writeDiagnostic(`renderer load failed: ${code} / ${description} / ${validatedUrl}`);
    if (automatedTest) failAutomatedTest(`renderer load failed: ${code} ${description}`);
  });
  window.webContents.on("did-finish-load", () => {
    scheduleHealthyRecoveryReset(window);
    beginAutomation(window);
  });
  window.webContents.on("console-message", (_event, ...arguments_) => {
    const details = arguments_.length === 1 && typeof arguments_[0] === "object"
      ? arguments_[0]
      : { level: arguments_[0], message: arguments_[1] };
    const errorLevel = details.level === "error" || details.level === 3;
    if (!errorLevel) return;
    const message = String(details.message ?? "renderer console error");
    if (isBenignRendererConsoleMessage(message)) return;
    writeDiagnostic(`renderer console error: ${message}`);
    enduranceState.rendererErrors.push(message);
    if (automatedTest) failAutomatedTest(`renderer console error: ${message}`);
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    writeDiagnostic(`renderer stopped: ${details.reason} / exit ${details.exitCode}`);
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    enduranceState.renderProcessGoneEvents += 1;
    if (details.reason === "clean-exit" || window.isDestroyed() || isQuitting) return;
    if (automatedTest) {
      failAutomatedTest(`renderer stopped: ${details.reason} / exit ${details.exitCode}`);
      return;
    }
    recoverRenderer(window, `renderer ${details.reason}`);
  });

  window.on("unresponsive", () => {
    writeDiagnostic("renderer became unresponsive");
    enduranceState.unresponsiveEvents += 1;
    if (healthyRecoveryTimer) clearTimeout(healthyRecoveryTimer);
    healthyRecoveryTimer = null;
    if (automatedTest) {
      failAutomatedTest("renderer became unresponsive");
      return;
    }
    if (isQuitting || window.isDestroyed() || unresponsiveTimer) return;
    unresponsiveTimer = setTimeout(() => {
      unresponsiveTimer = null;
      if (isQuitting || window.isDestroyed()) return;
      writeDiagnostic("renderer remained unresponsive; terminating it for recovery");
      try {
        window.webContents.forcefullyCrashRenderer();
      } catch (error) {
        writeDiagnostic(`renderer termination failed: ${error instanceof Error ? error.message : String(error)}`);
        recoverRenderer(window, "unresponsive renderer termination failure");
      }
    }, UNRESPONSIVE_GRACE_MS);
  });
  window.on("responsive", () => {
    writeDiagnostic("renderer became responsive again");
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = null;
    scheduleHealthyRecoveryReset(window);
  });
  window.on("closed", () => {
    clearWindowTimers();
    if (mainWindow === window) mainWindow = null;
  });

  void loadRenderer(window);
  return window;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (smokeTest) {
    automationTimeout = setTimeout(() => finishSmokeTest(1, "SMOKE FAIL: startup timeout"), 30_000);
  } else if (enduranceTest && enduranceSeconds) {
    automationTimeout = setTimeout(
      () => finishEnduranceTest(false, "endurance test exceeded its overall timeout"),
      (enduranceSeconds + 20) * 1_000,
    );
  }
  mainWindow = createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  clearWindowTimers();
  clearAutomationTimers();
});

app.on("second-instance", () => {
  if (automatedTest || !mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("window-all-closed", () => app.quit());
app.on("child-process-gone", (_event, details) => {
  writeDiagnostic(`child process stopped: ${details.type} / ${details.reason} / exit ${details.exitCode}`);
  if (automatedTest && details.reason !== "clean-exit") {
    failAutomatedTest(`child process stopped: ${details.type} / ${details.reason}`);
  }
});

process.on("uncaughtException", (error) => {
  writeDiagnostic(`main exception: ${error.stack ?? error.message}`);
  if (automatedTest) {
    failAutomatedTest(`main exception: ${error.message}`);
  } else {
    isQuitting = true;
    app.exit(1);
  }
});

process.on("unhandledRejection", (reason) => {
  writeDiagnostic(`main rejection: ${String(reason)}`);
  if (automatedTest) {
    failAutomatedTest(`main rejection: ${String(reason)}`);
  } else {
    isQuitting = true;
    app.exit(1);
  }
});
