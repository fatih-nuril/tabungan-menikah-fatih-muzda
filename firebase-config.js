import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBNx_lprf6qtBWOFABKb8Bql_4M1M_ataw",
  authDomain: "tabungan-menikah-fatih-muzdoug.firebaseapp.com",
  projectId: "tabungan-menikah-fatih-muzdoug",
  storageBucket: "tabungan-menikah-fatih-muzdoug.firebasestorage.app",
  messagingSenderId: "124359536653",
  appId: "1:124359536653:web:73013789802d1247de2544",
  measurementId: "G-17NM7L4R3W"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };
