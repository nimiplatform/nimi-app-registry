import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RegistryValidationError } from './registry-validation.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Base-owned admission policy. It lives with the trusted validator schema so a
// candidate checkout cannot switch it. `safety_profile.required_for_new_admission`
// is enabled by an explicit Platform maintainer change only after supported
// consumers that read the field are deployed; historical records are never
// re-evaluated against it.
// @nimi-authority: rule.nimi.platform.app-ecosystem.p-napp-043b
export function loadAdmissionPolicy(schemaRoot = path.join(moduleRoot, 'schema')) {
  const policyPath = path.join(schemaRoot, 'admission-policy.json');
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch (error) {
    throw new RegistryValidationError(`admission policy is missing or invalid: ${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (policy?.schema_version !== 1 || typeof policy.safety_profile?.required_for_new_admission !== 'boolean'
    || Object.keys(policy).some((key) => !['schema_version', 'safety_profile'].includes(key))
    || Object.keys(policy.safety_profile).some((key) => key !== 'required_for_new_admission')) {
    throw new RegistryValidationError(`admission policy has an unsupported shape: ${policyPath}`);
  }
  return Object.freeze({ safetyProfileRequiredForNewAdmission: policy.safety_profile.required_for_new_admission });
}

export function requireSafetyProfileForNewAdmission(candidate, policy, label) {
  if (!policy.safetyProfileRequiredForNewAdmission) return;
  if (candidate.safety_profile === undefined) {
    throw new RegistryValidationError(`${label} is missing safety_profile: new public admission requires the complete publisher safety declaration in nimi.app.yaml, projected by nimi-app sync into the release information asset`);
  }
}
