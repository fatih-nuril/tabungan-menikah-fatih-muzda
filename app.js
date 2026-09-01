import { auth, db } from "./firebase-config.js";

import {
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  getDoc,
  setDoc
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

import { Chart, registerables } from "https://cdn.jsdelivr.net/npm/chart.js@4.5.0/+esm";
Chart.register(...registerables);

const $ = (id) => document.getElementById(id);
const TARGET_DEFAULT = 50000000;

let transactions = [];
let targetAmount = TARGET_DEFAULT;
let weddingDate = "";
let unsubscribeTransactions = null;
let unsubscribeSettings = null;
let chart = null;
let editingId = null;
let currentUser = null;

const money = (n) => new Intl.NumberFormat("id-ID", {
  style: "currency", currency: "IDR", maximumFractionDigits: 0
}).format(Number(n) || 0);

const dateToLabel = (value) => {
  if (!value) return "-";
  const [y,m,d] = value.split("-");
  return `${d}/${m}/${y}`;
};

const todayISO = () => {
  const d = new Date();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${d.getFullYear()}-${m}-${day}`;
};

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setLoading(button, loading) {
  if (!button) return;
  button.disabled = loading;
  button.dataset.original = button.dataset.original || button.textContent;
  button.textContent = loading ? "Menyimpan..." : button.dataset.original;
}

function updateSummary() {
  const total = transactions.reduce((s,t) => s + Number(t.nominal || 0), 0);
  const fatih = transactions.filter(t => t.nama === "Fatih").reduce((s,t) => s + Number(t.nominal || 0), 0);
  const muzdoug = transactions.filter(t => t.nama === "Muzdoug").reduce((s,t) => s + Number(t.nominal || 0), 0);
  const largest = transactions.reduce((m,t) => Math.max(m, Number(t.nominal || 0)), 0);
  const average = transactions.length ? total / transactions.length : 0;
  const monthKey = todayISO().slice(0,7);
  const monthTotal = transactions.filter(t => String(t.tanggal || "").startsWith(monthKey))
    .reduce((s,t) => s + Number(t.nominal || 0), 0);
  const progress = targetAmount > 0 ? Math.min(total / targetAmount * 100, 100) : 0;

  $("totalSavings").textContent = money(total);
  $("fatihTotal").textContent = money(fatih);
  $("muzdougTotal").textContent = money(muzdoug);
  $("progressText").textContent = `${progress.toFixed(1)}%`;
  $("progressBar").style.width = `${progress}%`;
  $("targetAmount").textContent = money(targetAmount);
  $("transactionCount").textContent = transactions.length;
  $("transactionBadge").textContent = `${transactions.length} transaksi`;
  $("averageSavings").textContent = money(average);
  $("largestSavings").textContent = money(largest);
  $("monthSavings").textContent = money(monthTotal);

  updateWeddingDisplay();
}

function updateWeddingDisplay() {
  const label = $("weddingDateLabel");
  const countdown = $("countdownLabel");

  if (!weddingDate) {
    label.textContent = "Secepatnya, InsyaAllah ❤️";
    countdown.textContent = "Tanggal belum ditentukan";
    return;
  }

  label.textContent = dateToLabel(weddingDate);
  const target = new Date(`${weddingDate}T00:00:00`);
  const now = new Date();
  const diff = Math.ceil((target - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);

  if (diff > 0) countdown.textContent = `${diff} hari lagi menuju hari bahagia`;
  else if (diff === 0) countdown.textContent = "Hari ini adalah hari bahagia! ❤️";
  else countdown.textContent = "Hari bahagia telah lewat ❤️";
}

function renderTable() {
  const filter = $("monthFilter").value;
  const filtered = filter === "all"
    ? transactions
    : transactions.filter(t => String(t.tanggal || "").startsWith(filter));

  const tbody = $("transactionTable");
  tbody.innerHTML = "";

  $("emptyState").style.display = filtered.length ? "none" : "block";

  for (const item of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${dateToLabel(item.tanggal)}</td>
      <td><span class="person-pill">${item.nama}</span></td>
      <td><strong>${money(item.nominal)}</strong></td>
      <td>${escapeHtml(item.catatan || "-")}</td>
      <td>
        <div class="actions">
          <button class="action-btn edit-btn" data-edit="${item.id}">Edit</button>
          <button class="action-btn delete-btn" data-delete="${item.id}">Hapus</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("[data-edit]").forEach(btn => btn.addEventListener("click", () => openEdit(btn.dataset.edit)));
  tbody.querySelectorAll("[data-delete]").forEach(btn => btn.addEventListener("click", () => removeTransaction(btn.dataset.delete)));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function populateMonthFilter() {
  const select = $("monthFilter");
  const old = select.value;
  const months = [...new Set(transactions.map(t => String(t.tanggal || "").slice(0,7)).filter(Boolean))].sort().reverse();
  select.innerHTML = `<option value="all">Semua bulan</option>`;
  months.forEach(month => {
    const [y,m] = month.split("-");
    const label = new Intl.DateTimeFormat("id-ID", {month:"long", year:"numeric"})
      .format(new Date(Number(y), Number(m)-1, 1));
    select.insertAdjacentHTML("beforeend", `<option value="${month}">${label}</option>`);
  });
  select.value = months.includes(old) ? old : "all";
}

function updateChart() {
  const monthsCount = Number($("chartRange").value);
  const now = new Date();
  const labels = [];
  const totals = [];

  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    labels.push(new Intl.DateTimeFormat("id-ID", {month:"short", year:"2-digit"}).format(d));
    totals.push(transactions.filter(t => String(t.tanggal || "").startsWith(key))
      .reduce((s,t) => s + Number(t.nominal || 0), 0));
  }

  const ctx = $("savingsChart");
  if (chart) chart.destroy();

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--accent").trim();
  const muted = styles.getPropertyValue("--muted").trim();
  const border = styles.getPropertyValue("--border").trim();

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "Tabungan",
        data: totals,
        borderColor: accent,
        backgroundColor: accent + "22",
        fill: true,
        tension: .35,
        pointRadius: 3,
        pointBackgroundColor: accent
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {display:false},
        tooltip: {callbacks:{label: c => money(c.parsed.y)}}
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {color: muted, callback: value => money(value)},
          grid: {color: border}
        },
        x: {ticks:{color:muted}, grid:{display:false}}
      }
    }
  });
}

function startRealtimeListeners() {
  if (unsubscribeTransactions) unsubscribeTransactions();
  if (unsubscribeSettings) unsubscribeSettings();

  const transactionsQuery = query(
    collection(db, "transactions"),
    orderBy("tanggal", "desc")
  );

  unsubscribeTransactions = onSnapshot(transactionsQuery, snapshot => {
    transactions = snapshot.docs.map(d => ({id:d.id, ...d.data()}));
    populateMonthFilter();
    updateSummary();
    renderTable();
    updateChart();
  }, error => {
    console.error(error);
    showToast("Gagal membaca data Firebase.");
  });

  const settingsRef = doc(db, "settings", "app");
  unsubscribeSettings = onSnapshot(settingsRef, snapshot => {
    if (snapshot.exists()) {
      const data = snapshot.data();
      targetAmount = Number(data.targetAmount) || TARGET_DEFAULT;
      weddingDate = data.weddingDate || "";
    } else {
      targetAmount = TARGET_DEFAULT;
      weddingDate = "";
    }
    updateSummary();
  }, error => console.error(error));
}

async function addTransaction(event) {
  event.preventDefault();
  const button = event.submitter;
  const nama = $("person").value;
  const nominal = Number($("amount").value);
  const tanggal = $("date").value;
  const catatan = $("note").value.trim();

  if (!nominal || nominal <= 0 || !tanggal) {
    showToast("Lengkapi data tabungan.");
    return;
  }

  setLoading(button, true);
  try {
    await addDoc(collection(db, "transactions"), {
      nama,
      nominal: Math.trunc(nominal),
      tanggal,
      catatan,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp()
    });
    $("savingForm").reset();
    $("date").value = todayISO();
    showToast("Tabungan berhasil disimpan ❤️");
  } catch (error) {
    console.error(error);
    showToast("Gagal menyimpan tabungan.");
  } finally {
    setLoading(button, false);
  }
}

function openEdit(id) {
  const item = transactions.find(t => t.id === id);
  if (!item) return;
  editingId = id;
  $("editId").value = id;
  $("editPerson").value = item.nama;
  $("editAmount").value = item.nominal;
  $("editDate").value = item.tanggal;
  $("editNote").value = item.catatan || "";
  $("editDialog").showModal();
}

async function saveEdit(event) {
  event.preventDefault();
  if (!editingId) return;
  try {
    await updateDoc(doc(db, "transactions", editingId), {
      nama: $("editPerson").value,
      nominal: Math.trunc(Number($("editAmount").value)),
      tanggal: $("editDate").value,
      catatan: $("editNote").value.trim()
    });
    $("editDialog").close();
    showToast("Transaksi diperbarui.");
    editingId = null;
  } catch (error) {
    console.error(error);
    showToast("Gagal memperbarui transaksi.");
  }
}

async function removeTransaction(id) {
  const item = transactions.find(t => t.id === id);
  if (!item) return;
  if (!confirm(`Hapus tabungan ${money(item.nominal)} milik ${item.nama}?`)) return;
  try {
    await deleteDoc(doc(db, "transactions", id));
    showToast("Transaksi dihapus.");
  } catch (error) {
    console.error(error);
    showToast("Gagal menghapus transaksi.");
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const target = Math.trunc(Number($("settingsTarget").value));
  const date = $("settingsWeddingDate").value || "";
  if (!target || target <= 0) {
    showToast("Target tabungan harus lebih dari 0.");
    return;
  }
  try {
    await setDoc(doc(db, "settings", "app"), {
      targetAmount: target,
      weddingDate: date,
      updatedBy: currentUser.uid,
      updatedAt: serverTimestamp()
    }, {merge:true});
    $("settingsDialog").close();
    showToast("Pengaturan target disimpan ❤️");
  } catch (error) {
    console.error(error);
    showToast("Gagal menyimpan pengaturan.");
  }
}

function openSettings() {
  $("settingsTarget").value = targetAmount;
  $("settingsWeddingDate").value = weddingDate;
  $("settingsDialog").showModal();
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "dark") document.documentElement.classList.add("dark");
  $("themeToggle").textContent = document.documentElement.classList.contains("dark") ? "☀" : "☾";
}

function toggleTheme() {
  document.documentElement.classList.toggle("dark");
  const dark = document.documentElement.classList.contains("dark");
  localStorage.setItem("theme", dark ? "dark" : "light");
  $("themeToggle").textContent = dark ? "☀" : "☾";
  updateChart();
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch (error) {
    console.error(error);
    $("loginError").textContent = "Email atau password salah atau akun belum dibuat.";
  }
});

$("logoutButton").addEventListener("click", () => signOut(auth));
$("savingForm").addEventListener("submit", addTransaction);
$("editForm").addEventListener("submit", saveEdit);
$("settingsForm").addEventListener("submit", saveSettings);
$("monthFilter").addEventListener("change", renderTable);
$("chartRange").addEventListener("change", updateChart);
$("themeToggle").addEventListener("click", toggleTheme);
$("settingsButton").addEventListener("click", openSettings);

["closeEdit","cancelEdit"].forEach(id => $(id).addEventListener("click", () => $("editDialog").close()));
["closeSettings","cancelSettings"].forEach(id => $(id).addEventListener("click", () => $("settingsDialog").close()));

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    $("editDialog").close();
    $("settingsDialog").close();
  }
});

$("date").value = todayISO();
initTheme();

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    $("loginPage").classList.add("hidden");
    $("appPage").classList.remove("hidden");
    const email = (user.email || "").toLowerCase();
    $("currentUserName").textContent = email.includes("muzdoug") ? "Muzdoug" : "Fatih";
    startRealtimeListeners();
  } else {
    $("appPage").classList.add("hidden");
    $("loginPage").classList.remove("hidden");
    if (unsubscribeTransactions) unsubscribeTransactions();
    if (unsubscribeSettings) unsubscribeSettings();
    unsubscribeTransactions = null;
    unsubscribeSettings = null;
  }
});
