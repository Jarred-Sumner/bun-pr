#!/usr/bin/env bun

// This uses the BuildKite browser-facing API instead of the public API.
// To avoid asking for credentials.

import { Octokit } from "@octokit/rest";
import { $ } from "bun";
import { realpathSync, readdirSync, symlinkSync } from "fs";
import { cp } from "fs/promises";
import { dirname, sep } from "path";

$.throws(true);
const cwd = realpathSync(import.meta.dir);
$.cwd(cwd);
process.chdir(cwd);

let cachedResponses = new Map<string, Promise<Response>>();

async function fetch(url: string, options?: RequestInit) {
  if (cachedResponses.has(url)) {
    return (await cachedResponses.get(url))!.clone();
  }
  let defer = Promise.withResolvers<Response>();
  cachedResponses.set(url, defer.promise);
  const response = await Bun.fetch(url, options);
  defer.resolve(response.clone());
  return response;
}

let GITHUB_TOKEN = "";
try {
  GITHUB_TOKEN =
    process.env.GITHUB_TOKEN || (await $`gh auth token`.text()).trim(); // Replace with your GitHub token
} catch (e) {}

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
  state: string;
  base_path: string;
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
  const headers = {
    Accept: "application/vnd.github.v3+json",
    ...(GITHUB_TOKEN ? { Authorization: `token ${GITHUB_TOKEN}` } : {}),
  };

  const statusesResponse = await fetch(buildkiteUrl + "?per_page=100", {
    headers,
  });
  if (!statusesResponse.ok) {
    throw new Error(`Failed to fetch statuses: ${statusesResponse.statusText}`);
  }

  const statuses = (await statusesResponse.json()) as Array<{
    context: string;
    target_url: string;
  }>;
  yield * statuses
    .filter((status) => status.context === "buildkite/bun")
    .map((status) => status.target_url);
}

async function* getPRCommits(prNumber: number) {
  const { data: commits } = await octokit.pulls.listCommits({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: prNumber,
    per_page: 100,
  });

  commits.sort(
    (a, b) =>
      new Date(b.commit?.author?.date || "").getTime() -
      new Date(a.commit?.author?.date || "").getTime()
  );

  // Start with newest commits
  for (const commit of commits) {
    const { data: statuses } = await octokit.repos.listCommitStatusesForRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: commit.sha,
    });

    const buildkiteStatuses = statuses
      .filter((status) => status.context.includes("buildkite"))
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

    for (const status of buildkiteStatuses) {
      if (status.target_url) {
        yield status.target_url;
      }
    }
  }
}

async function* getBuildArtifacts(buildkiteUrl: string) {
  let buildkiteID = buildkiteUrl.split("/").at(-1);

  if (!buildkiteID) {
    console.debug("Invalid buildkite URL");
    return;
  }

  if (buildkiteID.includes("#")) {
    buildkiteID = buildkiteID.split("#").at(0);
  }

  const pipelineUrl = `https://buildkite.com/bun/bun/builds/${buildkiteID}.json`;
  const response = await fetch(pipelineUrl);

  if (!response.ok) {
    console.debug(
      `Build ${buildkiteID} not accessible: ${response.statusText}`
    );
    return;
  }

  try {
    var result: BuildkiteBuild = (await response.json()) as BuildkiteBuild;
  } catch (e) {
    console.debug(`Failed to parse buildkite build ${buildkiteID}: ${e}`);
    return;
  }

  // Skip builds that aren't finished yet
  if (
    result.state !== "passed" &&
    result.state !== "failed" &&
    result.state !== "finished" &&
    result.state !== "failing" &&
    result.state !== "canceled" &&
    result.state !== "started"
  ) {
    console.debug(
      `Build ${buildkiteID} is in state: ${result.state}, ignoring...`
    );
    return;
  }

  const jobs = result.jobs.filter((job) =>
    job.step_key?.includes?.("build-bun")
  );

  if (!jobs.length) {
    console.debug(`Build ${buildkiteID} has no build-bun jobs`);
    return;
  }

  for (const build of jobs) {
    if (!build.base_path) {
      console.debug(`Build ${buildkiteID} job ${build.id} has no base path`);
      continue;
    }

    try {
      const artifactsUrl = new URL(build.base_path, "https://buildkite.com");
      const artifactsPath = artifactsUrl.pathname + "/artifacts";
      artifactsUrl.pathname = artifactsPath;

      const artifactsResponse = await fetch(artifactsUrl.toString());

      if (!artifactsResponse.ok) {
        console.debug(
          `Failed to fetch artifacts for build ${buildkiteID}: ${artifactsResponse.statusText}`
        );
        continue;
      }

      const artifacts = (await artifactsResponse.json()) as Array<{
        file_name: string;
        url: string;
        sha1sum: string;
      }>;

      const createdAt = new Date(build.created_at);
      const finishedAt = new Date(build.finished_at);

      for (const artifact of artifacts) {
        if (!artifact.file_name.includes(".zip")) continue;

        if (!artifact.url) {
          console.debug(`Artifact ${artifact.file_name} has no URL`);
          continue;
        }

        try {
          const fullUrl = new URL(artifact.url, "https://buildkite.com");
          yield {
            url: fullUrl.toString(),
            filename: artifact.file_name,
            name: artifact.file_name.replace(".zip", ""),
            createdAt: createdAt,
            elapsed: finishedAt.getTime() - createdAt.getTime(),
            shasum: artifact.sha1sum,
          };
        } catch (error) {
          console.debug(`Failed to parse artifact URL: ${error}`);
          continue;
        }
      }
    } catch (error) {
      console.debug(`Failed to process build ${buildkiteID}: ${error}`);
      continue;
    }
  }
}

export async function* getBuildArtifactUrls(githubPRUrl: string) {
  if (PR_OR_COMMIT.type === "pr") {
    // For PRs, check all commits
    for await (const url of getPRCommits(Number(PR_OR_COMMIT.value))) {
      yield* getBuildArtifacts(url);
    }
  } else {
    // For single commits, use the original behavior
    for await (const url of getBuildkitePipelineUrl(githubPRUrl)) {
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

function isArtifactName(name: string) {
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
    ? dirname(Bun.which("bun") as string)
    : process.env.BUN_INSTALL || ".");

// Modify the main download loop
type PRData = { statuses_url: string; head: { sha: string } };
type CommitData = { url: string; sha: string };

let statusesUrl: string;
let prData: PRData | undefined;
let commitData: CommitData | undefined;

if (PR_OR_COMMIT.type === "pr") {
  // Get PR details to find the head commit SHA
  const response = await octokit.pulls.get({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: Number(PR_OR_COMMIT.value),
  });

  if (!response.data?.statuses_url || !response.data?.head?.sha) {
    throw new Error(`Failed to fetch PR data for PR #${PR_OR_COMMIT.value}`);
  }

  statusesUrl = response.data.statuses_url;
  prData = response.data;
} else {
  // Get commit details
  const response = await getCommitDetails(PR_OR_COMMIT.value!);

  if (!response?.url || !response?.sha) {
    throw new Error(`Failed to fetch commit data for ${PR_OR_COMMIT.value}`);
  }

  statusesUrl = response.url + "/statuses";
  commitData = response;
}

for await (const artifact of await getBuildArtifactUrls(statusesUrl)) {
  if (!isArtifactName(artifact.name)) {
    if (process.env.DEBUG) {
      console.debug("Skipping artifact", artifact.name);
    }
    continue;
  }

  console.log("Found artifact", artifact.name);
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

  // Get the appropriate SHA based on whether this is a PR or commit
  const sha = PR_OR_COMMIT.type === "pr" ? prData?.head.sha : commitData?.sha;

  if (!sha) {
    throw new Error("Failed to get commit SHA");
  }

  const dest = `bun-${PR_OR_COMMIT.value}-${sha}`;

  await $`rm -rf ${ARTIFACT_NAME} ${dest} ${ARTIFACT_NAME}.zip ${ARTIFACT_NAME}-artifact.zip ${filename}`;
  await Bun.write(filename, blob as Blob);
  if (process.platform === "win32") {
    await $`tar -xf ${filename} && rm -rf ${filename}`.quiet();
  } else {
    await $`unzip ${filename} && rm -rf ${filename}`.quiet();
  }
  await $`cp -R ${ARTIFACT_NAME} ${dest}`;
  await $`rm -rf ${ARTIFACT_NAME}`;
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

    let fullName = `${inFolderWithoutExtension}-${sha}-${PR_OR_COMMIT.type}${PR_OR_COMMIT.value}${extension}`;
    const dSYM = files.find((f) => f.toLowerCase().endsWith(".dsym"));
    if (dSYM) {
      const dsymDest = `${OUT_DIR}/${fullName}.dSYM`;
      try {
        await cp(`${dest}/${dSYM}`, dsymDest, {
          recursive: true,
          force: true,
        });
        console.log(`Copied debugging symbols to:\n  ${dsymDest}`);
      } catch (e) {
        console.debug(`No .dSYM file found or failed to copy: ${e}`);
      }
    }

    await $`cp ${dest}/${inFolder} ${OUT_DIR}/${fullName} && rm -rf ${dest} ${OUT_DIR}/${inFolderWithoutExtension}-${PR_OR_COMMIT.value}${extension} ${OUT_DIR}/${inFolderWithoutExtension}-latest${extension}`.quiet();

    /**
     * Need admin perms in shell (Windows)
     * @see https://github.com/pnpm/pnpm/issues/4315
     * @see https://github.com/nodejs/node-v0.x-archive/issues/9101
     */
    symlinkSync(
      `${OUT_DIR}${sep}${fullName}`,
      `${OUT_DIR}${sep}${inFolderWithoutExtension}-${PR_OR_COMMIT.value}${extension}`,
      "file"
    );
    symlinkSync(
      `${OUT_DIR}${sep}${fullName}`,
      `${OUT_DIR}${sep}${inFolderWithoutExtension}-latest${extension}`,
      "file"
    );
    console.write(
      "Downloaded to:" +
      "\n\n" +
      `\x1b[1m\x1b[32m${OUT_DIR}${sep}${fullName}\x1b[0m` +
      "\n\n" +
      "To run the downloaded executable, use any of the following following commands:" +
      "\n\n" +
      `\x1b[1m\x1b[32m${fullName.replaceAll(
        ".exe",
        ""
      )}${extension}\x1b[0m\n` +
      `\x1b[1m\x1b[32m${inFolderWithoutExtension}-${PR_OR_COMMIT.value}${extension}\x1b[0m\n` +
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
