#!/usr/bin/env bun

// This uses the BuildKite browser-facing API instead of the public API.
// To avoid asking for credentials.

import { Octokit } from "@octokit/rest";
import { $ } from "bun";
import { realpathSync, readdirSync, symlinkSync } from "fs";
import { dirname, sep } from "path";

$.throws(true);
const cwd = realpathSync(import.meta.dir);
$.cwd(cwd);
process.chdir(cwd);

const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || (await $`gh auth token`.text()).trim(); // Replace with your GitHub token
const REPO_OWNER = process.env.BUN_REPO_OWNER || "oven-sh"; // Replace with the repository owner
const REPO_NAME = process.env.BUN_REPO_NAME || "bun"; // Replace with the repository name
type BuildkiteBuild = {
  id: string;
  graphql_id: string;
  url: string;
  web_url: string;
  number: number;
  state: string;
  cancel_reason: string | null;
  blocked: boolean;
  message: string;
  commit: string;
  branch: string;
  env: Record<string, any>;
  source: string;
  creator: Creator;
  jobs: Job[];
  created_at: string;
  scheduled_at: string;
  started_at: string;
  finished_at: string;
  meta_data: Record<string, any>;
  pull_request: Record<string, any>;
  rebuilt_from: RebuiltFrom | null;
  pipeline: Pipeline;
};

type Job = {
  id: string;
  graphql_id: string;
  type: string;
  name: string;
  step_key: string;
  step: {
    id: string;
    signature: {
      value: string;
      algorithm: string;
      signed_fields: string[];
    };
  };
  agent_query_rules: string[];
  state: string;
  web_url: string;
  log_url: string;
  raw_log_url: string;
  command: string;
  soft_failed: boolean;
  exit_status: number;
  artifact_paths: string;
  agent: Agent;
  created_at: string;
  scheduled_at: string;
  runnable_at: string;
  started_at: string;
  finished_at: string;
  retried: boolean;
  retried_in_job_id: string | null;
  retries_count: number | null;
  retry_type: string | null;
  parallel_group_index: number | null;
  parallel_group_total: number | null;
  matrix: Record<string, any> | null;
  cluster_id: string | null;
  cluster_url: string | null;
  cluster_queue_id: string | null;
  cluster_queue_url: string | null;
};

type Agent = {
  id: string;
  graphql_id: string;
  url: string;
  web_url: string;
  name: string;
  connection_state: string;
  hostname: string;
  ip_address: string;
  user_agent: string;
  creator: Creator;
  created_at: string;
};

type Creator = {
  id: string;
  name: string;
  email: string;
  avatar_url: string;
  created_at: string;
};

type RebuiltFrom = {
  id: string;
  number: number;
  url: string;
};

type Pipeline = {
  id: string;
  graphql_id: string;
  url: string;
  name: string;
  slug: string;
  repository: string;
  provider: {
    id: string;
    webhook_url: string;
  };
  skip_queued_branch_builds: boolean;
  skip_queued_branch_builds_filter: string | null;
  cancel_running_branch_builds: boolean;
  cancel_running_branch_builds_filter: string | null;
  builds_url: string;
  badge_url: string;
  created_at: string;
  scheduled_builds_count: number;
  running_builds_count: number;
  scheduled_jobs_count: number;
  running_jobs_count: number;
  waiting_jobs_count: number;
};

async function* getBuildkitePipelineUrl(buildkiteUrl: string) {
  const statusesResponse = await fetch(buildkiteUrl + "?per_page=100", {
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `token ${GITHUB_TOKEN}`,
    },
  });
  if (!statusesResponse.ok) {
    throw new Error(`Failed to fetch statuses: ${statusesResponse.statusText}`);
  }

  const statuses = await statusesResponse.json();
  yield* statuses
    .filter((status: any) => status.context === "buildkite/bun")
    .map((status: any) => status.target_url);

  let page = 1;
  while (true) {
    const nextResponse = await fetch(
      buildkiteUrl + "?per_page=100&page=" + page++,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `token ${GITHUB_TOKEN}`,
        },
      }
    );
    if (!nextResponse.ok) {
      break;
    }

    if (!nextResponse.headers.get("Link")) {
      break;
    }

    const json = await nextResponse.json();
    if (!json.length) {
      break;
    }
    yield* json
      .filter((status: any) => status.context === "buildkite/bun")
      .map((status: any) => status.target_url);
  }
}

async function* getBuildArtifacts(buildkiteUrl: string) {
  const buildkiteID = buildkiteUrl.split("/").at(-1);
  const pipelineUrl = `https://buildkite.com/bun/bun/builds/${buildkiteID}.json`;
  const response = await fetch(pipelineUrl);

  if (!response.ok) {
    return {
      fail: true,
      error: `Failed to fetch BuildKite builds: ${response.statusText}`,
    };
  }

  const result: BuildkiteBuild = (await response.json()) as BuildkiteBuild;
  const jobs = result.jobs.filter((job) =>
    job.step_key?.includes?.("build-bun")
  );

  if (!jobs.length) {
    return {
      fail: true,
      error: "No successful build found",
    };
  }

  for (const build of jobs) {
    const artifactsResponse = await fetch(
      new URL(build.base_path, "https://buildkite.com").href + "/artifacts"
    );

    if (!artifactsResponse.ok) {
      return {
        fail: true,
        error: `Failed to fetch artifacts: ${artifactsResponse.statusText}`,
      };
    }

    const artifacts = await artifactsResponse.json();

    // id: "01914e67-1a28-4812-bea7-78321eb1cc5d",
    // state: "finished",
    // path: "bun-darwin-x64.zip",
    // url: "/organizations/bun/pipelines/bun/builds/1771/jobs/01914e5f-50c8-4b95-9546-56a2ab0c3e0d/artifacts/01914e67-1a28-4812-bea7-78321eb1cc5d",
    // self_hosted: false,
    // expires_at: "2025-02-10T01:01:05.000Z",
    // can_delete_artifact: {
    // allowed: true,
    // reason: null,
    // message: null
    // },
    // mime_type: "application/zip",
    // file_name: "bun-darwin-x64.zip",
    // file_size: "18.9 MB",
    // sha1sum: "7fdd94c18cfea3189ae22c14e37675d80092c085",
    // sha256sum: "3cc2cb08be689f68c7b26941477c13783e18d8ba73c088b6d14248d8e742713d"
    // },
    const createdAt = new Date(build.created_at);
    const finishedAt = new Date(build.finished_at);

    yield* artifacts
      .filter((artifact) => artifact.file_name.includes(".zip"))
      .map((artifact: any) => ({
        url: new URL(artifact.url, "https://buildkite.com").href,
        filename: artifact.file_name,
        name: artifact.file_name.replace(".zip", ""),
        createdAt: createdAt,
        elapsed: finishedAt.getTime() - createdAt.getTime(),
        shasum: artifact.sha1sum,
      }));
  }
}

export async function* getBuildArtifactUrls(githubPRUrl: string) {
  for await (let url of getBuildkitePipelineUrl(githubPRUrl)) {
    const iter = getBuildArtifacts(url);
    while (true) {
      const result = await iter.next();
      if (!result?.value) {
        break;
      }

      yield result.value;
    }
  }
}

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

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

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

// Add this new function to fetch commit details
async function getCommitDetails(sha: string) {
  const { data: commitData } = await octokit.repos.getCommit({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    ref: sha,
  });
  return commitData;
}

// Modify the PR_ID logic to handle commit hashes
const PR_OR_COMMIT = await (async () => {
  let last = process.argv.at(-1);

  if (last?.startsWith("https://github.com")) {
    const parts = new URL(last).pathname.split("/");
    return parts[parts.length - 2] === "commit"
      ? { type: "commit", value: parts.at(-1) }
      : { type: "pr", value: parts.at(-1) };
  } else if (last?.startsWith("https://api.github.com")) {
    const parts = new URL(last).pathname.split("/");
    return parts[parts.length - 2] === "commits"
      ? { type: "commit", value: parts.at(-1) }
      : { type: "pr", value: parts.at(-1) };
  } else if (last?.startsWith("#")) {
    return { type: "pr", value: last.slice(1) };
  } else if (Number(last) === Number(last)) {
    return { type: "pr", value: last };
  }
  // long git sha or short git sha
  else if (last?.match(/^[0-9a-f]{40}$/) || last?.match(/^[0-9a-f]{7,}$/)) {
    return { type: "commit", value: last };
  } else {
    // resolve branch name to PR number or latest commit from argv
    const branch = last;
    let { data: prs = [] } = await octokit.pulls.list({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      state: "open",
      head: `${REPO_OWNER}:${branch}`,
    });

    if (prs.length) {
      return { type: "pr", value: prs[0].number.toString() };
    } else {
      const { data: commits } = await octokit.repos.listCommits({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        sha: branch,
        per_page: 1,
      });

      if (commits.length) {
        return { type: "commit", value: commits[0].sha };
      }

      throw new Error(`No open PR or recent commit found for branch ${branch}`);
    }
  }
})();

// Update console log to show whether we're searching for a PR or commit
console.log(
  "Searching GitHub for artifact",
  ARTIFACT_NAME,
  `from ${PR_OR_COMMIT.type === "pr" ? "PR #" : "commit"} ${
    PR_OR_COMMIT.value
  }...`
);

const OUT_DIR =
  process.env.BUN_OUT_DIR ||
  (Bun.which("bun")
    ? dirname(Bun.which("bun"))
    : process.env.BUN_INSTALL || ".");

// Modify the main download loop
let prData, commitData;
if (PR_OR_COMMIT.type === "pr") {
  // Get PR details to find the head commit SHA
  ({ data: prData } = await octokit.pulls.get({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: Number(PR_OR_COMMIT.value),
  }));
} else {
  // Get commit details
  commitData = await getCommitDetails(PR_OR_COMMIT.value);
}

const statusesUrl =
  PR_OR_COMMIT.type === "pr"
    ? prData.statuses_url
    : commitData.url + "/statuses";

for await (const artifact of await getBuildArtifactUrls(statusesUrl)) {
  if (!isArtifactName(artifact.name)) {
    continue;
  }

  console.log(
    "Choosing artifact from run that started",
    new Intl.DateTimeFormat(undefined, {
      timeStyle: "medium",
      dateStyle: "medium",
      formatMatcher: "best fit",
    }).format(artifact.createdAt)
  );

  const response = await fetch(artifact.url);
  if (!response.ok) {
    throw new Error(`Failed to download artifact: ${response.statusText}`);
  }
  console.log(
    "Downloading",
    JSON.stringify(ARTIFACT_NAME),
    `from ${PR_OR_COMMIT.type === "pr" ? "PR #" : "commit"} ${
      PR_OR_COMMIT.value
    }`,
    "\n-> " + artifact.url + "\n"
  );
  const blob = await response.blob();
  const filename = `${ARTIFACT_NAME}-${PR_OR_COMMIT.type}-${PR_OR_COMMIT.value}-${artifact.shasum}.zip`;
  const dest = `bun-${PR_OR_COMMIT.value}-${
    PR_OR_COMMIT.type === "pr" ? prData.head.sha : commitData.sha
  }`;
  await $`rm -rf ${ARTIFACT_NAME} ${dest} ${ARTIFACT_NAME}.zip ${ARTIFACT_NAME}-artifact.zip ${filename}`;
  await Bun.write(filename, blob);
  await $`unzip ${filename} && rm -rf ${filename}`.quiet();
  await $`cp -R ${ARTIFACT_NAME} ${dest}`;
  const files = readdirSync(`./${dest}`);
  const inFolder =
    files.find((f) => f === "bun" || f === "bun.exe") ||
    files.find((f) => f === "bun-profile" || f === "bun-profile.exe");
  if (inFolder) {
    const inFolderWithoutExtension = inFolder.replaceAll(".exe", "");
    let extension = "";
    if (process.platform === "win32") {
      extension = ".exe";
    }

    let fullName = `${inFolderWithoutExtension}-${
      PR_OR_COMMIT.type === "pr" ? prData.head.sha : commitData.sha
    }-${PR_OR_COMMIT.type}${PR_OR_COMMIT.value}${extension}`;

    await $`cp ${dest}/${inFolder} ${OUT_DIR}/${fullName} && rm -rf ${dest} ${OUT_DIR}/${inFolderWithoutExtension}-${PR_OR_COMMIT.value}${extension} ${OUT_DIR}/${inFolderWithoutExtension}-latest${extension}`.quiet();
    symlinkSync(
      `${OUT_DIR}/${fullName}`,
      `${OUT_DIR}/${inFolderWithoutExtension}-${PR_OR_COMMIT.value}${extension}`,
      "file"
    );
    symlinkSync(
      `${OUT_DIR}/${fullName}`,
      `${OUT_DIR}/${inFolderWithoutExtension}-latest${extension}`,
      "file"
    );
    console.write(
      "Downloaded to:" + "\n\n",
      `\x1b[1m\x1b[32m${OUT_DIR}${sep}${fullName}\x1b[0m` + "\n\n",
      `To run the downloaded executable, use any of the following following commands:` +
        "\n\n",
      `\x1b[1m\x1b[32m${fullName.replaceAll(".exe", "")}${extension}\x1b[0m\n`,
      `\x1b[1m\x1b[32m${inFolderWithoutExtension}-${PR_OR_COMMIT.value}${extension}\x1b[0m\n`,
      `\x1b[1m\x1b[32m${inFolderWithoutExtension}-latest${extension}\x1b[0m\n`
    );
  } else {
    console.log("No executable found in the artifact folder.", files);
  }
  process.exit(0);
}

console.log(
  `Artifact named ${ARTIFACT_NAME} not found for ${PR_OR_COMMIT.type} ${PR_OR_COMMIT.value}.`
);
process.exit(1);
