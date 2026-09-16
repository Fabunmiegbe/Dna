// GeneMatch Phase 4 — laboratory data import.
// Architecture (spec section 9):
//   Laboratory instrument -> instrument adapter -> validation -> normalization
//   -> internal genetic profile format (versioned)
//
// This file implements that pipeline client-side for the MVP: an adapter
// turns a raw file into a common { markers, testingMethod, instrument,
// referenceBuild } shape, validateProfile() checks it for the content
// problems spec section 11 calls out, and importGeneticProfile() writes the
// normalized, versioned result to genetic_profiles.
//
// PROFILE_FORMAT_VERSION exists so a future schema change (new fields, a
// different marker representation) doesn't silently reinterpret old
// profiles — code reading a profile can check profileFormatVersion and
// branch if it ever needs to.
//
// Depends on auth.js (db) and case-data.js (nextSequence, logCustodyEvent,
// logAuditEvent) being loaded first.

const PROFILE_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// INSTRUMENT ADAPTERS
// Each adapter takes raw file text and returns the common intermediate
// shape below. Add a new adapter here for a laboratory-specific format
// rather than changing validation/normalization — that's the point of the
// adapter layer per spec section 9.
// ---------------------------------------------------------------------------

// CSV adapter: expects an STR-style genotyping table with a header row
// containing locus, allele1, allele2 (case-insensitive, any column order).
// This is the common export shape for capillary-electrophoresis STR typing,
// the standard method behind most parentage and relationship testing.
function adaptCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error('The file is empty.');
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idxLocus = header.indexOf('locus');
  const idxA1 = header.indexOf('allele1');
  const idxA2 = header.indexOf('allele2');
  if (idxLocus === -1 || idxA1 === -1 || idxA2 === -1) {
    throw new Error('CSV must have locus, allele1, and allele2 columns.');
  }
  const markers = lines.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      locus: (cols[idxLocus] || '').trim(),
      allele1: (cols[idxA1] || '').trim(),
      allele2: (cols[idxA2] || '').trim(),
    };
  });
  return { markers, testingMethod: 'STR_genotyping', instrument: null, referenceBuild: null };
}

// JSON adapter: expects { testingMethod, instrument, referenceBuild, markers: [{locus, allele1, allele2}] }
function adaptJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('File is not valid JSON.');
  }
  if (!Array.isArray(data.markers)) throw new Error('JSON must include a "markers" array.');
  return {
    markers: data.markers.map((m) => ({
      locus: String(m.locus ?? '').trim(),
      allele1: String(m.allele1 ?? '').trim(),
      allele2: String(m.allele2 ?? '').trim(),
    })),
    testingMethod: data.testingMethod || 'unspecified',
    instrument: data.instrument || null,
    referenceBuild: data.referenceBuild || null,
  };
}

const IMPORT_ADAPTERS = { csv: adaptCsv, json: adaptJson };
// TSV, XML, FASTA, and VCF adapters, plus laboratory-specific formats, slot
// in here the same way once there's a real instrument output sample to
// build them against — see LAB_INTEGRATION notes in the README.

// ---------------------------------------------------------------------------
// VALIDATION
// Checks the content problems spec section 11 calls out. This intentionally
// stays lighter than the full QC engine (Phase 6): it's enough to gate
// whether a profile is usable at all, not the complete quality-metrics
// system that will eventually live alongside it.
// ---------------------------------------------------------------------------

const ALLELE_FORMAT = /^[A-Za-z0-9]+(\.\d+)?$/; // e.g. "14", "16.2", "X", "OL"

function validateProfile(parsed) {
  const errors = [];
  const warnings = [];
  const seenLoci = new Set();
  let missing = 0;
  let duplicate = 0;
  let invalid = 0;

  parsed.markers.forEach((m) => {
    if (!m.locus) {
      errors.push('A marker row is missing a locus name.');
      return;
    }
    const key = m.locus.toLowerCase();
    if (seenLoci.has(key)) {
      duplicate += 1;
      warnings.push(`Duplicate marker: ${m.locus}`);
    }
    seenLoci.add(key);

    if (!m.allele1 || !m.allele2) {
      missing += 1;
      warnings.push(`Missing allele value at ${m.locus}`);
    } else if (!ALLELE_FORMAT.test(m.allele1) || !ALLELE_FORMAT.test(m.allele2)) {
      invalid += 1;
      warnings.push(`Invalid allele format at ${m.locus}`);
    }
  });

  if (parsed.markers.length === 0) {
    errors.push('No markers were found in the imported file.');
  }

  let status = 'PASS';
  if (errors.length) status = 'FAIL';
  else if (warnings.length) status = 'WARNING';

  return {
    status, // PASS | WARNING | FAIL
    errors,
    warnings,
    metrics: {
      totalMarkers: parsed.markers.length,
      missingMarkers: missing,
      duplicateMarkers: duplicate,
      invalidMarkers: invalid,
    },
  };
}

// ---------------------------------------------------------------------------
// IMPORT PIPELINE
// ---------------------------------------------------------------------------

async function generateProfileId() {
  const seq = await nextSequence('genetic_profiles', 6);
  return `PRF-${seq}`;
}

async function importGeneticProfile({ file, format, caseId, sampleId, laboratory, actorUid }) {
  const adapter = IMPORT_ADAPTERS[format];
  if (!adapter) throw new Error('Unsupported import format: ' + format);

  const text = await file.text();
  const parsed = adapter(text); // adapter
  const validation = validateProfile(parsed); // validation

  const profileId = await generateProfileId();
  const now = firebase.firestore.FieldValue.serverTimestamp();

  // normalization -> internal genetic profile format (versioned)
  await db.collection('genetic_profiles').doc(profileId).set({
    profileId,
    caseId,
    sampleId,
    testingMethod: parsed.testingMethod,
    laboratory: laboratory || null,
    instrument: parsed.instrument,
    referenceBuild: parsed.referenceBuild,
    markers: parsed.markers,
    qualityMetrics: validation.metrics,
    importStatus: validation.status,
    importWarnings: validation.warnings,
    importErrors: validation.errors,
    profileFormatVersion: PROFILE_FORMAT_VERSION,
    // A FAILED import is blocked from analysis until a reviewer resolves it,
    // per spec section 11. WARNING profiles proceed but stay visibly flagged.
    analysisStatus: validation.status === 'FAIL' ? 'blocked' : 'ready_for_analysis',
    importedBy: actorUid,
    createdAt: now,
  });

  if (validation.status !== 'FAIL') {
    await logCustodyEvent({
      sampleId,
      caseId,
      eventType: 'DATA_UPLOADED',
      actorUid,
      notes: `Profile ${profileId} imported (${validation.status}).`,
    });
  }
  await logAuditEvent('PROFILE_CREATED', actorUid, { profileId, caseId, sampleId, status: validation.status });

  return { profileId, validation };
}

async function listProfilesForSample(sampleId) {
  const snap = await db.collection('genetic_profiles').where('sampleId', '==', sampleId).get();
  return snap.docs.map((d) => d.data());
}

async function getProfile(profileId) {
  const doc = await db.collection('genetic_profiles').doc(profileId).get();
  return doc.exists ? doc.data() : null;
}
