/* =========================================
   ΚΕΝΤΡΙΚΗ ΛΟΓΙΚΗ ΕΡΓΑΤΗ (worker.js) - FINAL WITH ADVANCED LOCK & UNDO
========================================= */

if (localStorage.getItem('worker_logged_in') !== 'true') {
    alert("🔒 ACCESS DENIED: This tablet is not authorized. Redirecting to Portal...");
    window.location.href = 'index.html';
}

const SERVER_URL = "https://my-factory-server.onrender.com";

const STATION_NAMES = {
    "1": "Line 1", "2": "Line 2", "3": "Line 3",
    "4": "Line 4", "5": "Pouch", "6": "Powder Room"
};

let activeJobId = null; let jobsDatabase = {};
let allStationsGlobalData = JSON.parse(localStorage.getItem('all_stations_global_db')) || {};
let globalData = { shiftTotal: 0, chartLabels: [], chartData: [], hourCounter: 0 };

let stationId = "1"; let globalShiftTarget = 0; let localMessageRead = true; let activeMessageInterval = null;
let radioWasPlayingBeforeMsg = false; let alertStateMachine = 0; 
let batchSize, prodPerBox, boxesPerLayer, layersPerPallet, startingProducts;
let productsPerPallet, totalPalletsNeeded, initialJobBoxesLock = 0;

const TIME_30_MIN = 30 * 60, TIME_1_HOUR = 60 * 60;
let timer1Remaining = TIME_30_MIN, timer2Remaining = TIME_1_HOUR;
let timer1EndTime, timer2EndTime, isRunning = false, isAlarmActive = false;
let countdownInterval, alarmInterval, alarmMessage = "", wasRadioPlayingBeforeAlarm = false;

let hasEnglishVoice = true, previousTotalProducts = null, lastCalculatedBoxes = null, lastCalculatedLoose = null;
let chartInstance = null, savedLogsArray = [];

// 🔥 ΝΕΟ: ΜΝΗΜΗ SNAPSHOT ΓΙΑ ΤΗΝ ΛΕΙΤΟΥΡΓΙΑ ΑΝΑΙΡΕΣΗΣ (UNDO)
let lastHourlySnapshot = null; 

const display1 = document.getElementById('display1'), display2 = document.getElementById('display2');
const startPauseBtn = document.getElementById('startPauseBtn'), dismissBtn = document.getElementById('dismissBtn');
const radioAudio = document.getElementById('radioAudio'), radioBtn = document.getElementById('radioBtn');
const stationSelector = document.getElementById('stationSelector'), voiceSelector = document.getElementById('voiceSelector'), voiceIndicator = document.getElementById('voiceIndicator');
const logList = document.getElementById('logList');

function updateLocalStationId() { stationId = document.getElementById('setupStationId').value; localStorage.setItem('my_dedicated_station_id', stationId); }
function getCurrentShift() { let hour = new Date().getHours(); if (hour >= 6 && hour < 14) return "Morning Shift"; if (hour >= 14 && hour < 22) return "Afternoon Shift"; return "Night Shift"; }

function sendSyncToServer(isOffline = false) {
    if (!SERVER_URL || !SERVER_URL.includes("http")) return;
    let hpElement = document.getElementById('hiddenPalletsCount');
    let currentJobPallets = hpElement ? parseInt(hpElement.textContent) || 0 : 0;
    let totalShiftPallets = (globalData.shiftPallets || 0) + currentJobPallets; 
    let bNum = (activeJobId && jobsDatabase[activeJobId]) ? jobsDatabase[activeJobId].batchNumber : "-";
    let currentJobTotal = (activeJobId && jobsDatabase[activeJobId]) ? (jobsDatabase[activeJobId].lastSyncedTotal || 0) : 0;

    if (isOffline || !activeJobId) {
        fetch(`${SERVER_URL}/api/update_station`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ station_id: stationId, status: "Offline", batch_number: bNum, job_total: 0, job_pallets: 0, shift_total: globalData.shiftTotal, shift_pallets: totalShiftPallets }) }).catch(e => {}); return;
    }
    fetch(`${SERVER_URL}/api/update_station`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ station_id: stationId, status: "Online", batch_number: bNum, job_total: currentJobTotal, job_pallets: currentJobPallets, shift_total: globalData.shiftTotal, shift_pallets: totalShiftPallets }) }).catch(e => {});
}

function refreshSavedJobsUI() {
    const listDiv = document.getElementById('savedJobsList'); let stored = localStorage.getItem('dashboard_production_jobs_db'); jobsDatabase = stored ? JSON.parse(stored) : {}; let keys = Object.keys(jobsDatabase);
    if (keys.length === 0) { listDiv.innerHTML = `<div style="color: #6c7086; font-style: italic; text-align: center; padding: 10px;">No saved jobs found. Create one below.</div>`; return; }
    listDiv.innerHTML = "";
    keys.forEach(id => {
        let job = jobsDatabase[id]; let row = document.createElement('div'); row.className = 'job-item-row'; let sName = STATION_NAMES[job.stationId] || "Unknown";
        row.innerHTML = `<div class="job-info-text" onclick="loadSelectedJob('${id}')">💼 [${sName}] Batch: ${job.batchNumber} | Target: ${job.batchSize.toLocaleString()} Pcs</div><button class="btn-danger" onclick="deleteJobFromDatabase('${id}', event)">Delete</button>`;
        listDiv.appendChild(row);
    });
}

async function createNewJobConfiguration() {
    let bNumInput = document.getElementById('setupBatchNumber').value.trim(); let bSzInput = document.getElementById('setupBatchSize').value; let pBxInput = document.getElementById('setupProdPerBox').value; let bLyInput = document.getElementById('setupBoxesPerLayer').value; let lPlInput = document.getElementById('setupLayersPerPallet').value;
    if (bNumInput === "") { alert("⚠️ ERROR: Please enter the Batch Number!"); return; }
    if (!bSzInput || parseInt(bSzInput) <= 0) { alert("⚠️ ERROR: Invalid Batch Size!"); return; }
    let stId = document.getElementById('setupStationId').value; let sName = STATION_NAMES[stId] || "Unknown";

    if (SERVER_URL && SERVER_URL.includes("http")) {
        try {
            const res = await fetch(`${SERVER_URL}/api/get_supervisor_data`); const serverData = await res.json();
            if (serverData[stId] && serverData[stId].status === "Online") {
                let override = confirm(`⚠️ STATION BUSY: ${sName} is already ONLINE running Batch: ${serverData[stId].batch_number}.\n\nDo you want to FORCE OVERRIDE and take over this station?`);
                if (!override) return; 
            }
        } catch(e) {}
    }

    let id = 'job_' + Date.now(); let now = new Date(); let timestamp = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} - ${now.toLocaleDateString()}`;
    stationId = stId; let bNum = bNumInput; let bSz = parseInt(bSzInput); let pBx = parseInt(pBxInput); let bLy = parseInt(bLyInput); let lPl = parseInt(lPlInput); let sPr = Math.max(0, parseInt(document.getElementById('setupStartingProd').value) || 0);
    let customStr = document.getElementById('setupCustomPallets').value; let customPos = document.getElementById('setupCustomPos').value; let customArr = [];
    if (customStr.trim() !== "") { customArr = customStr.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n) && n > 0); }
    let initialBoxes = sPr > 0 ? Math.floor(sPr / pBx) : 0; let initialLoose = sPr > 0 ? sPr % pBx : 0; let initialTotal = (initialBoxes * pBx) + initialLoose;

    jobsDatabase[id] = { id: id, createdTime: timestamp, stationId: stId, batchNumber: bNum, batchSize: bSz, prodPerBox: pBx, boxesPerLayer: bLy, layersPerPallet: lPl, startingProducts: sPr, customPallets: customArr, customPos: customPos, previousTotalProducts: initialTotal, lastCalculatedBoxes: initialBoxes, lastCalculatedLoose: initialLoose, currentBoxesVal: initialBoxes > 0 ? initialBoxes : "", currentLooseVal: initialLoose, initialJobBoxesLock: initialBoxes, lastSyncedTotal: initialTotal, timer1State: TIME_30_MIN, timer2State: TIME_1_HOUR, logs: [{ stamp: `[${timestamp.split(' - ')[0]}]`, text: `New Job Created on ${sName}.`, type: `check` }] };
    document.getElementById('setupBatchNumber').value = ""; document.getElementById('setupCustomPallets').value = ""; saveDatabaseToStorage(); loadSelectedJob(id);
}

function updateJobProgressUI(currentTotalProducts) {
    if (!batchSize || batchSize <= 0) return;
    let percentage = (currentTotalProducts / batchSize) * 100; let difference = currentTotalProducts - batchSize;
    let pctEl = document.getElementById('ui-progress-pct'); let diffEl = document.getElementById('ui-progress-diff'); if (!pctEl || !diffEl) return;
    pctEl.textContent = percentage.toFixed(2) + "%";
    if (difference < 0) { diffEl.textContent = difference; diffEl.style.color = "#f38ba8"; pctEl.style.color = "#f38ba8"; } else { diffEl.textContent = "+" + difference; diffEl.style.color = "#a6e3a1"; pctEl.style.color = "#a6e3a1"; }
}

function loadSelectedJob(id) {
    activeJobId = id; let job = jobsDatabase[id]; stationId = job.stationId || "1"; globalData = allStationsGlobalData[stationId] || { shiftTotal: 0, chartLabels: [], chartData: [], hourCounter: 0 };
    document.getElementById('setupStationId').value = stationId; document.getElementById('activeStationDisplay').textContent = `${STATION_NAMES[stationId]} | ${getCurrentShift()}`; document.getElementById('specBatchNumber').textContent = job.batchNumber || "-";
    batchSize = job.batchSize; prodPerBox = job.prodPerBox; boxesPerLayer = job.boxesPerLayer; layersPerPallet = job.layersPerPallet; startingProducts = job.startingProducts; previousTotalProducts = job.previousTotalProducts || 0; lastCalculatedBoxes = job.lastCalculatedBoxes; lastCalculatedLoose = job.lastCalculatedLoose; initialJobBoxesLock = job.initialJobBoxesLock || 0; savedLogsArray = [...job.logs];
    productsPerPallet = boxesPerLayer * layersPerPallet * prodPerBox;
    let customArr = job.customPallets || []; let customPos = job.customPos || "end"; let sumCustom = customArr.reduce((a, b) => a + b, 0); let standardPcs = Math.max(0, batchSize - sumCustom); let sequence = [];
    while (standardPcs > 0) { if (standardPcs >= productsPerPallet) { sequence.push(productsPerPallet); standardPcs -= productsPerPallet; } else { sequence.push(standardPcs); standardPcs = 0; } }
    if (customPos === "start") job.palletSequence = customArr.concat(sequence); else job.palletSequence = sequence.concat(customArr);
    let standardDecimalPallets = Math.max(0, batchSize - sumCustom) / productsPerPallet; let exactPallets = (customArr.length + standardDecimalPallets).toFixed(2); let exactBoxes = (batchSize / prodPerBox).toFixed(1).replace('.0', '');
    document.getElementById('specBatchSize').textContent = batchSize.toLocaleString(); document.getElementById('specProdPerBox').textContent = prodPerBox; document.getElementById('specBoxesPerLayer').textContent = boxesPerLayer; document.getElementById('specLayersPerPallet').textContent = layersPerPallet; document.getElementById('specUnitsPerPallet').textContent = productsPerPallet.toLocaleString(); document.getElementById('specStartingProd').textContent = startingProducts.toLocaleString();
    document.getElementById('currentBoxes').value = job.currentBoxesVal; document.getElementById('currentLoose').value = job.currentLooseVal; document.getElementById('resTargetPallets').textContent = `${exactPallets} Plts | ${exactBoxes} Bxs | ${batchSize.toLocaleString()} Pcs`; document.getElementById('resPrevTotal').textContent = previousTotalProducts;
    let initialCalculatedTotal = job.lastSyncedTotal || 0; document.getElementById('resNewTotal').textContent = initialCalculatedTotal; document.getElementById('resDifference').textContent = "0"; document.getElementById('resShiftTotal').textContent = globalData.shiftTotal;
    document.getElementById('setupScreen').style.display = 'none'; document.getElementById('mainDashboard').style.display = 'block';
    initChart(); updatePalletFills(initialCalculatedTotal); updateJobProgressUI(initialCalculatedTotal); updateShiftGoalUI(globalData.shiftTotal);
    logList.innerHTML = "";
    savedLogsArray.forEach(logItem => {
        let li = document.createElement('li');
        if (typeof logItem === 'string') { li.className = "log-item"; li.innerHTML = `<span style="color:#6c7086">${logItem.substring(0,10)}</span><span>${logItem.substring(10)}</span>`; } else { li.className = `log-item ${logItem.type}`; li.innerHTML = `<span style="color:#6c7086">${logItem.stamp}</span> <span>${logItem.text}</span>`; }
        logList.insertBefore(li, logList.firstChild);
    });
    timer1Remaining = job.timer1State !== undefined ? job.timer1State : TIME_30_MIN; timer2Remaining = job.timer2State !== undefined ? job.timer2State : TIME_1_HOUR; isRunning = false; updateDisplays(); startPauseBtn.textContent = "Start Timers";
    sendSyncToServer(false);
}

function saveActiveJobState() {
    if (!activeJobId || !jobsDatabase[activeJobId]) return;
    let curB = document.getElementById('currentBoxes').value; let curL = Math.max(0, parseInt(document.getElementById('currentLoose').value) || 0);
    jobsDatabase[activeJobId].previousTotalProducts = previousTotalProducts; jobsDatabase[activeJobId].lastCalculatedBoxes = lastCalculatedBoxes; jobsDatabase[activeJobId].lastCalculatedLoose = lastCalculatedLoose; jobsDatabase[activeJobId].currentBoxesVal = curB; jobsDatabase[activeJobId].currentLooseVal = curL; jobsDatabase[activeJobId].logs = [...savedLogsArray];
    let t1 = timer1Remaining, t2 = timer2Remaining; if (isRunning) { let now = Date.now(); t1 = Math.max(0, Math.ceil((timer1EndTime - now) / 1000)); t2 = Math.max(0, Math.ceil((timer2EndTime - now) / 1000)); }
    jobsDatabase[activeJobId].timer1State = t1; jobsDatabase[activeJobId].timer2State = t2; saveDatabaseToStorage(); allStationsGlobalData[stationId] = globalData; localStorage.setItem('all_stations_global_db', JSON.stringify(allStationsGlobalData));
}

function saveDatabaseToStorage() { localStorage.setItem('dashboard_production_jobs_db', JSON.stringify(jobsDatabase)); }
function deleteJobFromDatabase(id, event) { event.stopPropagation(); if (confirm("Are you sure?")) { if (activeJobId === id) { exitToJobList(); } delete jobsDatabase[id]; saveDatabaseToStorage(); refreshSavedJobsUI(); } }

function exitToJobList() {
    if (isRunning) toggleTimers();
    if (isAlarmActive) { isAlarmActive = false; clearInterval(alarmInterval); window.speechSynthesis.cancel(); dismissBtn.style.display = 'none'; if (wasRadioPlayingBeforeAlarm) { startRadio(); wasRadioPlayingBeforeAlarm = false; } }
    saveActiveJobState(); activeJobId = null; sendSyncToServer(true); if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    document.getElementById('mainDashboard').style.display = 'none'; document.getElementById('setupScreen').style.display = 'flex'; refreshSavedJobsUI();
}

function finishJobAndReport() {
    if(!confirm("Are you sure you want to Finish?")) return;
    let job = jobsDatabase[activeJobId]; let hpElement = document.getElementById('hiddenPalletsCount');
    let reportData = { station_name: STATION_NAMES[job.stationId], batch_number: job.batchNumber, batch_target: job.batchSize, total_produced: job.lastSyncedTotal, completed_pallets: hpElement ? parseInt(hpElement.textContent) || 0 : 0, prod_per_box: job.prodPerBox, boxes_per_layer: job.boxesPerLayer, layers_per_pallet: job.layersPerPallet, starting_products: job.startingProducts, hourly_labels: globalData.chartLabels, hourly_data: globalData.chartData, logs: job.logs };
    if (SERVER_URL && SERVER_URL.includes("http")) {
        fetch(`${SERVER_URL}/api/save_report`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(reportData) })
        .then(response => { if (!response.ok) throw new Error("Failed"); return response.json(); })
        .then(() => { delete jobsDatabase[activeJobId]; saveDatabaseToStorage(); exitToJobList(); alert("✅ Report Saved!"); })
        .catch(e => alert("❌ Database Error. Saved locally. Try again."));
    }
}

function updatePalletFills(currentTotal) {
    let valCompleted = document.getElementById('val_completed'); let valRemaining = document.getElementById('val_remaining'); let boxRemaining = document.getElementById('box_remaining'); let activeIcon = document.getElementById('pIcon_active'); let pctText = document.getElementById('pPct_active'); if (!valCompleted || !valRemaining || !activeIcon) return;
    let job = jobsDatabase[activeJobId]; let seq = job.palletSequence || []; let totalPalletsTarget = seq.length; let tempTotal = currentTotal; let completedPallets = 0; let activePalletSize = productsPerPallet;
    for (let i = 0; i < seq.length; i++) { if (tempTotal >= seq[i]) { completedPallets++; tempTotal -= seq[i]; } else { activePalletSize = seq[i]; break; } }
    let inactivePallets = 0; let pct = 0;
    if (currentTotal < batchSize) { let remainingWholePallets = totalPalletsTarget - completedPallets - 1; if (remainingWholePallets < 0) remainingWholePallets = 0; let activePalletRemainingFraction = (activePalletSize - tempTotal) / activePalletSize; inactivePallets = remainingWholePallets + activePalletRemainingFraction; pct = Math.floor((tempTotal / activePalletSize) * 100); }
    valCompleted.textContent = completedPallets;
    if (currentTotal >= batchSize) { let extra = currentTotal - batchSize; activeIcon.className = "pallet-icon full"; activeIcon.style.setProperty('--fill-level', '100%'); pctText.textContent = "100%"; pctText.style.color = "#a6e3a1"; boxRemaining.style.borderColor = "#a6e3a1"; valRemaining.style.color = "#a6e3a1"; if (extra > 0) { valRemaining.style.fontSize = "1.2rem"; valRemaining.innerHTML = `DONE<br><span style="font-size:0.9rem; color:#f9e2af;">+${extra} EXTRA</span>`; } else { valRemaining.style.fontSize = "1.8rem"; valRemaining.textContent = "DONE"; } } 
    else { activeIcon.className = "pallet-icon"; activeIcon.style.setProperty('--fill-level', `${pct}%`); pctText.textContent = `${pct}%`; pctText.style.color = "#fab387"; boxRemaining.style.borderColor = "#45475a"; valRemaining.style.color = "#a6adc8"; valRemaining.style.fontSize = "2.2rem"; valRemaining.textContent = Number(inactivePallets.toFixed(2)); }
    let hpElement = document.getElementById('hiddenPalletsCount'); if(hpElement) hpElement.textContent = completedPallets;
}

function updateShiftGoalUI(currentShiftProducts) {
    document.getElementById('displayShiftCurrent').textContent = currentShiftProducts.toLocaleString(); document.getElementById('displayShiftTarget').textContent = globalShiftTarget.toLocaleString();
    let pct = 0; if(globalShiftTarget > 0) pct = Math.min(100, Math.floor((currentShiftProducts / globalShiftTarget) * 100));
    const bar = document.getElementById('shiftProgressBar'); bar.style.width = `${pct}%`; bar.textContent = `${pct}%`; bar.style.backgroundColor = pct >= 100 ? "#a6e3a1" : "#89b4fa";
}

function initChart() { const ctx = document.getElementById('hourlyChart').getContext('2d'); if(chartInstance) chartInstance.destroy(); chartInstance = new Chart(ctx, { type: 'bar', data: { labels: globalData.chartLabels, datasets: [{ label: 'Hourly Units', data: globalData.chartData, backgroundColor: '#fab387', borderColor: '#fab387', borderWidth: 1 }] }, options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, grid: { color: '#313244' }, ticks: { color: '#cdd6f4' } }, x: { grid: { display: false }, ticks: { color: '#cdd6f4' } } }, plugins: { legend: { display: false } } } }); }
function checkBoxesChange() { let currentBoxesInput = document.getElementById('currentBoxes').value; if (currentBoxesInput === "") return; let currentBoxes = Math.max(0, parseInt(currentBoxesInput) || 0); if (lastCalculatedBoxes !== null && currentBoxes > lastCalculatedBoxes) document.getElementById('currentLoose').value = "0"; }

function updateLiveProgress() {
    if (!activeJobId) return; let currentBoxesInput = document.getElementById('currentBoxes').value; if (currentBoxesInput === "") return;
    let currentBoxes = Math.max(0, parseInt(currentBoxesInput) || 0); let looseProducts = Math.max(0, parseInt(document.getElementById('currentLoose').value) || 0); let currentTotalProducts = (currentBoxes * prodPerBox) + looseProducts;
    let lastSynced = jobsDatabase[activeJobId].lastSyncedTotal || 0; let deltaTotal = currentTotalProducts - lastSynced; globalData.shiftTotal += deltaTotal;
    updatePalletFills(currentTotalProducts); updateJobProgressUI(currentTotalProducts);
    document.getElementById('resNewTotal').textContent = currentTotalProducts; document.getElementById('resShiftTotal').textContent = globalData.shiftTotal; updateShiftGoalUI(globalData.shiftTotal);
    jobsDatabase[activeJobId].currentBoxesVal = currentBoxes; jobsDatabase[activeJobId].currentLooseVal = looseProducts; jobsDatabase[activeJobId].lastSyncedTotal = currentTotalProducts; saveDatabaseToStorage();
    allStationsGlobalData[stationId] = globalData; localStorage.setItem('all_stations_global_db', JSON.stringify(allStationsGlobalData)); sendSyncToServer(false);
    addLogEntry(`> Live Sync: Display updated to ${currentTotalProducts} pcs`, 'sync');
}

// 🔥 ΑΝΑΒΑΘΜΙΣΜΕΝΟ HOURLY BOOKING ΜΕ SNAPSHOT ΓΙΑ UNDO & AUTOMATIC TIMEOUT RESET 🔥
function calculateProduction() {
    if (!activeJobId) return;
    let currentBoxesInput = document.getElementById('currentBoxes').value;
    if (currentBoxesInput === "") return;

    // ↩️ ΚΡΑΤΑΕΙ SNAPSHOT ΤΩΝ ΔΕΔΟΜΕΝΩΝ ΠΡΙΝ ΤΗΝ ΕΓΓΡΑΦΗ ΓΙΑ ΤΟ UNDO
    lastHourlySnapshot = {
        shiftTotal: globalData.shiftTotal,
        hourCounter: globalData.hourCounter,
        chartLabels: [...globalData.chartLabels],
        chartData: [...globalData.chartData],
        previousTotalProducts: previousTotalProducts,
        lastCalculatedBoxes: lastCalculatedBoxes,
        lastCalculatedLoose: lastCalculatedLoose,
        logsCount: savedLogsArray.length
    };
    if(document.getElementById('undoHourlyBtn')) document.getElementById('undoHourlyBtn').style.display = 'inline-block';

    let currentBoxes = Math.max(0, parseInt(currentBoxesInput) || 0); 
    let looseProducts = Math.max(0, parseInt(document.getElementById('currentLoose').value) || 0);
    
    if (lastCalculatedBoxes !== null && lastCalculatedBoxes === currentBoxes && lastCalculatedLoose === looseProducts && globalData.hourCounter > 0) return;
    
    let currentTotalProducts = (currentBoxes * prodPerBox) + looseProducts; 
    let hourlyDifference = currentTotalProducts - previousTotalProducts;
    let lastSynced = jobsDatabase[activeJobId].lastSyncedTotal || 0; 
    let deltaTotal = currentTotalProducts - lastSynced; 
    globalData.shiftTotal += deltaTotal;
    
    updatePalletFills(currentTotalProducts); 
    updateJobProgressUI(currentTotalProducts);
    
    document.getElementById('resPrevTotal').textContent = previousTotalProducts; 
    document.getElementById('resNewTotal').textContent = currentTotalProducts; 
    document.getElementById('resDifference').textContent = hourlyDifference >= 0 ? "+" + hourlyDifference : hourlyDifference; 
    document.getElementById('resShiftTotal').textContent = globalData.shiftTotal; 
    updateShiftGoalUI(globalData.shiftTotal);
    
    globalData.hourCounter++; 
    globalData.chartLabels.push(`Hour ${globalData.hourCounter}`); 
    globalData.chartData.push(hourlyDifference); 
    chartInstance.update();
    
    let diffStr = hourlyDifference >= 0 ? "+" + hourlyDifference : hourlyDifference;
    addLogEntry(`Hourly Booked -> Prev: ${previousTotalProducts} | New: ${currentTotalProducts} | Hourly Diff: ${diffStr}`, 'calc');
    
    lastCalculatedBoxes = currentBoxes; 
    lastCalculatedLoose = looseProducts; 
    previousTotalProducts = currentTotalProducts;
    
    jobsDatabase[activeJobId].currentBoxesVal = currentBoxes; 
    jobsDatabase[activeJobId].currentLooseVal = looseProducts; 
    jobsDatabase[activeJobId].lastSyncedTotal = currentTotalProducts; 
    saveActiveJobState();
    
    allStationsGlobalData[stationId] = globalData; 
    localStorage.setItem('all_stations_global_db', JSON.stringify(allStationsGlobalData)); 

    // ⏳ ΕΠΑΝΕΚΚΙΝΗΣΗ ΧΡΟΝΟΜΕΤΡΟΥ ΩΣΤΕ ΝΑ ΞΑΝΑ-ΚΛΕΙΔΩΣΕΙ (DISABLE) ΑΥΤΟΜΑΤΑ
    if (isRunning) {
        timer2EndTime = Date.now() + (TIME_1_HOUR * 1000);
    }
    timer2Remaining = TIME_1_HOUR;
    updateDisplays();

    sendSyncToServer(false);
}

// 🔥 ΝΕΑ ΣΥΝΑΡΤΗΣΗ: ΛΕΙΤΟΥΡΓΙΑ ΑΝΑΙΡΕΣΗΣ ΤΕΛΕΥΤΑΙΟΥ HOURLY ENTRY (UNDO) 🔥
function undoLastHourly() {
    if (!lastHourlySnapshot) return;
    if (!confirm("↩️ UNDO: Are you sure you want to delete the last hourly production entry from the chart?")) return;

    globalData.shiftTotal = lastHourlySnapshot.shiftTotal;
    globalData.hourCounter = lastHourlySnapshot.hourCounter;
    globalData.chartLabels = lastHourlySnapshot.chartLabels;
    globalData.chartData = lastHourlySnapshot.chartData;
    previousTotalProducts = lastHourlySnapshot.previousTotalProducts;
    lastCalculatedBoxes = lastHourlySnapshot.lastCalculatedBoxes;
    lastCalculatedLoose = lastHourlySnapshot.lastCalculatedLoose;

    while (savedLogsArray.length > lastHourlySnapshot.logsCount) {
        savedLogsArray.pop();
    }

    chartInstance.data.labels = globalData.chartLabels;
    chartInstance.data.datasets[0].data = globalData.chartData;
    chartInstance.update();

    let currentBoxes = Math.max(0, parseInt(document.getElementById('currentBoxes').value) || 0);
    let looseProducts = Math.max(0, parseInt(document.getElementById('currentLoose').value) || 0);
    let currentTotalNow = (currentBoxes * prodPerBox) + looseProducts;

    document.getElementById('resPrevTotal').textContent = previousTotalProducts;
    document.getElementById('resNewTotal').textContent = currentTotalNow;
    document.getElementById('resShiftTotal').textContent = globalData.shiftTotal;
    document.getElementById('resDifference').textContent = "0";

    logList.innerHTML = "";
    savedLogsArray.forEach(logItem => {
        let li = document.createElement('li'); li.className = `log-item ${logItem.type}`;
        li.innerHTML = `<span style="color:#6c7086">${logItem.stamp}</span> <span>${logItem.text}</span>`;
        logList.insertBefore(li, logList.firstChild);
    });

    updatePalletFills(currentTotalNow);
    updateJobProgressUI(currentTotalNow);
    updateShiftGoalUI(globalData.shiftTotal);

    if (jobsDatabase[activeJobId]) {
        jobsDatabase[activeJobId].previousTotalProducts = previousTotalProducts;
        jobsDatabase[activeJobId].lastCalculatedBoxes = lastCalculatedBoxes;
        jobsDatabase[activeJobId].lastCalculatedLoose = lastCalculatedLoose;
        jobsDatabase[activeJobId].lastSyncedTotal = currentTotalNow;
        jobsDatabase[activeJobId].logs = [...savedLogsArray];
    }
    saveActiveJobState();
    sendSyncToServer(false);

    lastHourlySnapshot = null;
    if(document.getElementById('undoHourlyBtn')) document.getElementById('undoHourlyBtn').style.display = 'none';
    addLogEntry("↩️ Action Undone: Last Hourly log removed.", "check");
}

async function pollSupervisorTarget() {
    if(!stationId) return;
    try {
        const res = await fetch(`${SERVER_URL}/api/get_supervisor_data`); const data = await res.json();
        if(data[stationId]) {
            if (data[stationId].reset_flag === true) {
                globalData = { shiftTotal: 0, chartLabels: [], chartData: [], hourCounter: 0 }; allStationsGlobalData[stationId] = globalData; localStorage.setItem('all_stations_global_db', JSON.stringify(allStationsGlobalData));
                if(activeJobId) {
                    document.getElementById('resShiftTotal').textContent = "0"; updateShiftGoalUI(0);
                    if (chartInstance) { chartInstance.data.labels = []; chartInstance.data.datasets[0].data = []; chartInstance.update(); }
                    addLogEntry("⚠️ Shift Data Reset remotely by Supervisor!", "check");
                    let currentTotalNow = (Math.max(0, parseInt(document.getElementById('currentBoxes').value) || 0) * prodPerBox) + Math.max(0, parseInt(document.getElementById('currentLoose').value) || 0);
                    jobsDatabase[activeJobId].lastSyncedTotal = currentTotalNow; jobsDatabase[activeJobId].previousTotalProducts = currentTotalNow; saveDatabaseToStorage(); sendSyncToServer(false);
                }
                fetch(`${SERVER_URL}/api/ack_reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ station_id: stationId }) }).catch(e => {});
            }
            if (!activeJobId) return; globalShiftTarget = data[stationId].shift_target || 0; updateShiftGoalUI(globalData.shiftTotal);
            let sMsg = data[stationId].supervisor_message; let isRead = data[stationId].message_read;
            if (sMsg !== "" && !isRead && localMessageRead) { localMessageRead = false; triggerSupervisorMessage(sMsg); }
            let serverAcked = data[stationId].alert_acknowledged;
            if (alertStateMachine === 1 && serverAcked === false) { alertStateMachine = 2; } else if (alertStateMachine === 2 && serverAcked === true) { alertStateMachine = 0; playAckVoice(); }
        }
    } catch(e) {}
}

setInterval(pollSupervisorTarget, 4000); pollSupervisorTarget();

function sendHelpAlert(type) {
    if (!stationId) return;
    let note = prompt(`Enter a brief note for ${type} (optional):`) || "";
    let btnClassMap = { "Supervisor": ".call-supervisor", "QA": ".call-qa", "Engineer": ".call-eng" };
    let btnSelector = btnClassMap[type]; let btnElement = document.querySelector(btnSelector); let originalText = btnElement.textContent;
    btnElement.disabled = true; btnElement.textContent = `⏳ Sending...`; btnElement.style.opacity = "0.6";
    fetch(`${SERVER_URL}/api/send_alert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ station_id: stationId, alert: type, note: note }) })
    .then(response => { if (!response.ok) throw new Error("Failure"); return response.json(); })
    .then(data => { addLogEntry(`> Alert sent to ${type}. Delivered.`, 'check'); alertStateMachine = 1; btnElement.disabled = false; btnElement.textContent = originalText; btnElement.style.opacity = "1"; })
    .catch(error => { alert(`❌ NETWORK ERROR: Alert failed!`); btnElement.disabled = false; btnElement.textContent = `❌ Retry ${type}`; btnElement.style.opacity = "1"; });
}

function triggerSupervisorMessage(msgText) { document.getElementById('msgOverlay').style.display = 'flex'; document.getElementById('msgOverlayText').textContent = msgText; radioWasPlayingBeforeMsg = !radioAudio.paused; stopRadio(); let ttsText = `Message from Supervisor. ${msgText}.`; speakText(ttsText); activeMessageInterval = setInterval(() => { speakText(ttsText); }, 15000); }
function acknowledgeSupervisorMessage() { document.getElementById('msgOverlay').style.display = 'none'; clearInterval(activeMessageInterval); window.speechSynthesis.cancel(); localMessageRead = true; if (SERVER_URL && SERVER_URL.includes("http")) { fetch(`${SERVER_URL}/api/read_message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ station_id: stationId }) }).catch(e => {}); } if (radioWasPlayingBeforeMsg) { startRadio(); radioWasPlayingBeforeMsg = false; } }
function playAckVoice() { let wasRadio = !radioAudio.paused; stopRadio(); window.speechSynthesis.cancel(); let ut = new SpeechSynthesisUtterance("Your alert was acknowledged by the supervisor."); let v = window.speechSynthesis.getVoices().find(v => v.name === voiceSelector.value); if (v) ut.voice = v; ut.onend = function() { if (wasRadio) startRadio(); }; window.speechSynthesis.speak(ut); addLogEntry(`✓ Supervisor acknowledged your call!`, 'check'); }
function speakText(text) { if (!hasEnglishVoice) return; window.speechSynthesis.cancel(); let ut = new SpeechSynthesisUtterance(text); let v = window.speechSynthesis.getVoices().find(v => v.name === voiceSelector.value); if (v) ut.voice = v; window.speechSynthesis.speak(ut); }

async function loadRadioStations() {
    const stationSelector = document.getElementById('stationSelector'); stationSelector.innerHTML = "<option value=''>Loading UK stations...</option>";
    try {
        const response = await fetch('https://de1.api.radio-browser.info/json/stations/search?country=United%20Kingdom&limit=150&order=clickcount&reverse=true&https_only=true');
        const stations = await response.json(); stationSelector.innerHTML = "<option value=''>-- Select UK Station --</option>";
        stations.forEach(station => { if (station.url_resolved && station.name.trim() !== "") { let opt = document.createElement('option'); opt.value = station.url_resolved; opt.textContent = station.name.trim(); stationSelector.appendChild(opt); } });
        let savedRadio = localStorage.getItem('my_last_radio_url'); if (savedRadio && [...stationSelector.options].some(o => o.value === savedRadio)) { stationSelector.value = savedRadio; }
    } catch (error) {}
}

function loadAvailableVoices() {
    if (!('speechSynthesis' in window)) { hasEnglishVoice = false; voiceIndicator.style.backgroundColor = "#f38ba8"; return; }
    let voices = window.speechSynthesis.getVoices(); voiceSelector.innerHTML = "";
    if (voices.length === 0) { hasEnglishVoice = false; voiceIndicator.style.backgroundColor = "#f38ba8"; let opt = document.createElement('option'); opt.value = ""; opt.textContent = "Beep Active (No Voice)"; voiceSelector.appendChild(opt); return; }
    hasEnglishVoice = true; voiceIndicator.style.backgroundColor = "#a6e3a1";
    voices.forEach(v => { let opt = document.createElement('option'); opt.value = v.name; opt.textContent = `${v.name} (${v.lang})`; voiceSelector.appendChild(opt); });
    let savedVoice = localStorage.getItem('selected_work_voice'); if (savedVoice && voices.some(v => v.name === savedVoice)) { voiceSelector.value = savedVoice; } else { let ukVoice = voices.find(v => v.lang === 'en-GB' || v.name.includes('UK')); if (ukVoice) voiceSelector.value = ukVoice.name; }
}

function onVoiceChange() { localStorage.setItem('selected_work_voice', voiceSelector.value); if ('speechSynthesis' in window) { speakText("Voice test confirmed."); } }
function toggleRadio() { if (!radioAudio.paused) { stopRadio(); } else { startRadio(); } }
function startRadio() { let url = stationSelector.value; if (url) { radioAudio.src = url; radioAudio.play().catch(e => console.log(e)); radioBtn.textContent = "Stop"; radioBtn.style.backgroundColor = "#f38ba8"; localStorage.setItem('my_last_radio_url', url); } }
function stopRadio() { radioAudio.pause(); radioAudio.src = ""; radioBtn.textContent = "Play"; radioBtn.style.backgroundColor = "#b4befe"; }
function onStationChange() { if (!radioAudio.paused) { stopRadio(); startRadio(); } }
function formatTime(seconds, showHours = false) { if (isNaN(seconds) || seconds < 0) { seconds = 0; } let hrs = Math.floor(seconds / 3600), mins = Math.floor((seconds % 3600) / 60), secs = seconds % 60; let res = ""; if (showHours) res += (hrs < 10 ? "0" + hrs : hrs) + ":"; res += (mins < 10 ? "0" + mins : mins) + ":" + (secs < 10 ? "0" + secs : secs); return res; }

// 🔥 ΑΝΑΒΑΘΜΙΣΜΕΝΟ UPDATE DISPLAYS ΓΙΑ ΑΥΤΟΜΑΤΟ LOCK / UNLOCK ΤΟΥ HOURLY BUTTON 🔥
function updateDisplays() {
    if (isNaN(timer1Remaining)) timer1Remaining = TIME_30_MIN;
    if (isNaN(timer2Remaining)) timer2Remaining = TIME_1_HOUR;
    display1.textContent = formatTime(timer1Remaining, false);
    display2.textContent = formatTime(timer2Remaining, true);

    const hBtn = document.getElementById('hourlyBtn');
    if (hBtn) {
        if (!isRunning) {
            // Αν είναι σε ΠΑΥΣΗ, το κουμπί ξεκλειδώνει για να κλείσεις τη δουλειά στο τέλος της βάρδιας
            hBtn.disabled = false;
            hBtn.style.opacity = "1";
            hBtn.style.cursor = "pointer";
        } else {
            // Αν τρέχουν, ξεκλειδώνει ΜΟΝΟ αν ο χρόνος φτάσει στο 0 (00:00:00)
            if (timer2Remaining > 0) {
                hBtn.disabled = true;
                hBtn.style.opacity = "0.4";
                hBtn.style.cursor = "not-allowed";
            } else {
                hBtn.disabled = false;
                hBtn.style.opacity = "1";
                hBtn.style.cursor = "pointer";
            }
        }
    }
}

function toggleTimers() {
    if (isRunning) { isRunning = false; clearInterval(countdownInterval); let now = Date.now(); if (timer1Remaining > 0) timer1Remaining = Math.max(0, Math.ceil((timer1EndTime - now) / 1000)); if (timer2Remaining > 0) timer2Remaining = Math.max(0, Math.ceil((timer2EndTime - now) / 1000)); startPauseBtn.textContent = "Resume Timers"; saveActiveJobState(); } 
    else { isRunning = true; let now = Date.now(); if (isNaN(timer1Remaining) || timer1Remaining <= 0) timer1Remaining = TIME_30_MIN; if (isNaN(timer2Remaining) || timer2Remaining <= 0) timer2Remaining = TIME_1_HOUR; timer1EndTime = now + (timer1Remaining * 1000); timer2EndTime = now + (timer2Remaining * 1000); startPauseBtn.textContent = "Pause (Break)"; countdownInterval = setInterval(() => { let currentTime = Date.now(); let t1_ended = false, t2_ended = false; if (timer1Remaining > 0) { timer1Remaining = Math.max(0, Math.ceil((timer1EndTime - currentTime) / 1000)); if (timer1Remaining === 0) t1_ended = true; } if (timer2Remaining > 0) { timer2Remaining = Math.max(0, Math.ceil((timer2EndTime - currentTime) / 1000)); if (timer2Remaining === 0) t2_ended = true; } if (t1_ended || t2_ended) { if (isAlarmActive) { buildAlarmMessage(timer1Remaining === 0, timer2Remaining === 0); } else { triggerAlarm(t1_ended, t2_ended); } } updateDisplays(); }, 200); }
}

function playDigitalBeep() { try { let audioCtx = new (window.AudioContext || window.webkitAudioContext)(); let oscillator = audioCtx.createOscillator(); let gainNode = audioCtx.createGain(); oscillator.connect(gainNode); gainNode.connect(audioCtx.destination); oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime); oscillator.start(); gainNode.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.3); oscillator.stop(audioCtx.currentTime + 0.3); } catch (e) { console.log(e); } }
function triggerAlertSound() { if (!isAlarmActive) return; if (hasEnglishVoice && voiceSelector.value) { speakText(alarmMessage); } else { playDigitalBeep(); setTimeout(playDigitalBeep, 400); setTimeout(playDigitalBeep, 800); } }
function buildAlarmMessage(t1, t2) { if (t1 && t2) alarmMessage = "Please check product and log hourly production."; else if (t1) alarmMessage = "Please check product."; else if (t2) alarmMessage = "Please log hourly production."; }
function triggerAlarm(t1, t2) { isAlarmActive = true; dismissBtn.style.display = 'block'; wasRadioPlayingBeforeAlarm = !radioAudio.paused; stopRadio(); buildAlarmMessage(t1, t2); triggerAlertSound(); alarmInterval = setInterval(triggerAlertSound, 4000); }
document.addEventListener("visibilitychange", () => { if (!document.hidden && isAlarmActive) { triggerAlertSound(); } });
function dismissAlarm() { let now = Date.now(); let t1Triggered = (timer1Remaining === 0); let t2Triggered = (timer2Remaining === 0); if (t1Triggered && t2Triggered) { addLogEntry("✓ Product Check & Hourly Production Completed", "check"); } else if (t1Triggered) { addLogEntry("✓ Product Check Completed", "check"); } else if (t2Triggered) { addLogEntry("✓ Hourly Production Log Completed", "check"); } if (t1Triggered) { timer1Remaining = TIME_30_MIN; timer1EndTime = now + (TIME_30_MIN * 1000); } if (t2Triggered) { timer2Remaining = TIME_1_HOUR; timer2EndTime = now + (TIME_1_HOUR * 1000); } updateDisplays(); saveActiveJobState(); isAlarmActive = false; clearInterval(alarmInterval); window.speechSynthesis.cancel(); dismissBtn.style.display = 'none'; if (wasRadioPlayingBeforeAlarm) { startRadio(); wasRadioPlayingBeforeAlarm = false; } }

function addLogEntry(text, typeClass) { if (logList.children.length === 1 && logList.children[0].style.fontStyle === 'italic') logList.innerHTML = ""; let now = new Date(); let stamp = `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}]`; savedLogsArray.push({ stamp: stamp, text: text, type: typeClass }); let li = document.createElement('li'); li.className = `log-item ${typeClass}`; li.innerHTML = `<span style="color:#6c7086">${stamp}</span> <span>${text}</span>`; logList.insertBefore(li, logList.firstChild); }

let savedStation = localStorage.getItem('my_dedicated_station_id'); if (savedStation) { stationId = savedStation; document.getElementById('setupStationId').value = savedStation; }
refreshSavedJobsUI(); loadRadioStations(); if ('speechSynthesis' in window) { loadAvailableVoices(); window.speechSynthesis.onvoiceschanged = loadAvailableVoices; } else { hasEnglishVoice = false; voiceIndicator.style.backgroundColor = "#f38ba8"; }
