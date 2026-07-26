function showDateTime() {
    const now = new Date();

    let hours = now.getHours();
    let minutes = now.getMinutes();
    let seconds = now.getSeconds();

    if (hours < 10) { hours = "0" + hours; }
    if (minutes < 10) { minutes = "0" + minutes; }
    if (seconds < 10) { seconds = "0" + seconds; }

    const timeString = hours + ":" + minutes + ":" + seconds;

    let dayOfMonth = now.getDate();
    let month = now.getMonth() + 1;
    const year = now.getFullYear();

    if (dayOfMonth < 10) { dayOfMonth = "0" + dayOfMonth; }
    if (month < 10) { month = "0" + month; }

    const dateString = dayOfMonth + "/" + month + "/" + year;

    const daysOfWeek = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday"
    ];
    const dayName = daysOfWeek[now.getDay()];

    document.getElementById("date").textContent = dayName + ", " + dateString;
    document.getElementById("clock").textContent = timeString;
}

showDateTime();
setInterval(showDateTime, 1000);

function sidebarSwitch() {

    const H = document.getElementById("btn-H");
    const D = document.getElementById("btn-D");
    const P = document.getElementById("btn-P");
    const A = document.getElementById("btn-A");
    const T = document.getElementById("btn-T");
    const HMain = document.getElementById("H");
    const DMain = document.getElementById("D");
    const PMain = document.getElementById("P");
    const AMain = document.getElementById("A");

    H.addEventListener("click", function () {
        HMain.classList.add("hidden");
        DMain.classList.add("hidden");
        PMain.classList.add("hidden");
        AMain.classList.add("hidden");

        HMain.classList.remove("hidden");
    });
    D.addEventListener("click", function () {
        HMain.classList.add("hidden");
        DMain.classList.add("hidden");
        PMain.classList.add("hidden");
        AMain.classList.add("hidden");

        DMain.classList.remove("hidden");
    });
    P.addEventListener("click", function () {
        HMain.classList.add("hidden");
        DMain.classList.add("hidden");
        PMain.classList.add("hidden");
        AMain.classList.add("hidden");

        PMain.classList.remove("hidden");
    });
    A.addEventListener("click", function () {
        HMain.classList.add("hidden");
        DMain.classList.add("hidden");
        PMain.classList.add("hidden");
        AMain.classList.add("hidden");

        AMain.classList.remove("hidden");
    });

    T.addEventListener("click", function () {
        window.location.href = "u/index.html";
    });
}

sidebarSwitch();