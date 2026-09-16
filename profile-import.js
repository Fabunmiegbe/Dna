// GeneMatch Phase 4/5 — laboratory data import and profile normalization.
//
// Architecture (spec section 9):
//   Laboratory instrument -> instrument adapter -> validation -> normalization
//   -> internal genetic profile format (versioned)
//
// PHASE 5 CHANGE: the marker schema is no longer STR-specific. Spec section
// 10 is explicit that the profile model must not be hard-coded to one
// testing technology, so a marker now carries its own type:
//
//   { markerId, markerType: 'STR' | 'SNP' | 'VARIANT', genotype: [a, b], raw }
//
// This is PROFILE_FORMAT_VERSION 2. Profiles imported under version 1 (the
// original { locus, allele1, allele2 } shape from Phase 4) still exist and
// are never rewritten in place — normalizeForDisplay() reads either version
// into one common shape, so a v1 and a v2 profile can sit side by side in
// the UI without the version difference leaking into every place that
// reads a profile.
//
// Depends on auth.js (db) and case-data.js (nextSequence, logCustodyEvent,
// logAuditEvent) being loaded first.

const PROFILE_FORMAT_VERSION = 2;

function makeMarker(markerId, markerType, allele1, allele2, raw) {
  return { markerId, markerType, genotype: [allele1, allele2], raw: raw || null };
}

// ---------------------------------------------------------------------------
// INSTRUMENT ADAPTERS
// Each adapter takes raw file text and returns:
//   { markers: Marker[], testingMethod, instrument, referenceBuild }
// Add a new adapter here for a laboratory-specific format rather than
// changing validation/normalization — that's the point of the adapter layer.
// ---------------------------------------------------------------------------

// STR genotyping CSV: header row with locus, allele1, allele2 (case
// insensitive, any column order). The standard export shape for
// capillary-electrophoresis STR typing — the method behind most parentage
// and relationship testing. STR loci are defined by commercial kits, not
// genome coordinates, so no reference build applies here.
function adaptStrCsv(text) {
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
    const locus = (cols[idxLocus] || '').trim();
    const a1 = (cols[idxA1] || '').trim();
    const a2 = (cols[idxA2] || '').trim();
    return makeMarker(locus, 'STR', a1, a2, { locus, allele1: a1, allele2: a2 });
  });
  return { markers, testingMethod: 'STR_genotyping', instrument: null, referenceBuild: null };
}

// SNP array CSV: header row with rsid, allele1, allele2. SNP genotypes are
// read against a specific reference genome build, so referenceBuild is
// required for this adapter's output to mean anything downstream.
function adaptSnpCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error('The file is empty.');
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idxRsid = header.indexOf('rsid');
  const idxA1 = header.indexOf('allele1');
  const idxA2 = header.indexOf('allele2');
  if (idxRsid === -1 || idxA1 === -1 || idxA2 === -1) {
    throw new Error('CSV must have rsid, allele1, and allele2 columns.');
  }
  const markers = lines.slice(1).map((line) => {
    const cols = line.split(',');
    const rsid = (cols[idxRsid] || '').trim();
    const a1 = (cols[idxA1] || '').trim();
    const a2 = (cols[idxA2] || '').trim();
    return makeMarker(rsid, 'SNP', a1, a2, { rsid, allele1: a1, allele2: a2 });
  });
  return { markers, testingMethod: 'SNP_array', instrument: null, referenceBuild: null };
}

// JSON adapter: accepts either the generalized shape
//   { testingMethod, instrument, referenceBuild,
//     markers: [{ markerId, markerType, genotype: [a, b] }] }
// or the simpler locus/allele1/allele2 shape for convenience — both
// normalize to the same internal marker format.
function adaptJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('File is not valid JSON.');
  }
  if (!Array.isArray(data.markers)) throw new Error('JSON must include a "markers" array.');

  const markers = data.markers.map((m) => {
    if (Array.isArray(m.genotype) && m.markerId) {
      return makeMarker(
        String(m.markerId).trim(),
        m.markerType || 'UNSPECIFIED',
        String(m.genotype[0] ?? '').trim(),
        String(m.genotype[1] ?? '').trim(),
        m
      );
    }
    // Fall back to the simpler locus/allele1/allele2 shape.
    const id = String(m.locus ?? m.markerId ?? '').trim();
    return makeMarker(
      id,
      m.markerType || 'STR',
      String(m.allele1 ?? '').trim(),
      String(m.allele2 ?? '').trim(),
      m
    );
  });

  return {
    markers,
    testingMethod: data.testingMethod || 'unspecified',
    instrument: data.instrument || null,
    referenceBuild: data.referenceBuild || null,
  };
}

const IMPORT_ADAPTERS = {
  str_csv: adaptStrCsv,
  snp_csv: adaptSnpCsv,
  json: adaptJson,
};
// TSV, XML, FASTA, and VCF adapters, plus laboratory-specific formats, slot
// in here the same way once there's a real instrument output sample to
// build them against — see LAB_INTEGRATION notes in the README. A sequencing
// adapter would tag markers 'VARIANT' and always require referenceBuild,
// same as the SNP adapter does now.

const REFERENCE_BUILD_REQUIRED_TYPES = ['SNP', 'VARIANT'];

// ---------------------------------------------------------------------------
// VALIDATION
// Checks the content problems spec section 11 calls out, generalized over
// any marker type rather than assuming STR loci. This intentionally stays
// lighter than the full QC engine (Phase 6): it gates whether a profile is
// usable at all, not the complete quality-metrics system.
// ---------------------------------------------------------------------------

const ALLELE_FORMAT = /^[A-Za-z0-9]+(\.\d+)?$/; // e.g. "14", "16.2", "X", "OL"

function validateProfile(parsed) {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  let missing = 0;
  let duplicate = 0;
  let invalid = 0;

  parsed.markers.forEach((m) => {
    if (!m.markerId) {
      errors.push('A marker row is missing an ID (locus or rsID).');
      return;
    }
    const key = m.markerId.toLowerCase();
    if (seenIds.has(key)) {
      duplicate += 1;
      warnings.push(`Duplicate marker: ${m.markerId}`);
    }
    seenIds.add(key);

    const [a1, a2] = m.genotype;
    if (!a1 || !a2) {
      missing += 1;
      warnings.push(`Missing allele value at ${m.markerId}`);
    } else if (!ALLELE_FORMAT.test(a1) || !ALLELE_FORMAT.test(a2)) {
      invalid += 1;
      warnings.push(`Invalid allele format at ${m.markerId}`);
    }
  });

  if (parsed.markers.length === 0) {
    errors.push('No markers were found in the imported file.');
  }

  const needsReferenceBuild = parsed.markers.some((m) => REFERENCE_BUILD_REQUIRED_TYPES.includes(m.markerType));
  if (needsReferenceBuild && !parsed.referenceBuild) {
    errors.push('This profile contains SNP or variant markers, which require a reference genome build (e.g. GRCh38) to be interpreted correctly.');
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
// NORMALIZATION FOR DISPLAY
// Reads a profile of either format version into one common shape, so a
// v1 (Phase 4) and v2 (Phase 5) profile render identically in the UI. This
// is what makes side-by-side inspection of profiles imported at different
// times possible without a data migration.
// ---------------------------------------------------------------------------

function normalizeForDisplay(profile) {
  const version = profile.profileFormatVersion || 1;
  let markers;
  if (version >= 2) {
    markers = profile.markers;
  } else {
    // v1 shape: { locus, allele1, allele2 }
    markers = (profile.markers || []).map((m) =>
      makeMarker(m.locus, 'STR', m.allele1, m.allele2, m)
    );
  }
  return {
    profileId: profile.profileId,
    testingMethod: profile.testingMethod,
    laboratory: profile.laboratory,
    instrument: profile.instrument,
    referenceBuild: profile.referenceBuild,
    importStatus: profile.importStatus,
    qualityMetrics: profile.qualityMetrics,
    profileFormatVersion: version,
    markers,
  };
}

// ---------------------------------------------------------------------------
// IMPORT PIPELINE
// ---------------------------------------------------------------------------

async function generateProfileId() {
  const seq = await nextSequence('genetic_profiles', 6);
  return `PRF-${seq}`;
}

async function importGeneticProfile({ file, format, caseId, sampleId, laboratory, referenceBuild, actorUid }) {
  const adapter = IMPORT_ADAPTERS[format];
  if (!adapter) throw new Error('Unsupported import format: ' + format);

  const text = await file.text();
  const parsed = adapter(text); // adapter
  if (referenceBuild) parsed.referenceBuild = referenceBuild;
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
