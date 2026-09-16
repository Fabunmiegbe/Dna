// GeneMatch Phase 7 — comparison & statistical engine (spec sections 12–14
// combine into one phase in the roadmap).
//
// SCOPE, DELIBERATELY LIMITED:
// Spec section 13 says "do not invent scientific formulas" and to implement
// validated algorithms only. This file follows that literally rather than
// as a suggestion:
//
//   - Marker-by-marker comparison (matching/mismatching/missing markers,
//     informative marker count) works for ANY two profiles, any hypothesis.
//   - Exclusion analysis (parent-child only) is a straightforward allele-
//     sharing rule and is implemented in full.
//   - The paternity index (PI) formula implemented below is the standard,
//     textbook "duo" case (child vs one alleged parent, other parent's
//     genotype unknown): PI = 1/f(x) if the alleged parent is homozygous
//     for the shared allele, PI = 1/(2*f(x)) if heterozygous. This is
//     described in standard forensic genetics references (e.g. Butler,
//     "Advanced Topics in Forensic DNA Typing: Interpretation") and is not
//     something invented for this codebase.
//   - Where a locus's obligate allele is ambiguous (both of the child's
//     alleles are also present in the alleged parent's genotype), this
//     code does NOT guess — it excludes that locus from the statistical
//     calculation and says why, rather than applying a formula whose
//     correctness depends on assumptions about the untested parent.
//   - Sibling, half-sibling, grandparent-grandchild, and avuncular
//     relationships get full marker-by-marker IBS (identical-by-state)
//     comparison, but NOT a likelihood-ratio statistic — those formulas
//     are meaningfully more involved (they need explicit kinship-
//     coefficient math, not just allele sharing) and are not implemented
//     here. The UI says so explicitly rather than silently omitting a
//     number.
//
// Every combined statistic requires a laboratory-configured reference
// allele-frequency dataset (see reference_datasets below) — no frequency
// numbers are hardcoded anywhere in this file.
//
// Depends on auth.js (db), case-data.js (nextSequence, logAuditEvent), and
// profile-import.js (getProfile, normalizeForDisplay) being loaded first.

const COMPARISON_ENGINE_VERSION = 1;
const HYPOTHESES = ['parent_child', 'sibling', 'half_sibling', 'grandparent_grandchild', 'avuncular', 'unspecified'];

// ---------------------------------------------------------------------------
// REFERENCE DATASETS (population allele frequencies)
// Entered manually by lab staff from a cited, published source. Immutable
// once created — a correction is a new dataset, not an edit, so a
// statistical result always points at a frequency table that can't have
// silently changed after the fact.
// ---------------------------------------------------------------------------

async function generateReferenceDatasetId() {
  const seq = await nextSequence('reference_datasets', 6);
  return `REF-${seq}`;
}

async function createReferenceDataset({ name, populationGroup, sourceCitation, frequencies, actorUid }) {
  if (!sourceCitation || !sourceCitation.trim()) {
    throw new Error('A source citation is required — frequencies must come from a validated, published population dataset, not placeholder values.');
  }
  const datasetId = await generateReferenceDatasetId();
  await db.collection('reference_datasets').doc(datasetId).set({
    datasetId,
    name: name || datasetId,
    populationGroup: populationGroup || '',
    sourceCitation: sourceCitation.trim(),
    frequencies, // { [locus]: { [allele]: frequencyNumber } }
    createdBy: actorUid,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });
  await logAuditEvent('REFERENCE_DATASET_CREATED', actorUid, { datasetId });
  return datasetId;
}

async function listReferenceDatasets() {
  const snap = await db.collection('reference_datasets').orderBy('createdAt', 'desc').get();
  return snap.docs.map((d) => d.data());
}

async function getReferenceDataset(datasetId) {
  const doc = await db.collection('reference_datasets').doc(datasetId).get();
  return doc.exists ? doc.data() : null;
}

// ---------------------------------------------------------------------------
// MARKER COMPARISON
// Works on the normalized marker shape from profile-import.js. Merges two
// marker sets by markerId and classifies each pairing.
// ---------------------------------------------------------------------------

function compareMarkers(markersA, markersB) {
  const byIdB = new Map(markersB.map((m) => [m.markerId.toLowerCase(), m]));
  const seen = new Set();
  const results = [];

  markersA.forEach((mA) => {
    const key = mA.markerId.toLowerCase();
    seen.add(key);
    const mB = byIdB.get(key);
    if (!mB) {
      results.push({ markerId: mA.markerId, markerType: mA.markerType, genotypeA: mA.genotype, genotypeB: null, sharedAlleles: null, status: 'missing_in_b' });
      return;
    }
    const setA = new Set(mA.genotype);
    const shared = mB.genotype.filter((a) => setA.has(a));
    const uniqueShared = [...new Set(shared)];
    let status;
    if (uniqueShared.length === 0) status = 'mismatch';
    else if (uniqueShared.length === 1 && (mA.genotype[0] !== mA.genotype[1] || mB.genotype[0] !== mB.genotype[1])) status = 'partial_match';
    else status = 'match';
    results.push({ markerId: mA.markerId, markerType: mA.markerType, genotypeA: mA.genotype, genotypeB: mB.genotype, sharedAlleles: uniqueShared.length, status });
  });

  markersB.forEach((mB) => {
    const key = mB.markerId.toLowerCase();
    if (!seen.has(key)) {
      results.push({ markerId: mB.markerId, markerType: mB.markerType, genotypeA: null, genotypeB: mB.genotype, sharedAlleles: null, status: 'missing_in_a' });
    }
  });

  const summary = {
    informativeMarkers: results.filter((r) => r.status !== 'missing_in_a' && r.status !== 'missing_in_b').length,
    matchedMarkers: results.filter((r) => r.status === 'match').length,
    partialMatchMarkers: results.filter((r) => r.status === 'partial_match').length,
    mismatchMarkers: results.filter((r) => r.status === 'mismatch').length,
    missingMarkers: results.filter((r) => r.status === 'missing_in_a' || r.status === 'missing_in_b').length,
  };

  return { markerResults: results, summary };
}

// ---------------------------------------------------------------------------
// EXCLUSION ANALYSIS (parent-child only)
// A single-locus mismatch can be a mutation, not a true exclusion — this is
// standard forensic practice, which is why one mismatch is "inconclusive"
// rather than an automatic exclusion. Two or more independent mismatches is
// the conventional threshold for a genetic exclusion.
// ---------------------------------------------------------------------------

function determineExclusion(summary, hypothesis) {
  if (hypothesis !== 'parent_child') return 'not_applicable';
  if (summary.mismatchMarkers >= 2) return 'excluded';
  if (summary.mismatchMarkers === 1) return 'inconclusive';
  return 'not_excluded';
}

// ---------------------------------------------------------------------------
// STATISTICAL ENGINE — paternity index (duo case), parent-child only
// See the file header for exactly which case this formula covers and why
// other relationship types don't get a statistic in this version.
// ---------------------------------------------------------------------------

function computeLocusPI(childGenotype, parentGenotype, freqTableForLocus) {
  const [c1, c2] = childGenotype;
  const [p1, p2] = parentGenotype;
  const childAlleles = c1 === c2 ? [c1] : [c1, c2];
  const parentSet = new Set(p1 === p2 ? [p1] : [p1, p2]);
  const shared = [...new Set(childAlleles.filter((a) => parentSet.has(a)))];

  if (shared.length === 0) {
    return { pi: 0, note: 'Exclusion at this locus — no allele shared between child and alleged parent.' };
  }
  if (shared.length === 2) {
    return { pi: null, note: 'Ambiguous obligate allele — both of the child\u2019s alleles are present in the alleged parent\u2019s genotype. Not included in the statistical calculation without the other parent\u2019s genotype or analyst review.' };
  }

  const obligateAllele = shared[0];
  const freq = freqTableForLocus ? freqTableForLocus[obligateAllele] : undefined;
  if (freq === undefined || freq === null) {
    return { pi: null, note: `No population frequency for allele ${obligateAllele} in the selected reference dataset — locus excluded from the statistical calculation.`, obligateAllele };
  }
  if (typeof freq !== 'number' || freq <= 0 || freq > 1) {
    return { pi: null, note: `Invalid frequency value for allele ${obligateAllele} in the reference dataset.`, obligateAllele };
  }

  const parentIsHomozygous = p1 === p2;
  const pi = parentIsHomozygous ? (1 / freq) : (1 / (2 * freq));
  return { pi, note: null, obligateAllele };
}

function computeStatistics(markerResults, hypothesis, referenceDataset, childIsA) {
  if (hypothesis !== 'parent_child') {
    return {
      applicable: false,
      note: 'A likelihood-ratio statistic for this relationship type is not implemented in this version — it requires kinship-coefficient math beyond simple allele sharing. The marker comparison above (identical-by-state counts) is shown for a qualified analyst to evaluate manually.',
    };
  }
  if (!referenceDataset) {
    return { applicable: false, note: 'No reference allele-frequency dataset was selected. A combined paternity index requires one.' };
  }

  const perLocus = [];
  markerResults.forEach((m) => {
    if (m.status === 'missing_in_a' || m.status === 'missing_in_b') return;
    const child = childIsA ? m.genotypeA : m.genotypeB;
    const parent = childIsA ? m.genotypeB : m.genotypeA;
    const freqTable = (referenceDataset.frequencies || {})[m.markerId] || (referenceDataset.frequencies || {})[m.markerId.toUpperCase()];
    const { pi, note, obligateAllele } = computeLocusPI(child, parent, freqTable);
    perLocus.push({ markerId: m.markerId, pi, note, obligateAllele });
  });

  const usable = perLocus.filter((l) => typeof l.pi === 'number');
  const combinedPI = usable.length ? usable.reduce((acc, l) => acc * l.pi, 1) : null;
  const probabilityOfRelationship = combinedPI !== null ? (combinedPI / (combinedPI + 1)) * 100 : null;

  return {
    applicable: true,
    perLocus,
    lociUsed: usable.length,
    lociTotal: perLocus.length,
    combinedPI,
    probabilityOfRelationship,
    priorProbability: 0.5,
    method: 'Paternity index (duo case), Essen-M\u00f6ller / Bayesian combination with 0.5 prior probability',
  };
}

// ---------------------------------------------------------------------------
// COMPARISON PIPELINE
// ---------------------------------------------------------------------------

async function generateComparisonId() {
  const seq = await nextSequence('comparisons', 6);
  return `CMP-${seq}`;
}

const COMPARISON_ELIGIBLE_STATUSES = ['ready_for_analysis', 'cleared_by_review'];

async function runComparison({ caseId, profileAId, profileBId, hypothesis, childIsA, referenceDatasetId, actorUid }) {
  if (!HYPOTHESES.includes(hypothesis)) throw new Error('Unknown hypothesis: ' + hypothesis);
  if (profileAId === profileBId) throw new Error('Choose two different profiles to compare.');

  const [profileA, profileB] = await Promise.all([getProfile(profileAId), getProfile(profileBId)]);
  if (!profileA || !profileB) throw new Error('One or both profiles could not be found.');
  [profileA, profileB].forEach((p) => {
    if (!COMPARISON_ELIGIBLE_STATUSES.includes(p.analysisStatus)) {
      throw new Error(`Profile ${p.profileId} is ${p.analysisStatus.replace(/_/g, ' ')} and cannot be used in a comparison until it's cleared.`);
    }
  });

  const normA = normalizeForDisplay(profileA);
  const normB = normalizeForDisplay(profileB);
  const { markerResults, summary } = compareMarkers(normA.markers, normB.markers);
  const exclusionResult = determineExclusion(summary, hypothesis);

  let referenceDataset = null;
  if (referenceDatasetId) referenceDataset = await getReferenceDataset(referenceDatasetId);
  const statistics = computeStatistics(markerResults, hypothesis, referenceDataset, childIsA);

  const comparisonId = await generateComparisonId();
  const now = firebase.firestore.FieldValue.serverTimestamp();
  await db.collection('comparisons').doc(comparisonId).set({
    comparisonId,
    caseId,
    profileAId, profileBId,
    sampleAId: profileA.sampleId, sampleBId: profileB.sampleId,
    hypothesis,
    childIsA: hypothesis === 'parent_child' ? !!childIsA : null,
    referenceDatasetId: referenceDatasetId || null,
    markerResults,
    summary,
    exclusionResult,
    statistics,
    calculationVersion: COMPARISON_ENGINE_VERSION,
    computedBy: actorUid,
    createdAt: now,
    reviewStatus: 'pending_review',
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
  });

  await logAuditEvent('ANALYSIS_COMPLETED', actorUid, { comparisonId, caseId, hypothesis, exclusionResult });
  return comparisonId;
}

async function listComparisonsForCase(caseId) {
  const snap = await db.collection('comparisons').where('caseId', '==', caseId).orderBy('createdAt', 'desc').get();
  return snap.docs.map((d) => d.data());
}

async function getComparison(comparisonId) {
  const doc = await db.collection('comparisons').doc(comparisonId).get();
  return doc.exists ? doc.data() : null;
}

// Scientific review — mirrors the QC review pattern from Phase 6. Per spec
// section 13, every result must show method, dataset, version, date, and
// analyst/reviewer; this is where "reviewer" gets attached, distinct from
// whoever ran the comparison in the first place.
async function submitComparisonReview({ comparisonId, notes, actorUid }) {
  if (!notes || !notes.trim()) throw new Error('A reviewer note is required.');
  await db.collection('comparisons').doc(comparisonId).update({
    reviewStatus: 'reviewed',
    reviewedBy: actorUid,
    reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
    reviewNotes: notes.trim(),
  });
  await logAuditEvent('COMPARISON_REVIEWED', actorUid, { comparisonId });
}
