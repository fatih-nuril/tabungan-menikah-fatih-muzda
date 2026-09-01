# Tabungan Menikah — Fatih ❤️ Muzdoug

Stack:
- HTML/CSS/JavaScript
- Firebase Authentication
- Cloud Firestore
- Chart.js
- GitHub Pages

## File
- index.html
- style.css
- app.js
- firebase-config.js

## Firebase
1. Enable Authentication > Email/Password.
2. Create the two user accounts.
3. Create Firestore `(default)`.
4. Create `transactions` collection (the app can create documents automatically).
5. Add the Firestore rules from `firestore.rules`.

## Local test
Use VS Code + Live Server. Do not open index.html directly with file://.

## GitHub Pages
Push the files to a GitHub repository and enable:
Settings > Pages > Deploy from branch > main > /root.

## Important
The sample Security Rules allow any authenticated Firebase user to access the shared couple data. Before using the app beyond your two accounts, tighten the rules to the exact two UIDs.
