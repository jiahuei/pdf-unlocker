"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const MARKER = "<!-- pages-pr-preview -->";

function git(repository, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: repository,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function selectedPath(filename, config) {
  if (
    !filename ||
    filename.includes("\\") ||
    filename.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe snapshot path: ${filename}`);
  }
  const prefix = config.root ? `${config.root}/` : "";
  if (!filename.startsWith(prefix)) return null;
  const relative = filename.slice(prefix.length);
  return !config.paths.length ||
    config.paths.some(
      (item) => relative === item || relative.startsWith(`${item}/`),
    )
    ? relative
    : null;
}

function copySnapshot(repository, sha, output, config) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid source commit");
  for (const entry of git(repository, ["ls-tree", "-rz", "--full-tree", sha])
    .split("\0")
    .filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, blob] = entry.slice(0, tab).split(" ");
    const relative = selectedPath(entry.slice(tab + 1), config);
    if (relative === null) continue;
    if (type !== "blob" || !["100644", "100755"].includes(mode))
      throw new Error(`Not a regular file: ${relative}`);
    const destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(
      destination,
      git(repository, ["cat-file", "blob", blob], null),
    );
  }
}

async function list(api, endpoint) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await api(
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

async function collectSources(api, repository) {
  const main = await api(`/repos/${repository}/git/ref/heads/main`);
  const pulls = await list(api, `/repos/${repository}/pulls?state=open`);
  return {
    main: main.object.sha,
    previews: pulls
      .filter((pull) => pull.head.repo?.full_name === repository)
      .map((pull) => ({ number: pull.number, sha: pull.head.sha })),
  };
}

function buildSite(repository, output, config, sources) {
  // Rebuild from current refs; closed previews disappear without a persistent publishing branch.
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  copySnapshot(repository, sources.main, output, config);
  for (const preview of sources.previews) {
    if (!Number.isSafeInteger(preview.number) || preview.number <= 0)
      throw new Error("Invalid pull request number");
    copySnapshot(
      repository,
      preview.sha,
      path.join(output, "pr-preview", String(preview.number)),
      config,
    );
  }
}

async function updateComment(api, repository, number, body, create) {
  const comments = await list(
    api,
    `/repos/${repository}/issues/${number}/comments`,
  );
  const existing = comments.find(
    (comment) =>
      comment.user.login === "github-actions[bot]" &&
      comment.body.includes(MARKER),
  );
  if (existing && existing.body !== body)
    await api(`/repos/${repository}/issues/comments/${existing.id}`, "PATCH", {
      body,
    });
  else if (!existing && create)
    await api(`/repos/${repository}/issues/${number}/comments`, "POST", {
      body,
    });
}

async function commentPreviews(api, repository, pageUrl, previews) {
  for (const preview of previews) {
    const url = new URL(
      `pr-preview/${preview.number}/`,
      `${pageUrl.replace(/\/$/, "")}/`,
    ).href;
    const body = `${MARKER}\n[View the deployed preview](${url})\n\nSource commit: [${preview.sha}](https://github.com/${repository}/commit/${preview.sha}).\n\nThis preview updates on new commits and is removed when the pull request closes.`;
    await updateComment(api, repository, preview.number, body, true);
  }
  // Reconcile every published comment: a newer queued event may replace a close event.
  const removed = `${MARKER}\nPreview removed after this pull request closed.`;
  const comments = await list(api, `/repos/${repository}/issues/comments`);
  for (const comment of comments) {
    if (
      comment.user.login !== "github-actions[bot]" ||
      !comment.body.includes(MARKER) ||
      comment.body === removed
    )
      continue;
    const number = Number(comment.issue_url.split("/").pop());
    if (previews.some((preview) => preview.number === number)) continue;
    const pull = await api(`/repos/${repository}/pulls/${number}`);
    if (pull.state === "closed" && pull.head.repo?.full_name === repository) {
      await api(`/repos/${repository}/issues/comments/${comment.id}`, "PATCH", {
        body: removed,
      });
    }
  }
}

async function api(endpoint, method = "GET", body) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`GitHub API ${method} ${endpoint}: ${response.status}`);
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (process.argv[2] === "build") {
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, "pages-preview.json"), "utf8"),
    );
    const sources = await collectSources(api, repository);
    const commits = [
      sources.main,
      ...sources.previews.map((preview) => preview.sha),
    ];
    if (!commits.every((sha) => /^[a-f0-9]{40}$/.test(sha)))
      throw new Error("Invalid source commit");
    git(process.cwd(), ["fetch", "--no-tags", "origin", ...new Set(commits)]);
    buildSite(process.cwd(), path.resolve("_site"), config, sources);
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `previews=${JSON.stringify(sources.previews)}\n`,
    );
    console.log(
      `Packaged main ${sources.main} and ${sources.previews.length} open pull requests.`,
    );
  } else if (process.argv[2] === "comment") {
    await commentPreviews(
      api,
      repository,
      process.env.PAGE_URL,
      JSON.parse(process.env.DEPLOYED_PREVIEWS),
    );
  } else throw new Error("Use build or comment");
}

module.exports = {
  MARKER,
  selectedPath,
  copySnapshot,
  collectSources,
  buildSite,
  commentPreviews,
};
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
