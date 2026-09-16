// GeneMatch auth helper (Firebase v9 compat build, loaded via <script> tags —
// no bundler, consistent with the rest of the site). Expects firebase-config.js
// and the firebase-app-compat / firebase-auth-compat / firebase-firestore-compat
// scripts to be loaded first.

if (typeof firebase !== 'undefined' && !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = typeof firebase !== 'undefined' ? firebase.auth() : null;
const db = typeof firebase !== 'undefined' ? firebase.firestore() : null;

// Roles a customer can self-select at signup. Staff roles (Laboratory Admin,
// Laboratory Technician, Case Manager, Scientist/Analyst, Reviewer, Auditor,
// Super Admin) are provisioned by a Super Admin from the dashboard, not
// through public registration — self-service staff signup would defeat
// role-based access control.
const SELF_SERVICE_ROLE = 'customer';

function friendlyAuthError(error) {
  const map = {
    'auth/email-already-in-use': 'An account with this email already exists.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/weak-password': 'Password should be at least 8 characters.',
    'auth/user-not-found': 'No account found with this email.',
    'auth/wrong-password': 'Incorrect email or password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  };
  return map[error.code] || 'Something went wrong. Please try again.';
}

async function registerCustomer({ fullName, email, phone, country, password }) {
  const cred = await auth.createUserWithEmailAndPassword(email, password);
  await cred.user.updateProfile({ displayName: fullName });
  await db.collection('users').doc(cred.user.uid).set({
    fullName,
    email,
    phone,
    country,
    organization: null,
    role: SELF_SERVICE_ROLE,
    mfaEnabled: false,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  return cred.user;
}

async function loginUser(email, password) {
  const cred = await auth.signInWithEmailAndPassword(email, password);
  return cred.user;
}

async function logoutUser() {
  await auth.signOut();
  window.location.href = '/login.html';
}

async function getUserProfile(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? doc.data() : null;
}

// Redirects to /login.html if no user is signed in. Call from pages that
// require auth (dashboard.html). Returns the signed-in user + their role
// profile once resolved.
function requireAuth(onReady) {
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      window.location.href = '/login.html';
      return;
    }
    const profile = await getUserProfile(user.uid);
    onReady(user, profile);
  });
}
