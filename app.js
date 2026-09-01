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
  setDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

import { Chart, registerables } from "https://cdn.jsdelivr.net/npm/chart.js@4.5.0/+esm";
Chart.register(...registerables);

const $ = (id) => document.getElementById(id);
const TARGET_DEFAULT = 50000000;
const CHALLENGE_PATTERN = [25000,25000,50000,50000,50000,50000,75000,75000,100000];
const CHALLENGE_ROWS = 20;
const CHALLENGE_CELLS = CHALLENGE_ROWS * CHALLENGE_PATTERN.length;
const CHALLENGE_TOTAL = CHALLENGE_PATTERN.reduce((a,b) => a+b, 0) * CHALLENGE_ROWS;

let transactions = [];
let challengeClaims = { Fatih: {}, Muzdoug: {} };
let targetAmount = TARGET_DEFAULT;
let weddingDate = "";
let unsubscribeTransactions = null;
let unsubscribeSettings = null;
let unsubscribeChallenge = null;
let unsubscribeChallengeSettings = null;
let chart = null;
let editingId = null;
let currentUser = null;
let activeChallengeId = null;

// Setiap orang mempunyai nomor challenge sendiri.
// Challenge #1 memakai data lama (tanpa challengeNumber) agar data yang
// sudah ada tetap tampil. Challenge berikutnya memakai dokumen baru.
let currentChallengeNumber = {
  Fatih: 1,
  Muzdoug: 1
};

// Mencegah snapshot realtime menjalankan proses reset yang sama berulang kali.
let challengeCompletionLock = {
  Fatih: 0,
  Muzdoug: 0
};

// ID transaksi yang sedang dihapus. Ini mencegah listener realtime
// yang masih membawa snapshot lama menganggap challenge masih penuh.
const pendingDeletedTransactions = new Set();

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
  renderChallenge();
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
    const sourceLabel = item.source === "challenge" ? `<span class="source-pill">Challenge</span>` : "";
    tr.innerHTML = `
      <td>${dateToLabel(item.tanggal)}</td>
      <td><span class="person-pill">${escapeHtml(item.nama)}</span></td>
      <td><strong>${money(item.nominal)}</strong></td>
      <td>${escapeHtml(item.catatan || "-")} ${sourceLabel}</td>
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
        y: {beginAtZero:true, ticks:{color:muted, callback:value => money(value)}, grid:{color:border}},
        x: {ticks:{color:muted}, grid:{display:false}}
      }
    }
  });
}

function challengeCellId(index) {
  return `cell-${String(index + 1).padStart(3,"0")}`;
}

function challengeDocId(person, cellId, challengeNumber = 1) {
  // Pertahankan ID challenge #1 agar data lama tetap kompatibel.
  if (Number(challengeNumber) === 1) {
    return `${person}-${cellId}`;
  }

  return `${person}-challenge-${challengeNumber}-${cellId}`;
}

function challengeHistoryDocId(person, challengeNumber) {
  return `${person}-challenge-${challengeNumber}`;
}

function challengeSettingsDocId(person) {
  return person;
}

function challengeNominal(index) {
  return CHALLENGE_PATTERN[index % CHALLENGE_PATTERN.length];
}

function challengeShort(nominal) {
  return `${nominal / 1000}K`;
}

/*
 * =========================================================
 * SMART AUTO-CORET
 * =========================================================
 *
 * Satu transaksi dapat mencoret beberapa kotak sekaligus.
 * Contoh:
 * Rp150.000 -> 100K + 50K
 * Rp125.000 -> 100K + 25K
 * Rp75.000  -> 75K
 *
 * Algoritma memilih kombinasi terbesar yang tidak melebihi
 * nominal transaksi. Jika kombinasi tepat tersedia, dipilih
 * kombinasi tepat.
 */

function getAvailableChallengeCells(person, excludeTransactionId = null) {
  const round = currentChallengeNumber[person] || 1;
  const claims = challengeClaims[person] || {};
  const available = [];

  for (let i = 0; i < CHALLENGE_CELLS; i++) {
    const cellId = challengeCellId(i);
    const nominal = challengeNominal(i);
    const claim = claims[cellId];

    if (!claim) {
      available.push({
        cellId,
        nominal,
        index: i
      });
      continue;
    }

    // Saat edit, kotak milik transaksi yang sedang diedit
    // dianggap kosong terlebih dahulu.
    if (
      excludeTransactionId &&
      claim.transactionId === excludeTransactionId
    ) {
      available.push({
        cellId,
        nominal,
        index: i
      });
    }
  }

  return available;
}

function chooseChallengeAllocation(
  person,
  amount,
  excludeTransactionId = null
) {
  const available =
    getAvailableChallengeCells(
      person,
      excludeTransactionId
    );

  const target =
    Math.max(
      0,
      Math.floor(Number(amount) / 25000)
    );

  if (!target || !available.length) {
    return {
      cells: [],
      allocatedAmount: 0,
      remainder: Math.max(0, Number(amount) || 0)
    };
  }

  /*
   * DP berdasarkan kelipatan Rp25.000.
   * Nilai maksimal Challenge = Rp10.000.000,
   * sehingga target maksimum hanya 400 state.
   */
  const best = new Array(target + 1).fill(null);
  best[0] = [];

  // Kelompokkan cell berdasarkan nominal agar kombinasi
  // tidak mengambil lebih banyak kotak daripada yang tersedia.
  const groups = new Map();

  available.forEach(cell => {
    if (!groups.has(cell.nominal)) {
      groups.set(cell.nominal, []);
    }
    groups.get(cell.nominal).push(cell);
  });

  const denominations = [...groups.keys()]
    .sort((a, b) => b - a);

  for (const nominal of denominations) {
    const cells = groups.get(nominal);
    const units = nominal / 25000;

    // Bounded knapsack menggunakan salinan state.
    const previous = best.map(
      value => value ? [...value] : null
    );

    for (let sum = 0; sum <= target; sum++) {
      if (!previous[sum]) continue;

      for (
        let count = 1;
        count <= cells.length;
        count++
      ) {
        const nextSum =
          sum + units * count;

        if (nextSum > target) break;

        const candidate = [
          ...previous[sum],
          ...cells
            .slice(0, count)
            .map(cell => cell.cellId)
        ];

        // Utamakan:
        // 1. nilai lebih besar
        // 2. jumlah kotak lebih sedikit
        if (
          !best[nextSum] ||
          candidate.length <
            best[nextSum].length
        ) {
          best[nextSum] = candidate;
        }
      }
    }
  }

  // Cari nilai terbesar <= target.
  let bestUnits = target;

  while (
    bestUnits > 0 &&
    !best[bestUnits]
  ) {
    bestUnits--;
  }

  const cells =
    (best[bestUnits] || [])
      .map(cellId =>
        available.find(
          cell => cell.cellId === cellId
        )
      )
      .filter(Boolean);

  const allocatedAmount =
    bestUnits * 25000;

  return {
    cells,
    allocatedAmount,
    remainder:
      Math.max(
        0,
        Number(amount) - allocatedAmount
      )
  };
}

function allocationTotal(allocation = []) {
  return allocation.reduce(
    (sum, cell) =>
      sum + Number(cell.nominal || 0),
    0
  );
}

function getLoggedPerson() {
  const email = (currentUser?.email || "").toLowerCase();

  // Saat ini identitas akun ditentukan dari email.
  // Untuk versi final produksi, UID Firebase dapat dikunci di Rules.
  return email.includes("muzdoug") ? "Muzdoug" : "Fatih";
}

function renderPersonalChallenge(person) {
  const prefix = person.toLowerCase();
  const grid = $(`${prefix}ChallengeGrid`);
  if (!grid) return { completed: 0, claimedTotal: 0 };

  grid.innerHTML = "";

  let completed = 0;
  let claimedTotal = 0;

  const isOwner =
    getLoggedPerson() === person;

  const round =
    currentChallengeNumber[person] || 1;

  // Tampilkan nomor challenge jika elemen tersedia.
  const roundLabel =
    $(`${prefix}ChallengeRound`);

  if (roundLabel) {
    roundLabel.textContent =
      `Challenge #${round}`;
  }

  for (
    let i = 0;
    i < CHALLENGE_CELLS;
    i++
  ) {

    const cellId =
      challengeCellId(i);

    const nominal =
      challengeNominal(i);

    const claim =
      challengeClaims[person]?.[cellId];

    const button =
      document.createElement("button");

    button.type = "button";

    button.className =
      `challenge-cell ${
        claim ? "claimed" : ""
      } ${
        !isOwner ? "readonly" : ""
      }`;

    button.dataset.challengeId =
      cellId;

    button.dataset.challengePerson =
      person;

    button.disabled =
      !isOwner;

    button.setAttribute(
      "aria-label",
      `${person} ${challengeShort(nominal)}${
        claim
          ? ` sudah dicoret oleh ${claim.nama}`
          : " belum dicoret"
      }`
    );

    button.innerHTML =
      claim
        ? `<span class="challenge-amount">${challengeShort(nominal)}</span>
           <span class="challenge-check">✓</span>
           <span class="challenge-owner">${escapeHtml(claim.nama)}</span>`
        : `<span class="challenge-amount">${challengeShort(nominal)}</span>`;

    button.addEventListener(
      "click",
      () =>
        openChallenge(
          person,
          cellId,
          nominal
        )
    );

    grid.appendChild(button);

    if (claim) {
      completed++;
      claimedTotal += nominal;
    }
  }

  const progress =
    CHALLENGE_TOTAL
      ? claimedTotal /
        CHALLENGE_TOTAL *
        100
      : 0;

  const totalEl =
    $(`${prefix}ChallengeTotal`);

  const completedEl =
    $(`${prefix}ChallengeCompleted`);

  const progressEl =
    $(`${prefix}ChallengeProgress`);

  const barEl =
    $(`${prefix}ChallengeProgressBar`);

  if (totalEl) {
    totalEl.textContent =
      money(claimedTotal);
  }

  if (completedEl) {
    completedEl.textContent =
      completed;
  }

  if (progressEl) {
    progressEl.textContent =
      `${progress.toFixed(1)}%`;
  }

  if (barEl) {
    barEl.style.width =
      `${Math.min(progress, 100)}%`;
  }

  const hint =
    $(`${prefix}ChallengeHint`);

  if (hint) {

    if (completed >= CHALLENGE_CELLS) {

      hint.textContent =
        `🎉 Challenge #${round} selesai! Challenge berikutnya akan dimulai otomatis. ❤️`;

    } else if (isOwner) {

      hint.textContent =
        `💡 Ini tabel ${person}. Klik nominal yang berhasil ditabung untuk mencoretnya.`;

    } else {

      hint.textContent =
        `🔒 Ini tabel ${person}. Hanya ${person} yang dapat mencoret nominal.`;

    }
  }

  return {
    completed,
    claimedTotal,
    round
  };
}
function renderChallenge() {
  const fatih = renderPersonalChallenge("Fatih");
  const muzdoug = renderPersonalChallenge("Muzdoug");
  const combined = fatih.claimedTotal + muzdoug.claimedTotal;
  const combinedProgress = CHALLENGE_TOTAL * 2 ? combined / (CHALLENGE_TOTAL * 2) * 100 : 0;

  if ($("challengeCombinedTotal")) {
    $("challengeCombinedTotal").textContent = money(combined);
  }
}

function openChallenge(person, cellId, nominal) {
  const claim = challengeClaims[person]?.[cellId];
  const isOwner = getLoggedPerson() === person;
  if (!isOwner) {
    showToast(`Tabel ${person} hanya dapat diisi oleh ${person}.`);
    return;
  }

  activeChallengeId = `${person}|${cellId}`;
  $("challengeId").value = cellId;
  $("challengeOwner").value = person;
  $("challengeNominal").textContent = money(nominal);
  $("challengeDate").value = claim?.tanggal || todayISO();
  $("challengePerson").value = person;
  $("challengePerson").disabled = true;
  $("challengeNote").value = claim?.catatan || "Tabungan challenge ❤️";

  if (claim) {
    $("challengeDialogTitle").textContent = `Nominal ${person} sudah dicoret ❤️`;
    $("challengeClaimInfo").textContent = `Dicoret oleh ${claim.nama} pada ${dateToLabel(claim.tanggal)}. Kamu bisa membatalkannya jika terjadi kesalahan.`;
    $("saveChallenge").classList.add("hidden");
    $("unclaimChallenge").classList.remove("hidden");
  } else {
    $("challengeDialogTitle").textContent = `Coret nominal ${person}?`;
    $("challengeClaimInfo").textContent = `Setelah disimpan, nominal ini otomatis masuk ke tabungan ${person} dan riwayat transaksi.`;
    $("saveChallenge").classList.remove("hidden");
    $("unclaimChallenge").classList.add("hidden");
  }

  $("challengeDialog").showModal();
}

async function claimChallenge(event) {
  event.preventDefault();

  if (!activeChallengeId || !currentUser) {
    return;
  }

  const [person, cellId] =
    activeChallengeId.split("|");

  if (
    getLoggedPerson() !== person ||
    challengeClaims[person]?.[cellId]
  ) {
    return;
  }

  const nominal =
    challengeNominal(
      Number(
        cellId.replace("cell-", "")
      ) - 1
    );

  const nama = person;

  const tanggal =
    $("challengeDate").value;

  const catatan =
    $("challengeNote").value.trim() ||
    "Tabungan challenge ❤️";

  if (!tanggal) {
    showToast(
      "Tanggal harus diisi."
    );
    return;
  }

  const button =
    $("saveChallenge");

  setLoading(
    button,
    true
  );

  try {

    const round =
      currentChallengeNumber[person] ||
      1;

    const challengeDocumentId =
      challengeDocId(
        person,
        cellId,
        round
      );

    const batch =
      writeBatch(db);

    const transactionRef =
      doc(
        collection(
          db,
          "transactions"
        )
      );

    const cellRef =
      doc(
        db,
        "challengeCells",
        challengeDocumentId
      );


    // =====================================================
    // TRANSAKSI
    // =====================================================

    batch.set(
      transactionRef,
      {
        nama,
        nominal,
        tanggal,
        catatan,

        source:
          "challenge",

        challengeId:
          cellId,

        challengeOwner:
          person,

        challengeNumber:
          round,

        challengeDocId:
          challengeDocumentId,

        challengeAllocations:
          [{
            cellId:
              cellId,
            nominal:
              nominal
          }],

        allocatedChallengeAmount:
          nominal,

        challengeRemainder:
          0,

        ownerUid:
          currentUser.uid,

        createdBy:
          currentUser.uid,

        createdAt:
          serverTimestamp()
      }
    );


    // =====================================================
    // CELL CHALLENGE
    // =====================================================

    batch.set(
      cellRef,
      {
        nominal,
        nama,

        ownerName:
          person,

        ownerUid:
          currentUser.uid,

        tanggal,
        catatan,

        transactionId:
          transactionRef.id,

        claimedBy:
          currentUser.uid,

        claimedAt:
          serverTimestamp(),

        challengeId:
          cellId,

        challengeNumber:
          round,

        challengeDocId:
          challengeDocumentId
      }
    );


    await batch.commit();

    $("challengeDialog")?.close();

    activeChallengeId =
      null;

    showToast(
      `${money(nominal)} berhasil dicoret di tabel ${person} ❤️`
    );

  } catch (error) {

    console.error(
      "CLAIM ERROR:",
      error
    );

    showToast(
      error?.code ===
      "permission-denied"
        ? "Firebase menolak penyimpanan. Pastikan Rules sudah dipublish."
        : "Gagal menyimpan challenge."
    );

  } finally {

    setLoading(
      button,
      false
    );

  }
}
async function unclaimChallenge() {
  if (
    !activeChallengeId ||
    !currentUser
  ) {
    return;
  }

  const [person, cellId] =
    activeChallengeId.split("|");

  const claim =
    challengeClaims[person]?.[cellId];

  if (
    !claim ||
    getLoggedPerson() !== person
  ) {
    showToast(
      "Kamu hanya dapat membatalkan tabel milikmu."
    );
    return;
  }

  if (
    claim.ownerUid &&
    claim.ownerUid !== currentUser.uid
  ) {
    showToast(
      "Coretan ini bukan milik akun yang sedang login."
    );
    return;
  }

  if (
    !confirm(
      `Batalkan coretan ${money(claim.nominal)} milik ${person}? Transaksi challenge juga akan dihapus dari riwayat.`
    )
  ) {
    return;
  }

  try {

    const batch =
      writeBatch(db);

    const challengeDocumentId =
      claim.docId ||
      claim.challengeDocId ||
      challengeDocId(
        person,
        cellId,
        claim.challengeNumber ||
          currentChallengeNumber[person] ||
          1
      );

    batch.delete(
      doc(
        db,
        "challengeCells",
        challengeDocumentId
      )
    );

    if (claim.transactionId) {

      batch.delete(
        doc(
          db,
          "transactions",
          claim.transactionId
        )
      );

    }

    await batch.commit();

    $("challengeDialog")?.close();

    activeChallengeId =
      null;

    // Membuka kembali challenge yang selesai
    // jika pengguna membatalkan kotak terakhir.
    challengeCompletionLock[person] = 0;

    showToast(
      "Coretan dibatalkan ❤️"
    );

  } catch (error) {

    console.error(
      "UNCLAIM ERROR:",
      error
    );

    showToast(
      error?.code ===
      "permission-denied"
        ? "Firebase menolak pembatalan. Pastikan Rules sudah dipublish."
        : "Gagal membatalkan coretan."
    );
  }
}


// =========================================================
// CHALLENGE ROUND REPAIR / RECOVERY
// =========================================================
// Mencegah nomor challenge meloncat ketika listener Firestore
// menerima snapshot dalam urutan yang berbeda. Nomor hanya boleh
// turun jika ternyata settings menunjuk ke ronde yang lebih tinggi
// daripada data transaksi yang benar-benar ada.

function calculateExpectedChallengeUpperBound(person, list = transactions) {
  const rounds = new Map();

  for (const tx of list) {
    if (tx.nama !== person) continue;

    const source = tx.source || "manual";
    const isChallenge =
      source === "challenge-auto" ||
      source === "challenge";

    if (!isChallenge) continue;

    const round = Number(tx.challengeNumber) || 1;

    let amount = Number(tx.allocatedChallengeAmount);

    if (!amount && Array.isArray(tx.challengeAllocations)) {
      amount = tx.challengeAllocations.reduce(
        (sum, cell) => sum + Number(cell?.nominal || 0),
        0
      );
    }

    if (!amount && source === "challenge") {
      amount = Number(tx.nominal) || 0;
    }

    rounds.set(
      round,
      (rounds.get(round) || 0) + amount
    );
  }

  if (!rounds.size) return 1;

  const highestRound = Math.max(...rounds.keys());
  const highestAmount = rounds.get(highestRound) || 0;

  // Jika ronde tertinggi sudah penuh, ronde aktif berikutnya adalah +1.
  // Jika belum penuh, ronde tertinggi masih menjadi ronde aktif.
  return highestAmount >= CHALLENGE_TOTAL
    ? highestRound + 1
    : highestRound;
}

async function repairChallengeRoundFromTransactions(person, list = transactions) {
  const current =
    currentChallengeNumber[person] || 1;

  const expected =
    calculateExpectedChallengeUpperBound(
      person,
      list
    );

  // Jika data transaksi menunjukkan ronde aktif yang lebih rendah,
  // turunkan settings sekarang juga. Ini penting setelah transaksi
  // bernilai besar dihapus.
  if (current === expected) return;

  // Jangan menaikkan nomor challenge dari fungsi recovery.
  // Kenaikan normal hanya dilakukan completeChallenge().
  if (current < expected) return;

  try {
    await setDoc(
      doc(
        db,
        "challengeSettings",
        challengeSettingsDocId(person)
      ),
      {
        person,
        currentChallenge: expected,
        repairedAt: serverTimestamp(),
        repairedBy: currentUser?.uid || null
      },
      { merge: true }
    );

    currentChallengeNumber[person] = expected;
    challengeCompletionLock[person] = 0;

    // Bersihkan cell lama yang berasal dari ronde yang lebih tinggi
    // dari ronde yang sekarang dianggap aktif. Ini hanya dilakukan
    // untuk cell yang sudah tidak mempunyai transaksi sumber.
    Object.entries(challengeClaims[person] || {}).forEach(
      ([cellId, claim]) => {
        const claimRound = Number(claim?.challengeNumber) || 1;
        if (claimRound <= expected) return;

        if (claim?.transactionId) {
          const sourceExists = list.some(
            tx => tx.id === claim.transactionId
          );
          if (!sourceExists) {
            delete challengeClaims[person][cellId];
          }
        }
      }
    );

    console.warn(
      `Nomor challenge ${person} diperbaiki: #${current} -> #${expected}`
    );

    renderChallenge();
  } catch (error) {
    console.error(
      `Gagal memperbaiki nomor challenge ${person}:`,
      error
    );
  }
}

// =========================================================
// AUTO NEXT CHALLENGE
// =========================================================

async function completeChallenge(
  person,
  completedRound
) {

  // Hanya ronde yang sedang aktif boleh diselesaikan.
  // Ini mencegah snapshot lama menaikkan #2 menjadi #3, #4, dst.
  if (
    (currentChallengeNumber[person] || 1) !==
    completedRound
  ) {
    return;
  }

  if (
    challengeCompletionLock[person] ===
    completedRound
  ) {
    return;
  }

  // Jangan menyelesaikan ulang challenge berdasarkan snapshot lama
  // jika transaksi sumbernya sedang dihapus.
  const hasDeletedSource = transactions.some(
    tx =>
      tx.nama === person &&
      Number(tx.challengeNumber) === completedRound &&
      pendingDeletedTransactions.has(tx.id)
  );

  if (hasDeletedSource) {
    return;
  }

  const roundAllocatedAmount = transactions
    .filter(
      tx =>
        tx.nama === person &&
        !pendingDeletedTransactions.has(tx.id) &&
        Number(tx.challengeNumber) === completedRound
    )
    .reduce((sum, tx) => {
      let amount = Number(tx.allocatedChallengeAmount || 0);
      if (!amount && Array.isArray(tx.challengeAllocations)) {
        amount = tx.challengeAllocations.reduce(
          (inner, cell) => inner + Number(cell?.nominal || 0),
          0
        );
      }
      if (!amount && tx.source === "challenge") {
        amount = Number(tx.nominal || 0);
      }
      return sum + amount;
    }, 0);

  // 180 kotak hanya boleh memajukan ronde jika transaksi yang masih
  // tersimpan memang membiayai seluruh nominal ronde tersebut.
  if (roundAllocatedAmount < CHALLENGE_TOTAL) {
    return;
  }

  challengeCompletionLock[person] =
    completedRound;

  try {

    const nextRound =
      completedRound + 1;

    const historyRef =
      doc(
        db,
        "challengeHistory",
        challengeHistoryDocId(
          person,
          completedRound
        )
      );

    const settingsRef =
      doc(
        db,
        "challengeSettings",
        challengeSettingsDocId(
          person
        )
      );

    const batch =
      writeBatch(db);


    // Simpan sejarah challenge yang selesai.
    batch.set(
      historyRef,
      {
        person,

        challengeNumber:
          completedRound,

        totalCells:
          CHALLENGE_CELLS,

        totalAmount:
          CHALLENGE_TOTAL,

        completedAt:
          serverTimestamp(),

        completedBy:
          currentUser?.uid || null
      },
      {
        merge: true
      }
    );


    // Pindah ke challenge berikutnya.
    batch.set(
      settingsRef,
      {
        person,

        currentChallenge:
          nextRound,

        updatedAt:
          serverTimestamp()
      },
      {
        merge: true
      }
    );


    await batch.commit();

    showToast(
      `🎉 ${person} menyelesaikan Challenge #${completedRound}! Challenge #${nextRound} dimulai ❤️`
    );

  } catch (error) {

    // Buka lock agar bisa dicoba kembali
    // jika Firebase sedang gagal sementara.
    challengeCompletionLock[person] = 0;

    console.error(
      "AUTO NEXT CHALLENGE ERROR:",
      error
    );

    showToast(
      "Challenge selesai, tetapi pembuatan challenge berikutnya gagal. Coba beberapa saat lagi."
    );
  }
}

function checkChallengeCompletion(
  person
) {

  const claims =
    challengeClaims[person] || {};

  const completed =
    Object.keys(claims).length;

  const round =
    currentChallengeNumber[person] ||
    1;

  if (
    completed >= CHALLENGE_CELLS
  ) {

    completeChallenge(
      person,
      round
    );
  }
}
function startRealtimeListeners() {

  if (unsubscribeTransactions)
    unsubscribeTransactions();

  if (unsubscribeSettings)
    unsubscribeSettings();

  if (unsubscribeChallenge)
    unsubscribeChallenge();

  if (unsubscribeChallengeSettings)
    unsubscribeChallengeSettings();


  // =======================================================
  // TRANSACTIONS
  // =======================================================

  const transactionsQuery =
    query(
      collection(
        db,
        "transactions"
      ),
      orderBy(
        "tanggal",
        "desc"
      )
    );

  unsubscribeTransactions =
    onSnapshot(
      transactionsQuery,
      snapshot => {

        transactions =
          snapshot.docs.map(
            d => ({
              id: d.id,
              ...d.data()
            })
          );

        populateMonthFilter();
        updateSummary();
        renderTable();
        updateChart();

        // Recovery jika challengeSettings pernah meloncat terlalu jauh.
        repairChallengeRoundFromTransactions("Fatih");
        repairChallengeRoundFromTransactions("Muzdoug");

      },
      error => {

        console.error(
          "TRANSACTIONS LISTENER:",
          error
        );

        showToast(
          "Gagal membaca data Firebase."
        );
      }
    );


  // =======================================================
  // APP SETTINGS
  // =======================================================

  const settingsRef =
    doc(
      db,
      "settings",
      "app"
    );

  unsubscribeSettings =
    onSnapshot(
      settingsRef,
      snapshot => {

        if (snapshot.exists()) {

          const data =
            snapshot.data();

          targetAmount =
            Number(
              data.targetAmount
            ) ||
            TARGET_DEFAULT;

          weddingDate =
            data.weddingDate ||
            "";

        } else {

          targetAmount =
            TARGET_DEFAULT;

          weddingDate =
            "";
        }

        updateSummary();

      },
      error =>
        console.error(
          "SETTINGS LISTENER:",
          error
        )
    );


  // =======================================================
  // CHALLENGE SETTINGS / CURRENT ROUND
  // =======================================================

  unsubscribeChallengeSettings =
    onSnapshot(
      collection(
        db,
        "challengeSettings"
      ),
      async snapshot => {

        let changed = false;

        for (
          const person of [
            "Fatih",
            "Muzdoug"
          ]
        ) {

          const setting =
            snapshot.docs.find(
              d =>
                d.id === person
            );

          if (
            setting &&
            setting.exists()
          ) {

            const number =
              Number(
                setting.data()
                  .currentChallenge
              ) || 1;

            if (
              currentChallengeNumber[
                person
              ] !== number
            ) {

              currentChallengeNumber[
                person
              ] = number;

              // Challenge baru harus dapat menyelesaikan
              // proses completion-nya sendiri.
              challengeCompletionLock[
                person
              ] = 0;

              changed = true;
            }

          } else {

            // Dokumen belum ada:
            // buat Challenge #1 agar struktur konsisten.
            try {

              await setDoc(
                doc(
                  db,
                  "challengeSettings",
                  person
                ),
                {
                  person,
                  currentChallenge: 1,
                  createdAt:
                    serverTimestamp()
                },
                {
                  merge: true
                }
              );

            } catch (error) {

              console.error(
                `Gagal membuat challengeSettings ${person}:`,
                error
              );
            }
          }
        }

        if (changed) {
          renderChallenge();
        }

        // Jangan cek completion di listener settings.
        // Snapshot challengeCells adalah satu-satunya sumber kebenaran
        // untuk menentukan 180 kotak benar-benar selesai.

      },
      error => {

        console.error(
          "CHALLENGE SETTINGS LISTENER:",
          error
        );

        showToast(
          "Gagal membaca pengaturan Savings Challenge."
        );
      }
    );


  // =======================================================
  // CHALLENGE CELLS
  // =======================================================

  unsubscribeChallenge =
    onSnapshot(
      collection(
        db,
        "challengeCells"
      ),
      snapshot => {

        challengeClaims = {
          Fatih: {},
          Muzdoug: {}
        };


        snapshot.docs.forEach(
          d => {

            const data =
              d.data();

            const owner =
              data.ownerName ||
              data.nama;

            if (
              owner !== "Fatih" &&
              owner !== "Muzdoug"
            ) {
              return;
            }


            const round =
              Number(
                data.challengeNumber
              ) || 1;

            const currentRound =
              currentChallengeNumber[
                owner
              ] || 1;


            // Data lama tanpa challengeNumber
            // dianggap sebagai Challenge #1.
            if (
              round !== currentRound
            ) {
              return;
            }


            const cellId =
              data.challengeId ||
              (
                d.id.startsWith(
                  `${owner}-challenge-`
                )
                  ? d.id.substring(
                      `${owner}-challenge-${round}-`
                        .length
                    )
                  : d.id.startsWith(
                      `${owner}-`
                    )
                      ? d.id.slice(
                          owner.length + 1
                        )
                      : d.id
              );


            challengeClaims[
              owner
            ][cellId] = {

              id:
                d.id,

              docId:
                d.id,

              challengeDocId:
                d.id,

              ...data

            };

          }
        );


        renderChallenge();

        checkChallengeCompletion(
          "Fatih"
        );

        checkChallengeCompletion(
          "Muzdoug"
        );

      },
      error => {

        console.error(
          "CHALLENGE LISTENER:",
          error
        );

        showToast(
          "Gagal membaca Savings Challenge."
        );
      }
    );
}
async function addTransaction(event) {
  event.preventDefault();

  const button = event.submitter;
  const nama = getLoggedPerson();
  const nominal = Math.trunc(
    Number($("amount").value)
  );

  if ($("person")) {
    $("person").value = nama;
  }

  const tanggal = $("date").value;
  const catatan = $("note").value.trim();

  if (
    !nominal ||
    nominal <= 0 ||
    !tanggal
  ) {
    showToast("Lengkapi data tabungan.");
    return;
  }

  setLoading(button, true);

  try {
    const round =
      currentChallengeNumber[nama] || 1;

    /*
     * Cari kombinasi kotak terbaik.
     * Contoh Rp150.000 -> 100K + 50K.
     */
    const allocation =
      chooseChallengeAllocation(
        nama,
        nominal
      );

    const transactionRef =
      doc(
        collection(
          db,
          "transactions"
        )
      );

    const batch =
      writeBatch(db);

    const allocationData =
      allocation.cells.map(cell => ({
        cellId: cell.cellId,
        nominal: cell.nominal
      }));

    /*
     * Simpan transaksi utama.
     */
    batch.set(
      transactionRef,
      {
        nama,
        nominal,
        tanggal,
        catatan,

        source:
          allocationData.length
            ? "challenge-auto"
            : "manual",

        ownerUid:
          currentUser.uid,

        createdBy:
          currentUser.uid,

        challengeOwner:
          nama,

        challengeNumber:
          round,

        challengeAllocations:
          allocationData,

        allocatedChallengeAmount:
          allocation.allocatedAmount,

        challengeRemainder:
          allocation.remainder,

        createdAt:
          serverTimestamp()
      }
    );

    /*
     * Simpan setiap kotak yang otomatis dicoret.
     */
    allocation.cells.forEach(cell => {

      const challengeDocumentId =
        challengeDocId(
          nama,
          cell.cellId,
          round
        );

      batch.set(
        doc(
          db,
          "challengeCells",
          challengeDocumentId
        ),
        {
          nominal:
            cell.nominal,

          nama,

          ownerName:
            nama,

          ownerUid:
            currentUser.uid,

          tanggal,

          catatan,

          transactionId:
            transactionRef.id,

          claimedBy:
            currentUser.uid,

          claimedAt:
            serverTimestamp(),

          challengeId:
            cell.cellId,

          challengeNumber:
            round,

          challengeDocId:
            challengeDocumentId
        }
      );
    });

    await batch.commit();

    $("savingForm").reset();
    $("date").value = todayISO();

    if (
      allocation.remainder > 0
    ) {
      showToast(
        `Rp${new Intl.NumberFormat("id-ID").format(nominal)} tersimpan. Challenge mencoret ${money(allocation.allocatedAmount)}, sisa ${money(allocation.remainder)} tetap tercatat ❤️`
      );
    } else if (
      allocation.cells.length > 0
    ) {
      const combination =
        allocation.cells
          .map(cell =>
            challengeShort(
              cell.nominal
            )
          )
          .join(" + ");

      showToast(
        `${money(nominal)} berhasil disimpan. Challenge: ${combination} ✓ ❤️`
      );
    } else {
      showToast(
        "Tabungan berhasil disimpan ❤️"
      );
    }

  } catch (error) {

    console.error(
      "ADD TRANSACTION ERROR:",
      error
    );

    showToast(
      error?.code ===
      "permission-denied"
        ? "Firebase menolak penyimpanan. Pastikan Rules sudah dipublish."
        : "Gagal menyimpan tabungan."
    );

  } finally {

    setLoading(
      button,
      false
    );
  }
}

function openEdit(id) {
  const item =
    transactions.find(
      t => t.id === id
    );

  if (!item) {
    showToast(
      "Transaksi tidak ditemukan."
    );
    return;
  }

  const owner =
    item.challengeOwner ||
    item.nama;

  const loggedPerson =
    getLoggedPerson();

  // Ownership.
  if (
    item.ownerUid &&
    currentUser &&
    item.ownerUid !== currentUser.uid
  ) {
    showToast(
      "Transaksi ini bukan milik akun yang sedang login."
    );
    return;
  }

  if (
    !item.ownerUid &&
    item.createdBy &&
    currentUser &&
    item.createdBy !== currentUser.uid
  ) {
    showToast(
      "Transaksi ini bukan milik akun yang sedang login."
    );
    return;
  }

  if (
    owner !== loggedPerson
  ) {
    showToast(
      `Transaksi ${owner} hanya dapat diedit oleh ${owner}.`
    );
    return;
  }

  editingId = id;

  if ($("editId")) {
    $("editId").value = id;
  }

  if ($("editPerson")) {
    $("editPerson").value =
      owner;
    $("editPerson").disabled =
      true;
  }

  if ($("editAmount")) {
    $("editAmount").value =
      item.nominal;
    $("editAmount").disabled =
      false;
  }

  if ($("editDate")) {
    $("editDate").value =
      item.tanggal;
  }

  if ($("editNote")) {
    $("editNote").value =
      item.catatan || "";
  }

  if ($("editChallengeHint")) {
    $("editChallengeHint").textContent =
      "Nominal dapat diubah. Sistem akan mengembalikan coretan lama lalu menghitung ulang kotak Challenge secara otomatis.";
  }

  $("editDialog")?.showModal();
}


async function saveEdit(event) {
  event.preventDefault();

  if (
    !editingId ||
    !currentUser
  ) {
    showToast(
      "Transaksi tidak ditemukan."
    );
    return;
  }

  const item =
    transactions.find(
      t => t.id === editingId
    );

  if (!item) {
    showToast(
      "Transaksi tidak ditemukan."
    );
    return;
  }

  const person =
    item.challengeOwner ||
    item.nama;

  const loggedPerson =
    getLoggedPerson();

  // Ownership.
  if (
    item.ownerUid &&
    item.ownerUid !== currentUser.uid
  ) {
    showToast(
      "Transaksi ini bukan milik akun yang sedang login."
    );
    return;
  }

  if (
    !item.ownerUid &&
    item.createdBy &&
    item.createdBy !== currentUser.uid
  ) {
    showToast(
      "Transaksi ini bukan milik akun yang sedang login."
    );
    return;
  }

  if (
    person !== loggedPerson
  ) {
    showToast(
      `Transaksi ${person} hanya dapat diedit oleh ${person}.`
    );
    return;
  }

  const tanggal =
    $("editDate")?.value || "";

  const catatan =
    $("editNote")?.value.trim() || "";

  const nominal =
    Math.trunc(
      Number(
        $("editAmount")?.value
      )
    );

  if (!tanggal) {
    showToast(
      "Tanggal harus diisi."
    );
    return;
  }

  if (
    !nominal ||
    nominal <= 0
  ) {
    showToast(
      "Nominal harus lebih dari 0."
    );
    return;
  }

  try {

    const round =
      Number(
        item.challengeNumber
      ) ||
      currentChallengeNumber[
        person
      ] ||
      1;

    /*
     * Kembalikan semua kotak yang sebelumnya
     * dialokasikan ke transaksi ini.
     */
    const oldAllocations =
      Array.isArray(
        item.challengeAllocations
      )
        ? item.challengeAllocations
        : (
            item.source === "challenge" &&
            item.challengeId
              ? [{
                  cellId:
                    item.challengeId,
                  nominal:
                    Number(
                      item.nominal
                    ) || 0
                }]
              : []
          );

    /*
     * Cari kombinasi baru dengan menganggap
     * kotak milik transaksi lama sebagai kosong.
     */
    const allocation =
      chooseChallengeAllocation(
        person,
        nominal,
        editingId
      );

    const newAllocations =
      allocation.cells.map(
        cell => ({
          cellId:
            cell.cellId,
          nominal:
            cell.nominal
        })
      );

    const batch =
      writeBatch(db);

    /*
     * Update transaksi.
     */
    batch.update(
      doc(
        db,
        "transactions",
        editingId
      ),
      {
        nama:
          person,

        nominal,

        tanggal,

        catatan,

        source:
          newAllocations.length
            ? "challenge-auto"
            : "manual",

        challengeOwner:
          person,

        challengeNumber:
          round,

        challengeAllocations:
          newAllocations,

        allocatedChallengeAmount:
          allocation.allocatedAmount,

        challengeRemainder:
          allocation.remainder,

        ownerUid:
          item.ownerUid ||
          currentUser.uid,

        updatedBy:
          currentUser.uid,

        updatedAt:
          serverTimestamp()
      }
    );

    /*
     * Hapus semua cell lama yang memang
     * milik transaksi ini.
     */
    oldAllocations.forEach(
      oldCell => {

        const oldCellId =
          oldCell.cellId;

        const oldClaim =
          challengeClaims[
            person
          ]?.[
            oldCellId
          ];

        const oldDocumentId =
          oldClaim?.docId ||
          challengeDocId(
            person,
            oldCellId,
            round
          );

        /*
         * Hanya hapus jika cell tersebut
         * memang milik transaksi ini.
         */
        if (
          !oldClaim ||
          oldClaim.transactionId ===
            editingId
        ) {
          batch.delete(
            doc(
              db,
              "challengeCells",
              oldDocumentId
            )
          );
        }
      }
    );

    /*
     * Buat alokasi Challenge baru.
     */
    allocation.cells.forEach(
      cell => {

        const challengeDocumentId =
          challengeDocId(
            person,
            cell.cellId,
            round
          );

        batch.set(
          doc(
            db,
            "challengeCells",
            challengeDocumentId
          ),
          {
            nominal:
              cell.nominal,

            nama:
              person,

            ownerName:
              person,

            ownerUid:
              currentUser.uid,

            tanggal,

            catatan,

            transactionId:
              editingId,

            claimedBy:
              currentUser.uid,

            claimedAt:
              serverTimestamp(),

            challengeId:
              cell.cellId,

            challengeNumber:
              round,

            challengeDocId:
              challengeDocumentId,

            updatedAt:
              serverTimestamp()
          }
        );
      }
    );

    await batch.commit();

    $("editDialog")?.close();

    editingId =
      null;

    if (
      allocation.remainder > 0
    ) {

      showToast(
        `${money(nominal)} diperbarui. Challenge ${money(allocation.allocatedAmount)}, sisa ${money(allocation.remainder)} tetap tercatat.`
      );

    } else {

      showToast(
        `${money(nominal)} berhasil diperbarui dan Challenge dihitung ulang ❤️`
      );

    }

  } catch (error) {

    console.error(
      "EDIT ERROR:",
      error
    );

    showToast(
      error?.code ===
      "permission-denied"
        ? "Firebase menolak perubahan. Pastikan Rules sudah dipublish."
        : "Gagal memperbarui tabungan."
    );
  }
}


async function removeTransaction(id) {
  const item =
    transactions.find(
      t => t.id === id
    );

  if (
    !item ||
    !currentUser
  ) {
    showToast(
      "Transaksi tidak ditemukan."
    );
    return;
  }

  const person =
    item.challengeOwner ||
    item.nama;

  if (
    item.ownerUid &&
    item.ownerUid !== currentUser.uid
  ) {
    showToast(
      "Transaksi ini bukan milik akun yang sedang login."
    );
    return;
  }

  if (
    !item.ownerUid &&
    item.createdBy &&
    item.createdBy !== currentUser.uid
  ) {
    showToast(
      "Transaksi ini bukan milik akun yang sedang login."
    );
    return;
  }

  if (
    person !== getLoggedPerson()
  ) {
    showToast(
      `Transaksi ${person} hanya dapat dihapus oleh ${person}.`
    );
    return;
  }

  const confirmed =
    confirm(
      `Hapus tabungan ${money(item.nominal)} milik ${person}?`
    );

  if (!confirmed) {
    return;
  }

  pendingDeletedTransactions.add(id);

  try {

    const round =
      Number(
        item.challengeNumber
      ) ||
      currentChallengeNumber[
        person
      ] ||
      1;

    const allocations =
      Array.isArray(
        item.challengeAllocations
      )
        ? item.challengeAllocations
        : (
            item.source === "challenge" &&
            item.challengeId
              ? [{
                  cellId:
                    item.challengeId,
                  nominal:
                    Number(
                      item.nominal
                    ) || 0
                }]
              : []
          );

    const batch =
      writeBatch(db);

    /*
     * Hapus transaksi utama.
     */
    batch.delete(
      doc(
        db,
        "transactions",
        id
      )
    );

    /*
     * Hapus semua kotak Challenge
     * yang dialokasikan ke transaksi ini.
     */
    allocations.forEach(
      allocation => {

        const cellId =
          allocation.cellId;

        const claim =
          challengeClaims[
            person
          ]?.[
            cellId
          ];

        const challengeDocumentId =
          claim?.docId ||
          challengeDocId(
            person,
            cellId,
            round
          );

        /*
         * Jangan menghapus kotak yang
         * ternyata sudah bukan milik transaksi ini.
         */
        if (
          !claim ||
          claim.transactionId === id
        ) {
          batch.delete(
            doc(
              db,
              "challengeCells",
              challengeDocumentId
            )
          );
        }
      }
    );

    await batch.commit();

    // Reconcile langsung dari data lokal agar UI tidak menunggu snapshot
    // berikutnya untuk kembali ke challenge yang benar.
    transactions = transactions.filter(tx => tx.id !== id);

    for (const allocation of allocations) {
      delete challengeClaims[person]?.[allocation.cellId];
    }

    pendingDeletedTransactions.delete(id);
    challengeCompletionLock[person] = 0;

    await repairChallengeRoundFromTransactions(
      person,
      transactions
    );

    renderChallenge();

    showToast(
      allocations.length
        ? "Tabungan dihapus dan semua kotak Challenge dikembalikan ❤️"
        : "Tabungan berhasil dihapus."
    );

  } catch (error) {

    pendingDeletedTransactions.delete(id);

    console.error(
      "DELETE ERROR:",
      error
    );

    showToast(
      error?.code ===
      "permission-denied"
        ? "Firebase menolak penghapusan. Pastikan Rules sudah dipublish."
        : "Gagal menghapus tabungan."
    );
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
    const loginError = $("loginError");
    if (loginError) {
      loginError.textContent =
        error?.code === "auth/invalid-credential"
          ? "Email atau password salah."
          : "Login gagal. Periksa akun Firebase dan Authorized Domains.";
    }
  }
});

$("logoutButton")?.addEventListener("click", () => signOut(auth));
$("savingForm")?.addEventListener("submit", addTransaction);
$("editForm")?.addEventListener("submit", saveEdit);
$("settingsForm")?.addEventListener("submit", saveSettings);
$("challengeForm")?.addEventListener("submit", claimChallenge);
$("unclaimChallenge")?.addEventListener("click", unclaimChallenge);
$("monthFilter")?.addEventListener("change", renderTable);
$("chartRange")?.addEventListener("change", updateChart);
$("themeToggle")?.addEventListener("click", toggleTheme);
$("settingsButton")?.addEventListener("click", openSettings);

["closeEdit","cancelEdit"].forEach(id =>
  $(id)?.addEventListener("click", () => $("editDialog")?.close())
);

["closeSettings","cancelSettings"].forEach(id =>
  $(id)?.addEventListener("click", () => $("settingsDialog")?.close())
);

["closeChallenge","cancelChallenge"].forEach(id =>
  $(id)?.addEventListener("click", () => $("challengeDialog")?.close())
);

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    $("editDialog")?.close();
    $("settingsDialog")?.close();
    $("challengeDialog")?.close();
  }
});

$("date").value = todayISO();

const challengeCount = $("challengeCount");

if (challengeCount) {
  challengeCount.textContent = CHALLENGE_CELLS;
}

initTheme();
renderChallenge();

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    $("loginPage").classList.add("hidden");
    $("appPage").classList.remove("hidden");
    const email = (user.email || "").toLowerCase();
    const person = getLoggedPerson();
    $("currentUserName").textContent = person;

    if ($("person")) {
      $("person").value = person;
      $("person").disabled = true;
    }

    startRealtimeListeners();
  } else {
    $("appPage").classList.add("hidden");
    $("loginPage").classList.remove("hidden");
    if (unsubscribeTransactions) unsubscribeTransactions();
    if (unsubscribeSettings) unsubscribeSettings();
    if (unsubscribeChallenge) unsubscribeChallenge();
    unsubscribeTransactions = null;
    unsubscribeSettings = null;
    unsubscribeChallenge = null;
  }
});
