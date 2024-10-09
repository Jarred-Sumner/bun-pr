#!/usr/bin/env bun
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { $ } from "bun";

import { join, dirname } from "path";
const executableName = (sha: string) => `bun-${sha}-commit${sha}`;
let notFoundDir = join(import.meta.dir, ".not-found");

function findBunDir() {
  const exe = Bun.which("bun-debug");
  if (!exe) {
    throw new Error(
      "bun-debug, which is used to find the path to the bun directory locally, is not found"
    );
  }
  let currentRoot = realpathSync(dirname(exe));
  while (true) {
    const json = join(currentRoot, "package.json");
    try {
      const packageJson = JSON.parse(readFileSync(json, "utf8"));
      if (packageJson.name === "bun") {
        console.log("Using bun dir", currentRoot);
        return currentRoot;
      }
    } catch (e) {
      // ignore
    }
    const parent = dirname(currentRoot);
    if (!parent || parent === "/" || parent === "C:\\") {
      throw new Error("Can't find bun directory.");
    }
    currentRoot = parent;
  }
}

async function ensureExecutable(sha: string) {
  if (Bun.which(executableName(sha))) {
    return true;
  }
  $.nothrow();
  if (existsSync(join(notFoundDir, sha))) {
    return false;
  }
  const result = await $`bun ${join(
    import.meta.dir,
    "bun-pr.ts"
  )} ${sha}`.quiet();
  try {
    chmodSync(realpathSync(Bun.which(executableName(sha))!), 0o777);
  } catch (e) {}
  if (!Bun.which(executableName(sha))) {
    console.warn("Failed to create executable for", sha);
    console.log(result.stdout.toString());
    console.log(result.stderr.toString());
    try {
      writeFileSync(join(notFoundDir, sha), sha);
    } catch (e) {
      mkdirSync(notFoundDir, { recursive: true });
      writeFileSync(join(notFoundDir, sha), sha);
    }
    return false;
  }

  console.log("Downloaded", sha);

  return true;
}

const [, , commitRange, scriptToRun, ...args] = process.argv;

if (!commitRange || !scriptToRun) {
  console.error(
    "Usage: bun ./bun-reduce.ts <commit-range> <script-to-run> [args...]"
  );
  process.exit(1);
}

const [startCommit, endCommit] = commitRange.split("...");

if (!startCommit || !endCommit) {
  console.error(
    "Invalid commit range. Please use the format: startCommit...endCommit"
  );
  process.exit(1);
}

const BUN_DIR = findBunDir();
async function getCommitsBetween(
  start: string,
  end: string
): Promise<string[]> {
  const $$ = new $.Shell();
  const result = await $$.cwd(
    BUN_DIR
  )`git log --format=%H ${start}..${end}`.text();
  return result.trim().split("\n").reverse();
}

async function testCommit(commit: string): Promise<1 | 0 | -1> {
  if (!(await ensureExecutable(commit))) {
    console.log(`Skipping commit ${commit} - executable not available`);
    return -1;
  }

  const result = await $`${executableName(commit)} ${scriptToRun} ${{
    raw: args.join(" "),
  }}`.quiet();

  if (result.exitCode !== 0) {
    return 0;
  }

  return 1;
}

async function binarySearch(
  commits: string[]
): Promise<[string | null, string | null]> {
  let left = 0;
  let right = commits.length - 1;
  let lastPass: string | null = null;
  let firstFail: string | null = null;
  let skipped = 0;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    let commit = commits[mid];

    let result = await testCommit(commit);
    while (result === -1) {
      // handle skipped
      skipped++;

      commit = commits[mid - skipped];
      if (mid - skipped <= 0) {
        return [null, commit];
      }
      result = await testCommit(commit);
    }

    console.log(
      // pass green check, fail red x
      (result === 1
        ? Bun.color("#3498db", "ansi") + "✓"
        : result === 0
        ? Bun.color("#e74c3c", "ansi") + "✕"
        : Bun.color("#f39c12", "ansi") + "⚠") +
        (Bun.enableANSIColors ? "\x1b[0m" : ""),
      // reset color as escaped string

      (result === 1
        ? Bun.color("#3498db", "ansi")
        : result === 0
        ? Bun.color("#e74c3c", "ansi")
        : Bun.color("#f39c12", "ansi")) +
        commit +
        (Bun.enableANSIColors ? "\x1b[0m" : "")
    );
    if (result === 1) {
      lastPass = commit;
      left = mid + 1;
    } else {
      firstFail = commit;
      right = mid - 1;
    }
    skipped = 0;
  }

  return [lastPass, firstFail];
}

async function getCommitMessage(commit: string): Promise<string> {
  const $$ = new $.Shell();
  // just the message text and a date, separated by newline
  const result = await $$.cwd(
    BUN_DIR
  )`git log -n 1 --pretty=format:"%s - %ad" ${commit}`.text();
  return result.trim();
}

async function main() {
  console.log(`Fetching commits between ${startCommit} and ${endCommit}...`);
  const commits = await getCommitsBetween(startCommit, endCommit);

  let downloadedCommits = [];

  for (const commit of commits) {
    downloadedCommits.push(
      ensureExecutable(commit).then((success) => [commit, success])
    );
  }

  const availableCommits: string[] = (await Promise.all(downloadedCommits))
    .filter(([, available]) => available)
    .map(([commit]) => commit);

  console.log(`Binary searching ${availableCommits.length} commits...`);
  const [lastPass, firstFail] = await binarySearch(availableCommits);

  if (lastPass && firstFail) {
    const url = `https://github.com/oven-sh/bun/compare/${lastPass}...${firstFail}`;
    console.log(
      `
${Bun.color("#3498db", "ansi")}${lastPass}${
        Bun.enableANSIColors ? "\x1b[0m" : ""
      } - last passing commit
${await getCommitMessage(lastPass).then((msg) =>
  msg.length > 500 ? msg.slice(0, 500) + "..." : msg
)}

${Bun.color("#e74c3c", "ansi")}${firstFail}${
        Bun.enableANSIColors ? "\x1b[0m" : ""
      } - first failing commit
${await getCommitMessage(firstFail).then((msg) =>
  msg.length > 500 ? msg.slice(0, 500) + "..." : msg
)}

Compare on GitHub:

  \x1b[1m${url}\x1b[0m`
    );
    if (process.platform === "darwin") {
      await $`open ${url}`.quiet();
    }
  } else if (lastPass) {
    console.log(`All commits pass. Last commit tested: ${lastPass}`);
  } else if (firstFail) {
    console.log(`All commits fail. First commit tested: ${firstFail}`);
  } else {
    console.log("No commits were successfully tested.");
  }
}

main().catch((error) => {
  console.error("An error occurred:", error);
  process.exit(1);
});
