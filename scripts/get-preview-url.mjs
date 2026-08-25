/**
 * Look up the Vercel preview URL Vercel's GitHub integration built for a
 * branch, via GitHub's Deployments API (reuses the already-authenticated
 * `gh` CLI — no Vercel token needed).
 *
 * Usage: node scripts/get-preview-url.mjs [branch] [--wait] [--timeout=180]
 *   branch     defaults to the current git branch
 *   --wait     poll until the deployment finishes (success/failure) instead
 *              of reporting whatever state it's in right now
 *   --timeout  seconds to poll before giving up (default 180)
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const wait = args.includes('--wait');
const timeoutArg = args.find((a) => a.startsWith('--timeout='));
const timeoutSec = timeoutArg ? Number(timeoutArg.split('=')[1]) : 180;
const branch =
  args.find((a) => !a.startsWith('--')) ||
  execFileSync('git', ['branch', '--show-current']).toString().trim();

const REPO = execFileSync('git', ['remote', 'get-url', 'origin'])
  .toString()
  .trim()
  .replace(/^.*github\.com[:/]/, '')
  .replace(/\.git$/, '');

function gh(path) {
  return JSON.parse(execFileSync('gh', ['api', path]).toString());
}

// Vercel's GitHub deployments always key `ref`/`sha` off the commit, never
// the branch name (true even for `main`) — so resolve the branch to its
// current remote commit first, and fall back to querying by branch name
// in case that ever changes.
function resolveSha(ref) {
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin', ref]);
  } catch {
    // fall through and try whatever remote-tracking ref we already have
  }
  try {
    return execFileSync('git', ['rev-parse', `origin/${ref}`]).toString().trim();
  } catch {
    return null;
  }
}

function latestDeployment(ref) {
  const sha = resolveSha(ref);
  const query = sha ? `sha=${sha}` : `ref=${encodeURIComponent(ref)}`;
  const deployments = gh(`repos/${REPO}/deployments?${query}&per_page=10`);
  if (deployments.length === 0) return null;
  return deployments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
}

function statusesFor(deploymentId) {
  return gh(`repos/${REPO}/deployments/${deploymentId}/statuses`);
}

function report(deployment, statuses) {
  const latest = statuses[0]; // GitHub returns newest first
  const url = latest?.environment_url || latest?.target_url;
  console.log(`Branch:       ${branch}`);
  console.log(`Commit:       ${deployment.sha.slice(0, 7)}`);
  console.log(`Environment:  ${deployment.environment}`);
  console.log(`State:        ${latest?.state ?? 'no status yet'}`);
  if (url) console.log(`URL:          ${url}`);
  return latest?.state;
}

async function main() {
  let deployment = latestDeployment(branch);

  if (!deployment && !wait) {
    console.log(`No deployments found yet for branch "${branch}".`);
    console.log('Vercel usually takes a few seconds to pick up a new push — try again shortly, or with --wait.');
    process.exit(1);
  }

  if (!wait) {
    const statuses = statusesFor(deployment.id);
    report(deployment, statuses);
    return;
  }

  const deadline = Date.now() + timeoutSec * 1000;
  let lastState = null;
  while (Date.now() < deadline) {
    if (!deployment) {
      deployment = latestDeployment(branch);
      if (!deployment) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      console.log(`[${new Date().toISOString()}] deployment created (commit ${deployment.sha.slice(0, 7)})`);
    }
    const statuses = statusesFor(deployment.id);
    const state = statuses[0]?.state;
    if (state && state !== lastState) {
      console.log(`[${new Date().toISOString()}] state: ${state}`);
      lastState = state;
    }
    if (['success', 'failure', 'error'].includes(state)) {
      console.log();
      report(deployment, statuses);
      process.exit(state === 'success' ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`Timed out after ${timeoutSec}s waiting for the deployment to finish.`);
  process.exit(1);
}

main();
