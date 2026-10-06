import {isTouchControlActive,getTouchInputs,touchStickLayout} from './touchControls.js';
import { loadCalibration, defaultCalibration, sampleRawInputs } from './calibration.js';

const info = document.getElementById("info");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const radius = 60;
const padding = 20;

const leftCenterX = padding + radius;
const rightCenterX = canvas.width - padding - radius;
const centerY = canvas.height / 2;

let gamepadIndex = null;
let calibration = null;

// Тримаємо мапування синхронним з тим, що обрали в майстрі калібровки
// (engine.js кидає цю подію одразу після завантаження/збереження профілю).
window.addEventListener("fpv-calibration-updated", (e) => {
    calibration = e.detail.calibration;
});

window.addEventListener("gamepadconnected", (e) => {
    gamepadIndex = e.gamepad.index;
    if (!calibration) {
        calibration = loadCalibration(e.gamepad) || defaultCalibration();
    }
    console.log(`Gamepad connected at index ${e.gamepad.index}: ${e.gamepad.id}`);
    console.log(e.gamepad.axes);

});

window.addEventListener("gamepaddisconnected", (e) => {
    console.log("Gamepad disconnected");
    gamepadIndex = null;
    info.textContent = "Геймпад відключено.";
    clearCanvas();
});

function clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawStick(centerX, centerY, xAxis, yAxis, radius=60) {
    // Квадратна зона
    const size = radius * 2;
    const topLeftX = centerX - radius;
    const topLeftY = centerY - radius;

    ctx.strokeStyle = "#999";
    ctx.setLineDash([]); // суцільна рамка
    ctx.strokeRect(topLeftX, topLeftY, size, size);

    // Пунктирні осі
    ctx.strokeStyle = "#ccc";
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    // вертикальна лінія
    ctx.moveTo(centerX, topLeftY);
    ctx.lineTo(centerX, topLeftY + size);
    // горизонтальна лінія
    ctx.moveTo(topLeftX, centerY);
    ctx.lineTo(topLeftX + size, centerY);
    ctx.stroke();

    // Поточне положення
    const x = centerX + xAxis * radius;
    const y = centerY + yAxis * radius;

    ctx.setLineDash([]); // скидаємо пунктир
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;
    ctx.stroke();
}

function updateLoop() {
    requestAnimationFrame(updateLoop);
    if(isTouchControlActive()){
        const inputs=getTouchInputs();info.textContent='';clearCanvas();
        const l=touchStickLayout(canvas);
        drawStick(l.left,l.y,inputs.yaw,1-2*inputs.throttle,l.radius);
        drawStick(l.right,l.y,inputs.roll,-inputs.pitch,l.radius);return;
    }
    if (gamepadIndex !== null) {
        const gp = navigator.getGamepads()[gamepadIndex];
        if (gp) {
            // Текстова інформація
            // gp.id зазвичай має вигляд "Xbox 360 Controller (STANDARD GAMEPAD
            // Vendor: 045e Product: 028e)" — технічна частина в дужках гравцю
            // не потрібна, показуємо лише назву контролера.
            info.textContent = "";

            // Значення осей — беремо через ту саму калібровку, що керує польотом,
            // а не сирі axes[0..3], щоб малюнок відповідав тому, як реально літає.
            const inputs = sampleRawInputs(gp, calibration);

            // Малюємо обидва стики: лівий = газ/йоу, правий = тангаж/крен
            clearCanvas();
            drawStick(leftCenterX, centerY, inputs.yaw, -inputs.throttle);
            drawStick(rightCenterX, centerY, inputs.roll, -inputs.pitch);
        }

    }
}

updateLoop();
