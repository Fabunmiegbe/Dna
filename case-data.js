// GeneMatch Phase 3 data layer — cases, samples, and chain of custody.
// Depends on auth.js being loaded first (uses the shared `db` instance).
//
// ID FORMAT
//   Case IDs:   GM-{year}-{6-digit sequence}   e.g. GM-2026-000001
//   Sample IDs: SMP-{6-digit sequence}          e.g. SMP-000001
// Sequences are generated with a Firestore transaction against a counters/*
// document, so two simultaneous submissions can't collide.
//
// SECURITY NOTE
//   Counter documents are writable by any signed-in user in the current
//   firestore.rules (see the note there). That's an acceptable simplification
//   for an ID string with no access-control weight, but revisit it in Phase 9
//   (security hardening) — a Cloud Function-issued ID would remove client
//   trust from the picture entirely.

async function nextSequence(counterId, padLength) {
  const ref = db.collection('counters').doc(counterId);
  const next = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const current = doc.exists ? doc.data().value : 0;
    const updated = current + 1;
    tx.set(ref, { value: updated }, { merge: true });
    return updated;
  });
  return String(next).padStart(padLength, '0');
}

async function generateCaseId() {
  const year = new Date().getFullYear();
  const seq = await nextSequence(`cases_${year}`, 6);
  return `GM-${year}-${seq}`;
}

async function generateSampleId() {
  const seq = await nextSequence('samples', 6);
  return `SMP-${seq}`;
}

// ---------------------------------------------------------------------------
// CASES
// ---------------------------------------------------------------------------

const CASE_STATUSES = [
  'submitted', 'consent_pending', 'sample_collection', 'laboratory_processing',
  'quality_control', 'analysis', 'scientific_review', 'report_ready', 'closed',
];

async function createCase({ caseType, requesterUid, participantCount, notes }) {
  const caseId = await generateCaseId();
  const now = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection('cases').doc(caseId).set({
    caseId,
    caseType,
    status: 'submitted',
    priority: 'standard',
    consentStatus: 'pending',
    createdBy: requesterUid,
    laboratory: null,
    assignedTechnician: null,
    assignedAnalyst: null,
    participantCount: participantCount || 2,
    numSamples: 0,
    analysisStatus: 'not_started',
    reportStatus: 'not_started',
    notes: notes || '',
    createdAt: now,
    updatedAt: now,
    dateCompleted: null,
  });
  return caseId;
}

async function getCase(caseId) {
  const doc = await db.collection('cases').doc(caseId).get();
  return doc.exists ? doc.data() : null;
}

async function listCasesForCustomer(uid) {
  const snap = await db.collection('cases').where('createdBy', '==', uid).get();
  return snap.docs.map((d) => d.data());
}

async function listAllCases() {
  const snap = await db.collection('cases').orderBy('createdAt', 'desc').limit(100).get();
  return snap.docs.map((d) => d.data());
}

async function updateCaseStatus(caseId, status, actorUid) {
  if (!CASE_STATUSES.includes(status)) throw new Error('Unknown case status: ' + status);
  await db.collection('cases').doc(caseId).update({
    status,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    ...(status === 'closed' ? { dateCompleted: firebase.firestore.FieldValue.serverTimestamp() } : {}),
  });
  await logAuditEvent('CASE_STATUS_CHANGED', actorUid, { caseId, status });
}

// ---------------------------------------------------------------------------
// SAMPLES
// ---------------------------------------------------------------------------

const SAMPLE_TYPES = ['buccal_swab', 'blood', 'other'];
const STORAGE_STATUSES = ['in_transit', 'received', 'in_storage', 'consumed', 'disposed'];

async function registerSample({ caseId, sampleType, collectionLocation, collectorUid, storageLocation, donorParticipantId }) {
  const sampleId = await generateSampleId();
  const now = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection('samples').doc(sampleId).set({
    sampleId,
    caseId,
    sampleType,
    collectionDate: now,
    collectionLocation: collectionLocation || '',
    collector: collectorUid,
    storageLocation: storageLocation || '',
    storageStatus: 'received',
    donorParticipantId: donorParticipantId || '',
    createdAt: now,
  });
  await db.collection('cases').doc(caseId).update({
    numSamples: firebase.firestore.FieldValue.increment(1),
    updatedAt: now,
  });
  // First custody event is always the collection itself — every sample
  // enters chain-of-custody tracking at the moment it's registered.
  await logCustodyEvent({
    sampleId,
    caseId,
    eventType: 'COLLECTED',
    actorUid: collectorUid,
    location: collectionLocation || '',
    notes: 'Sample registered and collected.',
  });
  return sampleId;
}

async function listSamplesForCase(caseId) {
  const snap = await db.collection('samples').where('caseId', '==', caseId).get();
  return snap.docs.map((d) => d.data());
}

async function updateSampleStorage(sampleId, storageStatus, storageLocation, actorUid) {
  if (!STORAGE_STATUSES.includes(storageStatus)) throw new Error('Unknown storage status: ' + storageStatus);
  await db.collection('samples').doc(sampleId).update({
    storageStatus,
    storageLocation: storageLocation || firebase.firestore.FieldValue.delete(),
  });
  await logAuditEvent('SAMPLE_STORAGE_UPDATED', actorUid, { sampleId, storageStatus });
}

// ---------------------------------------------------------------------------
// CHAIN OF CUSTODY
// ---------------------------------------------------------------------------
// Custody events are append-only: firestore.rules allows create but never
// update or delete on this collection, so the history can't be edited after
// the fact, only added to.

const CUSTODY_EVENT_TYPES = [
  'COLLECTED', 'RECEIVED', 'TRANSFERRED', 'STORED', 'LABORATORY_PROCESSING',
  'TESTING', 'DATA_UPLOADED', 'ANALYSIS', 'REVIEW', 'REPORT_GENERATED',
];

async function logCustodyEvent({ sampleId, caseId, eventType, actorUid, location, notes }) {
  if (!CUSTODY_EVENT_TYPES.includes(eventType)) throw new Error('Unknown custody event type: ' + eventType);
  await db.collection('custody_events').add({
    sampleId,
    caseId,
    eventType,
    actorUid,
    location: location || '',
    notes: notes || '',
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

async function listCustodyEvents(sampleId) {
  const snap = await db.collection('custody_events')
    .where('sampleId', '==', sampleId)
    .orderBy('timestamp', 'asc')
    .get();
  return snap.docs.map((d) => d.data());
}

// ---------------------------------------------------------------------------
// AUDIT LOG (minimal — full audit system per spec section 21 lands in Phase 9)
// ---------------------------------------------------------------------------

async function logAuditEvent(event, actorUid, detail) {
  await db.collection('audit_logs').add({
    event,
    actorUid,
    detail: detail || {},
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
  });
}
