const videoElement = document.getElementById('video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const setRefBtn = document.getElementById('setRefBtn');
const statusText = document.getElementById('statusText');
const deviationDisplay = document.getElementById('deviationValue');
const loader = document.getElementById('loader');
const loadingMessage = document.getElementById('loadingMessage');
const alertOverlay = document.getElementById('alertOverlay');
const thresholdRange = document.getElementById('thresholdRange');
const thresholdValueDisplay = document.getElementById('thresholdValue');

let pose;
let camera;
let isModelReady = false;
let firstFrameReceived = false;

// Initialize Pose
try {
    pose = new Pose({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
        }
    });

    pose.setOptions({
        modelComplexity: 1,
        smoothLandmarks: true,
        enableSegmentation: false,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    pose.onResults(onResults);

    // Enable start button once pose is instantiated (though loading happens on first use)
    startBtn.disabled = false;
} catch (e) {
    console.error("Error initializing Pose:", e);
    alert("Pose 모델 로딩 실패. 인터넷 연결을 확인하세요.");
}


// State
let referenceLandmarks = null;
let isMonitoring = false;
let lastAlertTime = 0;
let badPostureDuration = 0; // Accumulated bad posture time in seconds
let lastFrameTime = 0;
let alertDelaySeconds = 3; // Default 3s
const ALERT_COOLDOWN = 3000;
let userThresholdPercent = 60; // Default 60% (Lowered sensitivity)
const UI_SCALE_FACTOR = 350; // Constant for UI display and threshold scaling
let deviationThreshold = userThresholdPercent / UI_SCALE_FACTOR;

// Audio Context for Beep
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playBeep() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(440, audioCtx.currentTime); // A4
    oscillator.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.1);

    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.5);
}


const testNotiBtn = document.getElementById('testNotiBtn');

// Silent Audio to prevent browser throttling in background
let keepAliveOscillator = null;

function startKeepAliveAudio() {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // Create a silent oscillator
    keepAliveOscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = 0.001; // Nearly silent
    keepAliveOscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    keepAliveOscillator.start();
}

function stopKeepAliveAudio() {
    if (keepAliveOscillator) {
        keepAliveOscillator.stop();
        keepAliveOscillator = null;
    }
}

// Custom Loop State
let animationFrameId = null;
let backgroundIntervalId = null;
let isVideoPlaying = false;

// Web Worker for Precise Background Timing
const workerBlob = new Blob([`
    let intervalId;
    self.onmessage = function(e) {
        if (e.data === 'start') {
            intervalId = setInterval(() => {
                postMessage('tick');
            }, 1000); // 1 FPS in background is enough
        } else if (e.data === 'stop') {
            clearInterval(intervalId);
        }
    };
`], { type: 'application/javascript' });

const timerWorker = new Worker(URL.createObjectURL(workerBlob));

timerWorker.onmessage = () => {
    if (isVideoPlaying && document.hidden) {
        processVideoFrame();
    }
};

async function processVideoFrame() {
    if (!isVideoPlaying) return;

    // Process frame
    await pose.send({ image: videoElement });

    // Schedule next frame ONLY if visible
    // If hidden, the Web Worker drives the loop
    if (!document.hidden) {
        requestAnimationFrame(processVideoFrame);
    }
}

async function startCameraAndLoop() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720 }
        });
        videoElement.srcObject = stream;

        await new Promise((resolve) => {
            videoElement.onloadedmetadata = () => {
                videoElement.play();
                resolve();
            };
        });

        isVideoPlaying = true;
        // Start visible loop
        processVideoFrame();

        // Start background worker loop
        timerWorker.postMessage('start');

        startKeepAliveAudio(); // Important for background

    } catch (e) {
        console.error("Camera error:", e);
        alert("카메라 시작 실패: " + e.message);
        startBtn.disabled = false;
        loader.style.display = 'none';
        loadingMessage.style.display = 'none';
        startBtn.innerText = "📷 카메라 시작";
    }
}

startBtn.addEventListener('click', () => {
    // 1. Ask for notification permission immediately on click
    if ("Notification" in window) {
        Notification.requestPermission().then(permission => {
            console.log("Notification permission:", permission);
            if (permission === "denied") {
                alert("⚠️ 알림이 차단되어 있습니다.\n\n브라우저 주소창 왼쪽의 '자물쇠' 또는 '설정' 아이콘을 눌러 알림 권한을 '허용'으로 변경해주세요.");
            }
        });
    }

    startBtn.disabled = true;
    startBtn.innerText = "카메라 시작 중...";
    loader.style.display = 'block';
    loadingMessage.style.display = 'flex';

    // Start Custom Loop instead of Camera utils
    startCameraAndLoop();
    stopBtn.disabled = false;
});

// Test Notification Button Logic
function attachTestNoti() {
    const btn = document.getElementById('testNotiBtn');
    if (btn) {
        // remove old listener if any (by cloning)
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('click', () => {
            // Flash Title Test as fallback
            flashTitle();
            playBeep();

            // Notify Check
            if (Notification.permission === "granted") {
                try {
                    const noti = new Notification("🔔 알림 테스트", {
                        body: "이 알림이 보이시나요?",
                        icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png',
                        requireInteraction: true // Make it stay until clicked
                    });
                    noti.onclick = () => { window.focus(); };
                } catch (e) {
                    alert("알림 생성 실패 (브라우저 오류): " + e.message);
                }
            } else if (Notification.permission === "denied") {
                alert("⚠️ 현재 알림 권한이 '차단(Denied)' 상태입니다.\n\n브라우저 주소창 왼쪽 [자물쇠] -> [알림] -> [허용]으로 바꿔주세요.");
            } else {
                Notification.requestPermission();
            }
        });
        console.log("Notification button listener attached");
    } else {
        console.error("Test Notification Button not found in DOM");
    }
}

// Settings Persistence
function loadSettings() {
    const savedThreshold = localStorage.getItem('posture_threshold');
    const savedDelay = localStorage.getItem('posture_delay');

    if (savedThreshold) {
        userThresholdPercent = parseInt(savedThreshold);
        thresholdRange.value = userThresholdPercent;
        thresholdValueDisplay.innerText = userThresholdPercent;
        deviationThreshold = userThresholdPercent / UI_SCALE_FACTOR;
    }

    if (savedDelay) {
        alertDelaySeconds = parseInt(savedDelay);
        if (delayRange) delayRange.value = alertDelaySeconds;
        if (delayValueDisplay) delayValueDisplay.innerText = alertDelaySeconds;
    }
}

function saveSettings() {
    localStorage.setItem('posture_threshold', userThresholdPercent);
    localStorage.setItem('posture_delay', alertDelaySeconds);
}

// Ensure DOM is ready and load settings
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        attachTestNoti();
        loadSettings();
    });
} else {
    attachTestNoti();
    loadSettings();
}

stopBtn.addEventListener('click', () => {
    // Stop custom loop flag
    isVideoPlaying = false;

    // Stop worker
    timerWorker.postMessage('stop');

    // Stop streams
    const stream = videoElement.srcObject;
    if (stream) {
        const tracks = stream.getTracks();
        tracks.forEach(track => track.stop());
        videoElement.srcObject = null;
    }

    // Stop audio keep-alive
    stopKeepAliveAudio();

    isMonitoring = false;
    startBtn.disabled = false;
    startBtn.innerText = "📷 카메라 시작";
    stopBtn.disabled = true;
    setRefBtn.disabled = true;
    statusText.innerText = "대기 중...";
    statusText.style.color = "var(--text-secondary)";
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    deviationDisplay.innerText = "0%";
    clearAlert();
    alert("카메라가 중지되었습니다.");
});

// Threshold Slider Logic
thresholdRange.addEventListener('input', (e) => {
    userThresholdPercent = parseInt(e.target.value);
    thresholdValueDisplay.innerText = userThresholdPercent;
    deviationThreshold = userThresholdPercent / UI_SCALE_FACTOR;
    saveSettings();
});

const delayRange = document.getElementById('delayRange');
const delayValueDisplay = document.getElementById('delayValue');

if (delayRange) {
    delayRange.addEventListener('input', (e) => {
        alertDelaySeconds = parseInt(e.target.value);
        delayValueDisplay.innerText = alertDelaySeconds;
        saveSettings();
    });
}

setRefBtn.addEventListener('click', () => {
    if (currentResults && currentResults.poseLandmarks) {
        referenceLandmarks = normalizeLandmarks(currentResults.poseLandmarks);
        isMonitoring = true;
        statusText.innerText = "감시 중";
        statusText.style.color = "#10b981";
        setRefBtn.innerText = "📌 기준 자세 재설정";
        playBeep(); // distinct beep for setting ref
    }
});

let currentResults = null;

function onResults(results) {
    if (!firstFrameReceived) {
        firstFrameReceived = true;
        loader.style.display = 'none';
        loadingMessage.style.display = 'none';
        startBtn.innerText = "카메라 켜짐";
        statusText.innerText = "바른 자세를 취하고 '기준 자세 설정' 버튼을 누르세요";
    }

    currentResults = results;

    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    if (results.poseLandmarks) {
        // Safe access to global POSE_CONNECTIONS
        const connections = window.POSE_CONNECTIONS || Pose.POSE_CONNECTIONS;

        if (connections) {
            drawConnectors(canvasCtx, results.poseLandmarks, connections,
                { color: 'rgba(255, 255, 255, 0.3)', lineWidth: 2 });
        }

        const isUserPresent = isUserVisible(results.poseLandmarks);

        let landmarkColor = '#3b82f6';
        if (isMonitoring && isUserPresent) {
            if (isBadPosture) {
                landmarkColor = '#ef4444'; // Red (Alerting)
            } else if (badPostureDuration > 0.5) {
                landmarkColor = '#f59e0b'; // Yellow (Warning/Timer running) - trigger after 0.5s bad
            } else {
                landmarkColor = '#10b981'; // Green (Good)
            }
        }

        drawLandmarks(canvasCtx, results.poseLandmarks,
            { color: landmarkColor, lineWidth: 1 });

        if (!isMonitoring) {
            setRefBtn.disabled = false;
        }

        if (isMonitoring && referenceLandmarks) {
            if (isUserPresent) {
                checkPosture(results.poseLandmarks);
            } else {
                handleUserAway();
            }
        }
    } else {
        // No landmarks at all (completely empty frame)
        if (isMonitoring) {
            handleUserAway();
        }
    }
    canvasCtx.restore();
}

let isBadPosture = false;

function normalizeLandmarks(landmarks) {
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    // Calculate shoulder width for scale normalization
    const shoulderWidth = Math.sqrt(
        Math.pow(leftShoulder.x - rightShoulder.x, 2) +
        Math.pow(leftShoulder.y - rightShoulder.y, 2)
    );

    // Center point (mid-shoulder)
    const centerX = (leftShoulder.x + rightShoulder.x) / 2;
    const centerY = (leftShoulder.y + rightShoulder.y) / 2;
    const centerZ = (leftShoulder.z + rightShoulder.z) / 2;

    const normalize = (p) => ({
        x: (p.x - centerX) / shoulderWidth,
        y: (p.y - centerY) / shoulderWidth,
        z: (p.z - centerZ) / shoulderWidth // Depth relative to shoulder line
    });

    return {
        nose: normalize(landmarks[0]),
        leftEye: normalize(landmarks[2]),
        rightEye: normalize(landmarks[5]),
        leftEar: normalize(landmarks[7]),
        rightEar: normalize(landmarks[8]),
        leftShoulder: normalize(landmarks[11]),
        rightShoulder: normalize(landmarks[12]),
        shoulderWidth: shoulderWidth
    };
}

function checkPosture(currentLandmarks) {
    const current = normalizeLandmarks(currentLandmarks);
    const ref = referenceLandmarks;

    // 1. Position-based deviation (X, Y, Z)
    let totalError = 0;
    const weights = {
        nose: { x: 0.2, y: 1.2, z: 1.5 }, // Reduced y(1.5->1.2), z(2.0->1.5)
        leftEye: { x: 0.2, y: 1.2, z: 1.2 }, // Reduced y(1.5->1.2), z(1.5->1.2)
        rightEye: { x: 0.2, y: 1.2, z: 1.2 }, // Reduced y(1.5->1.2), z(1.5->1.2)
        leftEar: { x: 0.2, y: 1.2, z: 1.0 }, // Reduced y(1.5->1.2), z(1.2->1.0)
        rightEar: { x: 0.2, y: 1.2, z: 1.0 }, // Reduced y(1.5->1.2), z(1.2->1.0)
        leftShoulder: { x: 0.8, y: 1.0, z: 0.5 }, // Reduced y(1.2->1.0)
        rightShoulder: { x: 0.8, y: 1.0, z: 0.5 } // Reduced y(1.2->1.0)
    };

    const points = Object.keys(weights);

    points.forEach(key => {
        const p1 = current[key];
        const p2 = ref[key];
        const w = weights[key];

        const diffX = Math.abs(p1.x - p2.x);
        const diffY = Math.abs(p1.y - p2.y);
        const diffZ = Math.abs(p1.z - p2.z);

        // Weighted 3D distance
        const dist = Math.sqrt(
            Math.pow(diffX * w.x, 2) +
            Math.pow(diffY * w.y, 2) +
            Math.pow(diffZ * w.z, 2)
        );
        totalError += dist;
    });

    // 2. Scale-based deviation (Distance from screen)
    // If shoulderWidth increases, user is leaning forward (Turtle Neck)
    // We penalize leaning forward more heavily than leaning back
    const scaleRatio = current.shoulderWidth / ref.shoulderWidth;
    let scaleError = 0;
    if (scaleRatio > 1.12) { // leaning forward (> 12% closer) - was 1.05
        scaleError = (scaleRatio - 1.12) * 3.0; // Penalty reduced from 5.0
    } else if (scaleRatio < 0.85) { // leaning back (> 15% further) - was 0.90
        scaleError = (0.85 - scaleRatio) * 1.5; // Penalty reduced from 2.0
    }

    const avgBaseError = totalError / points.length;
    const finalError = avgBaseError + scaleError;

    const deviationPercent = Math.min(100, Math.round(finalError * UI_SCALE_FACTOR));

    deviationDisplay.innerText = `${deviationPercent}%`;

    // Check thresholds
    const now = Date.now();
    const dt = (now - (lastFrameTime || now)) / 1000;
    lastFrameTime = now;

    if (finalError > deviationThreshold) {
        // BAD POSTURE
        badPostureDuration += dt;

        if (badPostureDuration >= alertDelaySeconds) {
            isBadPosture = true;
            statusText.innerText = scaleError > 0.1 ? "거북목 주의: 화면과 너무 가깝습니다!" : "자세가 구부정합니다!";
            statusText.style.color = "#ef4444";
            triggerAlert();
        } else {
            const remaining = Math.ceil(alertDelaySeconds - badPostureDuration);
            statusText.innerText = `주의 (${remaining}초 후 알림)`;
            statusText.style.color = "#f59e0b";
            isBadPosture = false;
        }
    } else {
        // GOOD POSTURE
        badPostureDuration -= dt * 2.0;
        if (badPostureDuration < 0) badPostureDuration = 0;

        isBadPosture = false;
        statusText.innerText = "바른 자세입니다";
        statusText.style.color = "#10b981";
        clearAlert();
    }
}

// Check if user is actually in frame (prevent alerting empty chair)
function isUserVisible(landmarks) {
    const MIN_VISIBILITY = 0.75; // Increased threshold
    // Check Nose(0), Shoulders(11, 12), Ears(7,8)
    // Must have at least ONE shoulder and ONE facial feature with high confidence
    const shoulders = [11, 12];
    const face = [0, 7, 8];

    const hasShoulder = shoulders.some(idx => landmarks[idx] && landmarks[idx].visibility > MIN_VISIBILITY);
    const hasFace = face.some(idx => landmarks[idx] && landmarks[idx].visibility > MIN_VISIBILITY);

    return hasShoulder && hasFace;
}

function handleUserAway() {
    isBadPosture = false;
    badPostureDuration = 0; // Reset accumulator
    if (statusText.innerText.indexOf("사용자 없음") === -1) {
        statusText.innerText = "사용자 없음 (알림 일시정지)";
        statusText.style.color = "var(--text-secondary)";
        deviationDisplay.innerText = "-";
        clearAlert();
    }
}

let titleInterval = null;
const originalTitle = document.title;

function flashTitle() {
    if (titleInterval) return; // already flashing
    let showWarning = true;
    titleInterval = setInterval(() => {
        document.title = showWarning ? "⚠️ 자세 교정 필요! ⚠️" : originalTitle;
        showWarning = !showWarning;
    }, 500);

    // Stop after 5 seconds
    setTimeout(() => {
        stopFlashTitle();
    }, 5000);
}

function stopFlashTitle() {
    clearInterval(titleInterval);
    titleInterval = null;
    document.title = originalTitle;
}

function triggerAlert() {
    // FINAL CHECK: If user is not present, DO NOT ALERT.
    if (statusText.innerText.indexOf("사용자 없음") !== -1) {
        return;
    }

    const now = Date.now();
    // Reduce cooldown slightly to ensure it fires if user missed it
    if (now - lastAlertTime > ALERT_COOLDOWN) {

        // Always play beep
        playBeep();

        // 1. Flash Title (Visual fallback for taskbar)
        if (document.hidden) {
            flashTitle();
        }

        // 2. System Notification
        // Force notification without condition on visibility
        if ("Notification" in window && Notification.permission === "granted") {
            try {
                // Close previous if exists? No, spam is better for posture
                new Notification("⚠️ 자세 경고", {
                    body: "자세가 구부정합니다! 바른 자세를 취해주세요.",
                    silent: true, // We play our own sound
                    requireInteraction: false,
                    tag: 'posture-alert',
                    renotify: true, // Force new alert even if tag matches
                    icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png'
                });
            } catch (e) {
                console.error("Notification failed", e);
            }
        }

        // Update alert time
        lastAlertTime = now;
    }

    // Ensure overlay is shown
    alertOverlay.style.boxShadow = "inset 0 0 100px 50px rgba(239, 68, 68, 0.6)";
}

function clearAlert() {
    alertOverlay.style.boxShadow = "none";
}
