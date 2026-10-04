#!/usr/bin/env node
/**
 * Gate 6 (+1) — Deployment.
 *
 * Close Boot proved the artifact starts; this gate proves the thing that is
 * actually running elsewhere is the same code and image. A version string typed by
 * hand is not enough: the observed revision must equal the frozen candidate.
 *
 * Contract of the environment (injected by the deployment job, never by the Agent
 * and never by the Candidate process itself; in CI the producer is
 * ci/tools/ci-deploy-probe.mjs, which installs the packaged artifact into a clean
 * directory, runs it, and reports what it observed):
 *   DSH_CANDIDATE                the frozen candidate revision being verified
 *   DSH_DEPLOYMENT_ID            identity of the real deployment
 *   DSH_DEPLOYED_CODE_REVISION   revision the deployment actually reports
 *   DSH_DEPLOYED_IMAGE_DIGEST    image digest the deployment actually runs
 *   DSH_IMAGE_DIGEST             digest of the image built for this candidate
 *   DSH_DEPLOYMENT_HEALTH_URL    optional endpoint the deployment reports on
 */

const failures = []
const notes = []

const candidate = process.env.DSH_CANDIDATE || ''
if (!candidate) {
  process.stderr.write('verify-deployment: DSH_CANDIDATE is not set; the gate cannot bind a deployment to a candidate\n')
  process.exit(2)
}

const mode = process.env.DSH_DEPLOYMENT_MODE || 'staging'
const deploymentId = process.env.DSH_DEPLOYMENT_ID
const deployedRevision = process.env.DSH_DEPLOYED_CODE_REVISION
const deployedImage = process.env.DSH_DEPLOYED_IMAGE_DIGEST
const builtImage = process.env.DSH_IMAGE_DIGEST
const healthUrl = process.env.DSH_DEPLOYMENT_HEALTH_URL

if (!deploymentId) failures.push('DSH_DEPLOYMENT_ID is missing: no real deployment is identified')
if (!deployedRevision) failures.push('DSH_DEPLOYED_CODE_REVISION is missing: the running revision was not observed')
else if (!candidate.startsWith(deployedRevision) && !deployedRevision.startsWith(candidate)) {
  failures.push(`the deployment reports revision ${deployedRevision} but the frozen candidate is ${candidate}`)
}
if (!deployedImage) failures.push('DSH_DEPLOYED_IMAGE_DIGEST is missing: the running image was not observed')
else if (builtImage && deployedImage !== builtImage) {
  failures.push(`the deployment runs image ${deployedImage} but the candidate was verified as ${builtImage}`)
}
if (!builtImage) notes.push('DSH_IMAGE_DIGEST was not provided, so image equality could not be checked')

if (healthUrl) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) failures.push(`the deployment health endpoint answered ${response.status}`)
    else {
      const body = await response.text()
      if (deployedRevision && !body.includes(deployedRevision)) {
        failures.push('the health endpoint did not report the deployed revision')
      }
    }
  } catch (error) {
    failures.push(`the deployment health endpoint could not be reached: ${String(error.message)}`)
  }
} else {
  notes.push('no health endpoint was declared; version identity rests on the reported revision and image digest')
}

for (const note of notes) process.stdout.write(`note: ${note}\n`)
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`DEPLOYMENT FAIL ${failure}\n`)
  process.exit(1)
}
process.stdout.write(
  `deployment ok (${mode}): ${deploymentId} runs ${deployedRevision} with image ${deployedImage}\n`,
)
process.exit(0)
