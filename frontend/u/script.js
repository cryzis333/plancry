let totalmilliseconds = 0;
let accumulatedTime = 0;
let startTime = 0;
let seconds = 0;
let minutes = 0;
let hours = 0;
let timerId;
let mode = false;

function loadSavedTime() {
    let savedData = localStorage.getItem("myTimerValue");
    let saveMode = localStorage.getItem("myTimerMode");
    let isRunning = localStorage.getItem("myTimerRunning");

    if (saveMode === "true") {
        mode = true;
        document.getElementById("box").classList.add("active");
    } else {
        mode = false;
        document.getElementById("box").classList.remove("active");
    }

    if (savedData !== null) {
        totalmilliseconds = Number(savedData);
        accumulatedTime = totalmilliseconds;
        updateScreen();
    }

    if (isRunning === "true" && savedData !== null) {
        startTime = Date.now();
        timerId = setInterval(tick, 10);
        document.getElementById("start").classList.add("hidden");
        document.getElementById("pause").classList.remove("hidden");
        document.getElementById("reset").classList.remove("hidden");
    } else if (savedData !== null) { 
        document.getElementById("start").classList.add("hidden");
        document.getElementById("resume").classList.remove("hidden");
        document.getElementById("reset").classList.remove("hidden");
    }
}

function updateScreen() {
    hours = Math.floor(totalmilliseconds / 360000);
    minutes = Math.floor((totalmilliseconds % 360000) / 6000);
    seconds = Math.floor((totalmilliseconds % 6000) / 100);
    let ms = totalmilliseconds % 100;

    let displayHours = hours;
    let displayMinutes = minutes;
    let displaySeconds = seconds;
    let displayMs = ms;

    if (ms < 10) { displayMs = "0" + ms; }
    if (hours < 10) { displayHours = "0" + hours; }
    if (minutes < 10) { displayMinutes = "0" + minutes; }
    if (seconds < 10) { displaySeconds = "0" + seconds; }
    document.getElementById("timer").textContent = displayHours + " : " + displayMinutes + " : " + displaySeconds + " : " + displayMs;
}

function tick() {
    const now = Date.now();
    totalmilliseconds = accumulatedTime + Math.floor((now - startTime) / 10);
    updateScreen();

    if (mode === true) {
        if (totalmilliseconds % 10 === 0) {
            localStorage.setItem("myTimerValue", totalmilliseconds);
        }
    } else {
        if (totalmilliseconds % 500 === 0) {
            localStorage.setItem("myTimerValue", totalmilliseconds);
        }
    }
}

loadSavedTime();

document.getElementById("re-switch").addEventListener("click", function () {
    let box = document.getElementById("box");
    box.classList.toggle("active");
    mode = box.classList.contains("active");
    localStorage.setItem("myTimerMode", mode);
});

document.getElementById("start").addEventListener("click", function () {
    startTime = Date.now();
    timerId = setInterval(tick, 10);
    localStorage.setItem("myTimerRunning", "true");
    document.getElementById("pause").classList.remove("hidden");
    document.getElementById("reset").classList.remove("hidden");
    document.getElementById("start").classList.add("hidden");
});

document.getElementById("pause").addEventListener("click", function () {
    clearInterval(timerId);
    accumulatedTime = totalmilliseconds;
    localStorage.setItem("myTimerValue", totalmilliseconds);
    localStorage.setItem("myTimerRunning", "false");
    document.getElementById("pause").classList.add("hidden");
    document.getElementById("resume").classList.remove("hidden");
});

document.getElementById("resume").addEventListener("click", function () {
    startTime = Date.now();
    timerId = setInterval(tick, 10);
    localStorage.setItem("myTimerRunning", "true");
    document.getElementById("resume").classList.add("hidden");
    document.getElementById("pause").classList.remove("hidden");
});

document.getElementById("reset").addEventListener("click", function () {
    clearInterval(timerId);
    totalmilliseconds = 0;
    accumulatedTime = 0;
    startTime = 0;
    mode = false;

    localStorage.removeItem("myTimerValue");
    localStorage.removeItem("myTimerMode");
    localStorage.removeItem("myTimerRunning");

    document.getElementById("timer").textContent = "00 : 00 : 00 : 00";
    document.getElementById("resume").classList.add("hidden");
    document.getElementById("pause").classList.add("hidden");
    document.getElementById("reset").classList.add("hidden");
    document.getElementById("start").classList.remove("hidden");
    document.getElementById("box").classList.remove("active");
});
