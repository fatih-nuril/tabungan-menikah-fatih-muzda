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
// AUTO NEXT CHALLENGE
// =========================================================

async function completeChallenge(
  person,
  completedRound
) {

  if (
    challengeCompletionLock[person] ===
    completedRound
  ) {
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

        // Setelah nomor challenge tersedia,
        // cek apakah ronde saat ini sudah selesai.
        checkChallengeCompletion("Fatih");
        checkChallengeCompletion("Muzdoug");

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
  const nominal = Number($("amount").value);

  if ($("person")) {
    $("person").value = nama;
  }
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
      source: "manual",
      ownerUid: currentUser.uid,
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

  if (!item) {
    showToast("Transaksi tidak ditemukan.");
    return;
  }

  const isChallenge = item.source === "challenge";
  const loggedPerson = getLoggedPerson();

  // Tentukan pemilik transaksi.
  const owner =
    item.challengeOwner ||
    item.nama;

  if (
    item.ownerUid &&
    currentUser?.uid &&
    item.ownerUid !== currentUser.uid
  ) {
    showToast("Transaksi ini hanya dapat diedit oleh pemiliknya.");
    return;
  }

  if (
    isChallenge &&
    currentUser?.uid &&
    item.createdBy &&
    item.createdBy !== currentUser.uid
  ) {
    showToast("Challenge ini hanya dapat diedit oleh pemiliknya.");
    return;
  }

  if (
    isChallenge &&
    owner !== loggedPerson
  ) {
    showToast(`Tabel ${owner} hanya dapat diedit oleh ${owner}.`);
    return;
  }

  editingId = id;

  if ($("editId")) $("editId").value = id;
  if ($("editPerson")) $("editPerson").value = item.nama;
  if ($("editAmount")) $("editAmount").value = item.nominal;
  if ($("editDate")) $("editDate").value = item.tanggal;
  if ($("editNote")) $("editNote").value = item.catatan || "";

  if ($("editPerson")) {
    $("editPerson").disabled = isChallenge;
    if (!isChallenge) {
      $("editPerson").value = item.nama;
    }
  }

  if ($("editAmount")) {
    $("editAmount").disabled = isChallenge;
  }

  if ($("editChallengeHint")) {
    $("editChallengeHint").textContent = isChallenge
      ? "Nominal dan pemilik challenge dikunci. Tanggal dan catatan tetap dapat diperbarui."
      : "";
  }

  $("editDialog")?.showModal();
}

async function saveEdit(event) {
  event.preventDefault();

  if (!editingId || !currentUser) {
    showToast("Transaksi tidak ditemukan.");
    return;
  }

  const item = transactions.find(t => t.id === editingId);

  if (!item) {
    showToast("Transaksi tidak ditemukan.");
    return;
  }

  const isChallenge = item.source === "challenge";
  const loggedPerson = getLoggedPerson();

  // Semua perubahan harus dilakukan oleh user yang sedang login.
  if (item.ownerUid && item.ownerUid !== currentUser.uid) {
    showToast("Transaksi ini bukan milik akun yang sedang login.");
    return;
  }

  if (!item.ownerUid && item.createdBy && item.createdBy !== currentUser.uid) {
    showToast("Transaksi ini bukan milik akun yang sedang login.");
    return;
  }

  if (isChallenge) {
    const owner = item.challengeOwner || item.nama;

    if (owner !== loggedPerson) {
      showToast(`Tabel ${owner} hanya dapat diedit oleh ${owner}.`);
      return;
    }
  }

  const tanggal = $("editDate")?.value || "";
  const catatan = $("editNote")?.value.trim() || "";

  if (!tanggal) {
    showToast("Tanggal harus diisi.");
    return;
  }

  const update = {
    tanggal,
    catatan,
    updatedBy: currentUser.uid,
    updatedAt: serverTimestamp()
  };

  // Transaksi manual: nama dan nominal dapat diedit,
  // tetapi nama hanya boleh dipindahkan jika memang diperlukan.
  if (!isChallenge) {
    const nama = $("editPerson")?.value;
    const nominal = Math.trunc(Number($("editAmount")?.value));

    if (nama !== "Fatih" && nama !== "Muzdoug") {
      showToast("Nama tidak valid.");
      return;
    }

    if (!nominal || nominal <= 0) {
      showToast("Nominal tidak valid.");
      return;
    }

    update.nama = nama;
    update.nominal = nominal;
  }

  try {
    const batch = writeBatch(db);

    // Update transaksi utama.
    batch.update(
      doc(db, "transactions", editingId),
      update
    );

    // Untuk challenge gunakan set + merge.
    // Ini menghindari kegagalan update ketika dokumen cell lama
    // belum memiliki semua field versi baru.
    if (isChallenge && item.challengeId) {
      const owner = item.challengeOwner || item.nama;
      const challengeDocumentId =
        item.challengeDocId ||
        challengeClaims[owner]?.[item.challengeId]?.docId ||
        challengeDocId(owner, item.challengeId);

      batch.set(
        doc(db, "challengeCells", challengeDocumentId),
        {
          nominal: Number(item.nominal) || 0,
          nama: owner,
          ownerName: owner,
          ownerUid: item.ownerUid || currentUser.uid,
          tanggal,
          catatan,
          transactionId: editingId,
          claimedBy: item.createdBy || currentUser.uid,
          challengeId: item.challengeId,
          challengeNumber: item.challengeNumber || currentChallengeNumber[owner] || 1,
          challengeDocId: challengeDocumentId,
          updatedBy: currentUser.uid,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    }

    await batch.commit();

    $("editDialog")?.close();
    editingId = null;
    showToast("Tabungan berhasil diperbarui ❤️");

  } catch (error) {
    console.error("EDIT ERROR:", error);
    showToast(
      error?.code === "permission-denied"
        ? "Firebase menolak perubahan. Pastikan Rules versi final sudah dipublish."
        : "Gagal memperbarui tabungan."
    );
  }
}

async function removeTransaction(id) {
  const item = transactions.find(t => t.id === id);

  if (!item || !currentUser) {
    showToast("Transaksi tidak ditemukan.");
    return;
  }

  const loggedPerson = getLoggedPerson();

  if (item.ownerUid && item.ownerUid !== currentUser.uid) {
    showToast("Transaksi ini bukan milik akun yang sedang login.");
    return;
  }

  if (!item.ownerUid && item.createdBy && item.createdBy !== currentUser.uid) {
    showToast("Transaksi ini bukan milik akun yang sedang login.");
    return;
  }

  if (
    item.source === "challenge" &&
    (item.challengeOwner || item.nama) !== loggedPerson
  ) {
    showToast("Challenge ini bukan milik akun yang sedang login.");
    return;
  }

  const confirmed = confirm(
    `Hapus tabungan ${money(item.nominal)} milik ${item.nama}?`
  );

  if (!confirmed) return;

  try {
    const batch = writeBatch(db);

    // Hapus transaksi utama.
    batch.delete(
      doc(db, "transactions", id)
    );

    // Jika Challenge, hapus cell yang terkait.
    if (item.source === "challenge" && item.challengeId) {
      const owner = item.challengeOwner || item.nama;

      const challengeDocumentId =
        item.challengeDocId ||
        challengeClaims[owner]?.[item.challengeId]?.docId ||
        challengeDocId(owner, item.challengeId);

      batch.delete(
        doc(db, "challengeCells", challengeDocumentId)
      );
    }

    await batch.commit();

    showToast(
      item.source === "challenge"
        ? "Tabungan dihapus dan kotak challenge dikembalikan ❤️"
        : "Tabungan berhasil dihapus."
    );

  } catch (error) {
    console.error("DELETE ERROR:", error);
    showToast(
      error?.code === "permission-denied"
        ? "Firebase menolak penghapusan. Publish Rules final dari project ini."
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
