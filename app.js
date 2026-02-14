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
let badPostureStartTime = 0;
let alertDelaySeconds = 3; // Default 3s
const ALERT_COOLDOWN = 3000;
let userThresholdPercent = 40; // Default 40%
let deviationThreshold = userThresholdPercent / 500; // Calculated threshold
const EAR_SHOULDER_THRESHOLD = 0.05; // Specific check for forward head posture

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

    camera = new Camera(videoElement, {
        onFrame: async () => {
            await pose.send({ image: videoElement });
        },
        width: 1280,
        height: 720
    });
    camera.start();
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

// Ensure DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachTestNoti);
} else {
    attachTestNoti();
}

stopBtn.addEventListener('click', () => {
    if (camera) {
        camera.stop();
        // MediaPipe camera utils doesn't expose a clean stop sometimes, let's try just stopping video
        const stream = videoElement.srcObject;
        if (stream) {
            const tracks = stream.getTracks();
            tracks.forEach(track => track.stop());
            videoElement.srcObject = null;
        }
    }
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
    deviationThreshold = userThresholdPercent / 500;
});

const delayRange = document.getElementById('delayRange');
const delayValueDisplay = document.getElementById('delayValue');

if (delayRange) {
    delayRange.addEventListener('input', (e) => {
        alertDelaySeconds = parseInt(e.target.value);
        delayValueDisplay.innerText = alertDelaySeconds;
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

        // Visual indicator of delay timer (turn landmarks yellow/orange)
        let landmarkColor = '#3b82f6';
        if (isMonitoring) {
            if (isBadPosture) {
                landmarkColor = '#ef4444'; // Red (Alerting)
            } else if (badPostureStartTime > 0) {
                landmarkColor = '#f59e0b'; // Yellow (Warning/Timer running)
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
            checkPosture(results.poseLandmarks);
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

    const normalize = (p) => ({
        x: (p.x - centerX) / shoulderWidth,
        y: (p.y - centerY) / shoulderWidth,
        z: p.z // maintain z depth info roughly
    });

    return {
        nose: normalize(landmarks[0]),
        leftEye: normalize(landmarks[2]),
        rightEye: normalize(landmarks[5]),
        leftEar: normalize(landmarks[7]),
        rightEar: normalize(landmarks[8]),
        leftShoulder: normalize(landmarks[11]),
        rightShoulder: normalize(landmarks[12]),
        shoulderWidth: shoulderWidth // store original scale reference if needed
    };
}

function checkPosture(currentLandmarks) {
    const current = normalizeLandmarks(currentLandmarks);
    const ref = referenceLandmarks;

    // Calculate deviation with weights
    // We want to PENALIZE Y-axis movement (slouching, dropping head)
    // We want to IGNORE X-axis movement for head (looking left/right at monitors)

    let totalError = 0;

    // Define weights
    const weights = {
        nose: { x: 0.2, y: 2.0 },        // Low X sensitivity (looking around), High Y (dropping head)
        leftEye: { x: 0.2, y: 2.0 },
        rightEye: { x: 0.2, y: 2.0 },
        leftEar: { x: 0.2, y: 2.0 },
        rightEar: { x: 0.2, y: 2.0 },
        leftShoulder: { x: 1.0, y: 1.5 }, // Shoulders shouldn't move much
        rightShoulder: { x: 1.0, y: 1.5 }
    };

    const points = Object.keys(weights);

    points.forEach(key => {
        const p1 = current[key];
        const p2 = ref[key];
        const w = weights[key];

        const diffX = Math.abs(p1.x - p2.x);
        const diffY = Math.abs(p1.y - p2.y);

        // Weighted distance
        const dist = Math.sqrt(Math.pow(diffX * w.x, 2) + Math.pow(diffY * w.y, 2));
        totalError += dist;
    });

    const avgError = totalError / points.length;
    const deviationPercent = Math.min(100, Math.round(avgError * 500)); // Scale factor for display

    deviationDisplay.innerText = `${deviationPercent}%`;

    // Check thresholds
    const now = Date.now();

    if (avgError > deviationThreshold) {
        if (badPostureStartTime === 0) {
            badPostureStartTime = now;
        }

        const duration = (now - badPostureStartTime) / 1000;

        if (duration >= alertDelaySeconds) {
            isBadPosture = true;
            statusText.innerText = "자세가 구부정합니다!";
            statusText.style.color = "#ef4444";
            triggerAlert();
        } else {
            const remaining = Math.ceil(alertDelaySeconds - duration);
            statusText.innerText = `주의 (${remaining}초 후 알림)`;
            statusText.style.color = "#f59e0b"; // Warning yellow
            isBadPosture = false; // Not yet alerted
        }
    } else {
        isBadPosture = false;
        badPostureStartTime = 0; // Reset timer
        statusText.innerText = "바른 자세입니다";
        statusText.style.color = "#10b981";
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
    alertOverlay.style.boxShadow = "inset 0 0 100px 50px rgba(239, 68, 68, 0.6)";
    const now = Date.now();
    if (now - lastAlertTime > ALERT_COOLDOWN) {
        playBeep();

        // 1. Flash Title (Visual fallback for taskbar)
        if (document.hidden) {
            flashTitle();
        }

        // 2. System Notification
        // Removed document.hidden check so it alerts even if window is visible (good for testing)
        if ("Notification" in window && Notification.permission === "granted") {
            try {
                new Notification("⚠️ 자세 경고", {
                    body: "자세가 구부정합니다! 허리를 펴세요.",
                    silent: true,
                    icon: 'https://cdn-icons-png.flaticon.com/512/564/564619.png' // Medical pose icon
                });
            } catch (e) {
                console.error("Notification failed", e);
            }
        }

        lastAlertTime = now;
    }
}

function clearAlert() {
    alertOverlay.style.boxShadow = "none";
}
