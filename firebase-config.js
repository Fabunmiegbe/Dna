// GeneMatch Firebase configuration
// Replace every value below with the real project config from the Firebase console
// (Project settings -> General -> Your apps -> SDK setup and configuration).
// Do not commit real keys to a public repo without Firestore/Storage security
// rules in place first (see /firestore.rules in the project root).

const firebaseConfig = {
  apiKey: "REPLACE_WITH_FIREBASE_API_KEY",
  authDomain: "REPLACE_WITH_PROJECT.firebaseapp.com",
  projectId: "REPLACE_WITH_PROJECT_ID",
  storageBucket: "REPLACE_WITH_PROJECT.appspot.com",
  messagingSenderId: "REPLACE_WITH_SENDER_ID",
  appId: "REPLACE_WITH_APP_ID",
};

// Loaded as a classic script before the Firebase SDK scripts on pages that
// need auth (login.html, register.html, dashboard.html). Kept separate from
// firebase-app.js / firebase-auth.js so the real keys live in one place.
