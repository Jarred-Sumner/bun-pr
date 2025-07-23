#!/usr/bin/env bun

// This uses the BuildKite browser-facing API instead of the public API.
// To avoid asking for credentials.

import { Octokit } from "@octokit/rest";
import { $ } from "bun";
import { realpathSync, readdirSync, symlinkSync } from "fs";
import { cp } from "fs/promises";
import { dirname, sep, join, basename } from "path";
import { tmpdir } from "os";

$.throws(true);
const originalCwd = process.cwd();
const cwd = realpathSync(import.meta.dir);
$.cwd(cwd);
process.chdir(cwd);

let cachedResponses = new Map<string, Promise<Response>>();
async function fetch(url: string, options: RequestInit) {
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
  yield* statuses
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

async function* getBuildArtifacts(
  buildkiteUrl: string,
  options?: { includeAllJobs?: boolean }
) {
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

  let jobs = result.jobs;

  if (!options?.includeAllJobs) {
    jobs = result.jobs.filter((job) => {
      if (IS_LLDB || IS_GDB) {
        return job.step_key?.includes?.("test-bun");
      }
      return job.step_key?.includes?.("build-bun");
    });

    if (!jobs.length) {
      console.debug(
        `Build ${buildkiteID} has no ${IS_LLDB || IS_GDB ? "test-bun" : "build-bun"} jobs`
      );
      return;
    }
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
        if (!options?.includeAllJobs) {
          if (IS_LLDB || IS_GDB) {
            // Look for core dump artifacts
            if (
              !artifact.file_name.includes(".tar.gz.age") &&
              !artifact.file_name.includes(".cores")
            )
              continue;
          } else {
            if (!artifact.file_name.includes(".zip")) continue;
          }
        }

        if (!artifact.url) {
          console.debug(`Artifact ${artifact.file_name} has no URL`);
          continue;
        }

        try {
          const fullUrl = new URL(artifact.url, "https://buildkite.com");
          yield {
            url: fullUrl.toString(),
            filename: artifact.file_name,
            name: artifact.file_name
              .replace(".zip", "")
              .replace(".tar.gz.age", ""),
            createdAt: createdAt,
            elapsed: finishedAt.getTime() - createdAt.getTime(),
            shasum: artifact.sha1sum,
            jobName: build.name,
            stepKey: build.step_key,
            buildId: buildkiteID,
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

const IS_ASAN = (() => {
  const asanIndex = process.argv.findIndex((a) => a === "--asan");
  if (asanIndex !== -1) {
    process.argv.splice(asanIndex, 1);
    return true;
  }
})();

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

const IS_LLDB = (() => {
  const lldbIndex = process.argv.findIndex((a) => a === "--lldb");
  if (lldbIndex !== -1) {
    process.argv.splice(lldbIndex, 1);
    return true;
  } else {
    return false;
  }
})();

const IS_GDB = (() => {
  const gdbIndex = process.argv.findIndex((a) => a === "--gdb");
  if (gdbIndex !== -1) {
    process.argv.splice(gdbIndex, 1);
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

  if (IS_ASAN) {
    basename += "-asan";
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
  let last = process.argv.at(-1) || "";

  if (last === "." || last === import.meta.path) {
    const currentBranchName = (
      await $`git rev-parse --abbrev-ref HEAD`.cwd(originalCwd).text()
    ).trim();
    $.cwd(cwd);
    if (currentBranchName === "main" || currentBranchName === "master") {
      // return the most recent commit
      const { data: commits } = await octokit.repos.listCommits({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        per_page: 1,
      });
      return { type: "commit", value: commits[0].sha };
    }

    // get the current PR o r commit
    const { data: prs } = await octokit.pulls.list({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      state: "open",
      head: `${REPO_OWNER}:${currentBranchName}`,
    });
    if (prs.length) {
      return { type: "pr", value: prs[0].number.toString() };
    } else {
      const { data: commits } = await octokit.repos.listCommits({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        sha: currentBranchName,
        per_page: 1,
      });
      if (commits.length) {
        return { type: "commit", value: commits[0].sha };
      }
    }
  }

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
if (!IS_LLDB && !IS_GDB) {
  console.log(
    "Searching GitHub for artifact",
    ARTIFACT_NAME,
    `from ${PR_OR_COMMIT.type === "pr" ? "PR #" : "commit"} ${
      PR_OR_COMMIT.value
    }...`
  );
}

const OUT_DIR =
  process.env.BUN_OUT_DIR ||
  (Bun.which("bun")
    ? dirname(Bun.which("bun"))
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
  const response = await getCommitDetails(PR_OR_COMMIT.value);

  if (!response?.url || !response?.sha) {
    throw new Error(`Failed to fetch commit data for ${PR_OR_COMMIT.value}`);
  }

  statusesUrl = response.url + "/statuses";
  commitData = response;
}

if (IS_LLDB || IS_GDB) {
  // Handle --lldb/--gdb mode for debugging core dumps
  const coreDumps: Array<{ artifact: any; pid?: string }> = [];
  let selectedDump: { artifact: any; pid?: string } | null = null;
  let userSelection: string | null = null;
  let isCollecting = true;

  console.log("\n🔍 Searching for core dumps...\n");

  // Create a single stdin reader that we'll use for all input
  let stdinReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let inputBuffer = "";

  let hasSelection = false;

  async function getNextLine(): Promise<string> {
    if (!stdinReader) {
      stdinReader = Bun.stdin.stream().getReader();
    }

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await stdinReader.read();
      if (done) return inputBuffer;

      inputBuffer += decoder.decode(value);
      const newlineIndex = inputBuffer.indexOf("\n");

      if (newlineIndex !== -1) {
        const line = inputBuffer.slice(0, newlineIndex).trim();
        inputBuffer = inputBuffer.slice(newlineIndex + 1);
        hasSelection = true;
        return line;
      }
    }
  }

  // Start listening for user input immediately
  let inputPromise = getNextLine();
  let inputProcessed = false;

  // Collect core dumps and display them as we find them
  for await (const artifact of await getBuildArtifactUrls(statusesUrl)) {
    if (
      artifact.filename.includes(".tar.gz.age") ||
      artifact.filename.includes(".cores")
    ) {
      coreDumps.push({ artifact });

      // Parse the job name to extract useful info
      const jobName = artifact.jobName;
      let displayName = jobName.replace(/\s*-\s*test-bun$/, "");

      // Extract OS info
      const isASAN = jobName.includes("ASAN");
      const isBaseline = jobName.includes("baseline");

      // Format the display line
      const num = coreDumps.length;
      console.log(`\x1b[32m${num}\x1b[90m)\x1b[0m ${displayName}`);
    }

    // Check if user has made a selection (check after every artifact, not just core dumps)
    if (!inputProcessed && inputPromise) {
      // Use Promise.race with a tiny timeout to check if input is ready
      const raceResult = await Promise.race([
        inputPromise.then((v) => ({ type: "input", value: v })),
        new Promise((resolve) =>
          setTimeout(() => resolve({ type: "continue" }), 1)
        ),
      ]);

      if (raceResult.type === "input") {
        inputProcessed = true;
        userSelection = raceResult.value;
        const index = parseInt(userSelection) - 1;
        if (index >= 0 && index < coreDumps.length) {
          selectedDump = coreDumps[index];
          isCollecting = false;
          // Cancel and close the stdin reader immediately
          if (stdinReader) {
            await stdinReader.cancel();
            stdinReader = null;
          }
          break;
        }
      }
    }
    if (hasSelection) break;
  }

  isCollecting = false;

  // If we still have the reader open and no selection was made, close it
  if (stdinReader && !selectedDump) {
    await stdinReader.cancel();
    stdinReader = null;
  }

  if (!selectedDump && coreDumps.length === 0) {
    console.log(
      `\n❌ No core dumps found for ${PR_OR_COMMIT.type} ${PR_OR_COMMIT.value}.`
    );
    process.exit(1);
  }

  // If no selection was made yet, wait for one
  if (!selectedDump) {
    if (coreDumps.length === 1) {
      selectedDump = coreDumps[0];
      console.log(`\n✓ Auto-selected the only core dump`);
    } else {
      // Only read input if we haven't already received it
      if (!userSelection) {
        console.log(`\nChoose a core dump number:`);
        // If we already closed the reader, create a new one
        if (!stdinReader) {
          userSelection = await getNextLine();
        } else {
          userSelection = await inputPromise;
        }
      }

      const index = parseInt(userSelection || "0") - 1;
      if (index >= 0 && index < coreDumps.length) {
        selectedDump = coreDumps[index];
      } else {
        console.log("❌ Invalid selection");
        process.exit(1);
      }
    }
  }

  console.log(`\n\x1b[90m${"─".repeat(50)}\x1b[0m`);
  const selectedNum = coreDumps.indexOf(selectedDump) + 1;
  const jobUrl = `https://buildkite.com/bun/bun/builds/${selectedDump.artifact.buildId}`;
  // ANSI OSC 8 hyperlink format: \x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\
  console.log(`\x1b[32m✓ Selected #${selectedNum}: \x1b]8;;${jobUrl}\x1b\\${selectedDump.artifact.jobName}\x1b]8;;\x1b\\\x1b[0m`);

  // Check for AGE_CORES_IDENTITY environment variable
  if (!process.env.AGE_CORES_IDENTITY?.startsWith("AGE-SECRET-KEY-")) {
    console.error("\n❌ AGE_CORES_IDENTITY not set");
    console.error("   Set AGE_CORES_IDENTITY to your age secret key");
    process.exit(1);
  }

  // Parse the core dump filename to extract OS and architecture
  const coreFilename = selectedDump.artifact.filename;
  let os = "";
  let arch = "";
  let isBaseline = false;

  // Extract OS
  if (coreFilename.includes("darwin") || coreFilename.includes("macos")) {
    os = "darwin";
  } else if (
    coreFilename.includes("alpine") ||
    coreFilename.includes("debian") ||
    coreFilename.includes("ubuntu")
  ) {
    os = "linux";
  } else if (coreFilename.includes("windows")) {
    os = "windows";
  }

  // Extract architecture
  if (coreFilename.includes("aarch64") || coreFilename.includes("arm64")) {
    arch = "aarch64";
  } else if (coreFilename.includes("x64") || coreFilename.includes("x86_64")) {
    arch = "x64";
  }

  // Check if it's baseline
  if (
    coreFilename.includes("baseline") ||
    selectedDump.artifact.jobName?.includes("baseline")
  ) {
    isBaseline = true;
  }

  // Get the build URL for this specific build to find the matching bun executable
  const buildUrl = `https://buildkite.com/bun/bun/builds/${selectedDump.artifact.buildId}`;

  process.stdout.write("\n🔍 Finding matching bun executable...");

  // Look for build-bun job artifacts in the same build
  let bunArtifact: any = null;
  for await (const artifact of getBuildArtifacts(buildUrl, {
    includeAllJobs: true,
  })) {
    if (!artifact.filename.includes(".zip")) continue;
    if (!artifact.stepKey?.includes("build-bun")) continue;

    const artifactName = artifact.name.toLowerCase();
    const matchesOS = artifactName.includes(os);
    const matchesArch = artifactName.includes(
      arch === "x64" ? "x64" : "aarch64"
    );
    const matchesBaseline = isBaseline
      ? artifactName.includes("baseline")
      : !artifactName.includes("baseline");
    const matchesProfile = artifactName.includes("profile");

    if (matchesOS && matchesArch && matchesBaseline && matchesProfile) {
      bunArtifact = artifact;
      process.stdout.write(" ✓\n");
      break;
    }
  }

  if (!bunArtifact) {
    process.stdout.write(" ❌\n");
    console.error(
      `Could not find: bun-${os}-${arch}${
        isBaseline ? "-baseline" : ""
      }-profile`
    );
    process.exit(1);
  }

  // Download both artifacts in parallel
  const id = Bun.hash(selectedDump.artifact.url + bunArtifact.url).toString(36);
  const dir = join(tmpdir(), `bun-pr-debug-${id}.tmp`);
  await $`mkdir -p ${dir}`.quiet();

  process.stdout.write("📥 Downloading artifacts...");

  // Start both downloads in parallel
  const [coresResponse, bunResponse] = await Promise.all([
    fetch(selectedDump.artifact.url),
    fetch(bunArtifact.url),
  ]);

  if (!coresResponse.ok) {
    process.stdout.write(" ❌\n");
    throw new Error(
      `Failed to download core dump: ${coresResponse.statusText}`
    );
  }
  if (!bunResponse.ok) {
    process.stdout.write(" ❌\n");
    throw new Error(
      `Failed to download bun executable: ${bunResponse.statusText}`
    );
  }

  // Write both files in parallel
  const coresPath = join(dir, selectedDump.artifact.filename);
  const bunPath = join(dir, bunArtifact.filename);

  await Promise.all([
    Bun.write(coresPath, await coresResponse.blob()),
    Bun.write(bunPath, await bunResponse.blob()),
  ]);

  process.stdout.write(" ✓\n");

  // Extract bun executable
  process.stdout.write("📦 Extracting...");
  await $`unzip -j -o ${bunPath} -d ${dir}`.quiet();

  // Find the executable
  let bunExecutable: string | null = null;
  const files = readdirSync(dir);
  const exeFile = files.find(
    (f) =>
      f === "bun" ||
      f === "bun.exe" ||
      f === "bun-profile" ||
      f === "bun-profile.exe"
  );
  if (exeFile) {
    bunExecutable = join(dir, exeFile);
    await $`chmod +x ${bunExecutable}`.quiet();
  }

  if (!bunExecutable) {
    process.stdout.write(" ❌\n");
    console.error("Could not find bun executable in the archive.");
    process.exit(1);
  }

  // Decrypt core dump
  await $`bash -c ${`age -d -i <(echo "$AGE_CORES_IDENTITY") < ${coresPath} | tar -zxC ${dir}`}`.quiet();
  process.stdout.write(" ✓\n");

  // Find the core file
  let coreFiles: string[] = [];
  const dirContents = readdirSync(dir);

  // First check for core files in the root directory
  coreFiles = dirContents.filter((f) => f.includes(".core"));

  if (coreFiles.length === 0) {
    // Check nested directories
    for (const item of dirContents) {
      const itemPath = join(dir, item);
      try {
        const stats = Bun.file(itemPath);
        // Check if it's a directory (not a file)
        if (
          item.startsWith("bun-cores-") &&
          !item.endsWith(".age") &&
          !item.endsWith(".zip")
        ) {
          const nestedFiles = readdirSync(itemPath).filter((f) =>
            f.includes(".core")
          );
          for (const file of nestedFiles) {
            await $`mv ${join(itemPath, file)} ${join(dir, file)}`.quiet();
            coreFiles.push(file);
          }
        }
      } catch (e) {
        // Not a directory, skip
      }
    }
  }

  if (coreFiles.length === 0) {
    console.error("❌ No core files found in the archive");
    process.exit(1);
  }

  // Extract PID from core filename if available
  let selectedCore = coreFiles[0];
  if (coreFiles.length > 1) {
    console.log("\nMultiple core files found:");
    coreFiles.forEach((file, index) => {
      console.log(`\x1b[32m${index + 1}\x1b[90m)\x1b[0m ${file}`);
    });
    process.stdout.write(`\nChoose a core file (1-${coreFiles.length}): `);
    const selection = await getNextLine();
    const index = parseInt(selection || "1") - 1;
    if (index >= 0 && index < coreFiles.length) {
      selectedCore = coreFiles[index];
    }
  }

  // Cancel the stdin reader before launching lldb
  if (stdinReader) {
    await stdinReader.cancel();
    stdinReader = null;
  }

  // Launch debugger
  const corePath = join(dir, selectedCore);
  const debuggerPath = IS_GDB ? "gdb" : "lldb";
  
  console.log("\n🚀 Launching debugger:");
  
  let debuggerArgs: string[];
  if (IS_GDB) {
    // GDB syntax
    debuggerArgs = [debuggerPath, bunExecutable, corePath];
    console.log(`\n\x1b[1m${debuggerPath} ${bunExecutable} ${corePath}\x1b[0m`);
    console.log("\n\x1b[90mUseful commands: bt | bt full | frame <n> | p <variable> | quit\x1b[0m\n");
  } else {
    // LLDB syntax
    debuggerArgs = [debuggerPath, "--core", corePath, bunExecutable];
    console.log(`\n\x1b[1m${debuggerPath} --core ${corePath} ${bunExecutable}\x1b[0m`);
    console.log("\n\x1b[90mUseful commands: bt | bt all | frame select <n> | p <variable> | quit\x1b[0m\n");
  }

  const proc = await Bun.spawn(debuggerArgs, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  process.exit(proc.exitCode || 0);
}

// Original artifact download logic
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
  await Bun.write(filename, blob);
  await $`unzip ${filename} && rm -rf ${filename}`.quiet();
  await $`cp -R ${ARTIFACT_NAME} ${dest}`;
  const files = readdirSync(`./${dest}`);
  const inFolder =
    files.find((f) => f === "bun" || f === "bun.exe") ||
    files.find((f) => f === "bun-profile" || f === "bun-profile.exe") ||
    files.find((f) => f === "bun-asan" || f === "bun-asan.exe");
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
