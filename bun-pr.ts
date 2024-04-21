#!/usr/bin/env bun

import { Octokit } from "@octokit/rest";
import { $ } from "bun";
import { realpathSync, readdirSync, symlinkSync } from "fs";
import { dirname } from "path";

$.throws(true);
const cwd = realpathSync(import.meta.dir);
$.cwd(cwd);
process.chdir(cwd);

const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || (await $`gh auth token`.text()).trim(); // Replace with your GitHub token
const REPO_OWNER = process.env.BUN_REPO_OWNER || "oven-sh"; // Replace with the repository owner
const REPO_NAME = process.env.BUN_REPO_NAME || "bun"; // Replace with the repository name

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

const IS_PROFILE = (() => {
  const profileIndex = process.argv.findIndex((a) => a === "--profile");
  if (profileIndex !== -1) {
    process.argv.splice(profileIndex, 1);
    return true;
  } else {
    return false;
  }
})();

const IS_BASELINE = (() => {
  const profileIndex = process.argv.findIndex((a) => a === "--baseline");
  if (profileIndex !== -1) {
    process.argv.splice(profileIndex, 1);
    return true;
  } else {
    return false;
  }
})();

const ARTIFACT_NAME = (() => {
  let basename = "bun-";
  if (process.platform === "win32") {
    basename += "windows";
  } else if (process.platform === "darwin") {
    basename += "darwin";
  } else if (process.platform === "linux") {
    basename += "linux";
  }

  if (process.arch === "x64") {
    basename += "-x64";
  } else if (process.arch === "arm64") {
    basename += "-aarch64";
  }

  if (IS_BASELINE) {
    basename += "-baseline";
  }

  if (IS_PROFILE) {
    basename += "-profile";
  }

  return basename;
})();

function isArtifactName(name) {
  if (name === ARTIFACT_NAME) {
    return true;
  }

  if (process.platform === "darwin") {
    if (name === ARTIFACT_NAME.replace("macos", "darwin")) {
      return true;
    }
  }

  return false;
}

const PR_ID = await (async () => {
  let last = process.argv.at(-1);

  if (last?.startsWith("https://github.com")) {
    return new URL(last).pathname.split("/").at(-1);
  } else if (last?.startsWith("https://api.github.com")) {
    return new URL(last).pathname.split("/").at(-1);
  } else if (last?.startsWith("#")) {
    return last.slice(1);
  } else if (Number(last) === Number(last)) {
    return last;
  } else {
    // resolve branch name to PR number from argv
    const branch = last;
    let { data: prs = [] } = await octokit.pulls.list({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      state: "open",
      head: `${REPO_OWNER}:${branch}`,
    });

    if (prs.length) {
      return prs[0].number;
    } else {
      ({ data: prs = [] } = await octokit.pulls.list({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        state: "closed",
        head: `${REPO_OWNER}:${branch}`,
      }));

      if (prs.length) {
        return prs[0].number;
      }

      throw new Error(`No open PR found for branch ${branch}`);
    }
  }
})();

const OUT_DIR =
  process.env.BUN_OUT_DIR ||
  (Bun.which("bun")
    ? dirname(Bun.which("bun"))
    : process.env.BUN_INSTALL || ".");

console.log(
  "Searching GitHub for artifact",
  ARTIFACT_NAME,
  "from PR #" + PR_ID + "..."
);

// Get PR details to find the head commit SHA
const { data: prData } = await octokit.pulls.get({
  owner: REPO_OWNER,
  repo: REPO_NAME,
  pull_number: Number(PR_ID),
});

const headSha = prData.head.sha;

// List workflow runs for the repo and find the latest successful run for the PR's commit SHA
const [
  {
    data: { workflow_runs: completedRunsData = [] },
  },
  {
    data: { workflow_runs: inProgressRunsData = [] },
  },
] = await Promise.all([
  octokit.actions.listWorkflowRunsForRepo({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    event: "pull_request",
    status: "completed",
    branch: prData.head.ref, // Filter by branch associated with the PR
    per_page: 100, // Fetch up to 100 workflow runs
  }),
  octokit.actions.listWorkflowRunsForRepo({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    event: "pull_request",
    status: "in_progress",
    branch: prData.head.ref, // Filter by branch associated with the PR
    per_page: 100, // Fetch up to 100 workflow runs
  }),
]);

const runsData = [...completedRunsData, ...inProgressRunsData];

function isPossibleRun(name) {
  name = name.toLowerCase();

  if (!name.startsWith("bun-")) {
    return false;
  }

  return (
    name.includes("macos") ||
    name.includes("linux") ||
    name.includes("windows") ||
    name.includes("darwin")
  );
}
const workflowRuns = runsData
  .filter((run) => run.name?.toLowerCase() === "ci" && run.run_started_at)
  .sort((a, b) => b.run_started_at!.localeCompare(a.run_started_at!));

if (!workflowRuns.length) {
  console.log("No successful workflow run found for this PR.");
  process.exit(1);
}

for (const workflowRun of workflowRuns) {
  // List artifacts for the identified workflow run
  const { data: artifactsData } =
    await octokit.actions.listWorkflowRunArtifacts({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      run_id: workflowRun.id,
    });
  const artifact = artifactsData.artifacts.find((artifact) =>
    isArtifactName(artifact.name)
  );

  if (!artifact) {
    continue;
  }

  console.log(
    "Choosing artifact from run that started",
    new Intl.DateTimeFormat(undefined, {
      timeStyle: "medium",
      dateStyle: "medium",
      formatMatcher: "best fit",
    }).format(new Date(workflowRun.run_started_at!))
  );

  // Download the artifact
  const artifactResponse = await octokit.actions.downloadArtifact({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    artifact_id: artifact.id,
    archive_format: "zip", // GitHub artifacts are zipped
  });

  const downloadUrl = artifactResponse.url;

  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Failed to download artifact: ${response.statusText}`);
  }
  console.log(
    "Downloading",
    ARTIFACT_NAME,
    "from PR #" + PR_ID,
    "-",
    workflowRun.html_url
  );
  const blob = await response.blob();
  const filename = `${ARTIFACT_NAME}-pr-${PR_ID}-${workflowRun.id}.zip`;
  const dest = `bun-${PR_ID}-${workflowRun.head_sha}`;

  await $`rm -rf ${ARTIFACT_NAME} ${dest} ${ARTIFACT_NAME}.zip ${ARTIFACT_NAME}-artifact.zip ${filename}`;
  await Bun.write(filename, blob);
  await $`unzip ${filename} && rm -rf ${filename}`.quiet();
  await $`unzip ${ARTIFACT_NAME}.zip && rm -rf ${ARTIFACT_NAME}.zip`.quiet();
  await $`mv ${ARTIFACT_NAME} ${dest}`;

  const files = readdirSync(`./${dest}`);
  const inFolder =
    files.find((f) => f === "bun" || f === "bun.exe") ||
    files.find((f) => f === "bun-profile" || f === "bun-profile.exe");

  if (inFolder) {
    const fullName = `${inFolder}-${workflowRun.head_sha}-pr${PR_ID}`;
    await $`mv ${dest}/${inFolder} ${OUT_DIR}/${fullName} && rm -rf ${dest} ${OUT_DIR}/${inFolder}-${PR_ID} ${OUT_DIR}/${inFolder}-latest`.quiet();
    symlinkSync(
      `${OUT_DIR}/${fullName}`,
      `${OUT_DIR}/${inFolder}-${PR_ID}`,
      "file"
    );
    symlinkSync(
      `${OUT_DIR}/${fullName}`,
      `${OUT_DIR}/${inFolder}-latest`,
      "file"
    );
    console.write(
      "Downloaded to:" + "\n\n",
      `\x1b[1m\x1b[32m${OUT_DIR}/${fullName}\x1b[0m` + "\n\n",
      `To run the downloaded executable, use any of the following following commands:` +
        "\n\n",
      `\x1b[1m\x1b[32m${fullName}\x1b[0m\n`,
      `\x1b[1m\x1b[32m${inFolder}-${PR_ID}\x1b[0m\n`,
      `\x1b[1m\x1b[32m${inFolder}-latest\x1b[0m\n`
    );
  } else {
    console.log("No executable found in the artifact folder.", files);
  }
  process.exit(0);
}

console.log(`Artifact named ${ARTIFACT_NAME} not found.`);
process.exit(1);
